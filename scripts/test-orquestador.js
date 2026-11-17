// Tests de orquestador/Orquestador.java con un Claude Code falso (pruebas/orquestador/claude-falso.js).
// Necesita Java 17 o más en el PATH. Uso: node --test scripts/test-orquestador.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const JAVA = path.join(RAIZ, 'orquestador', 'Orquestador.java');
const FALSO = path.join(RAIZ, 'pruebas', 'orquestador', 'claude-falso.js');

function armar() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-'));
	const proyecto = path.join(tmp, 'proyecto');
	const bandeja = path.join(tmp, 'bandeja');
	fs.mkdirSync(path.join(proyecto, '.claude', 'commands'), { recursive: true });
	for (const f of ['ORQUESTACION.md', 'CARRILES.md']) fs.writeFileSync(path.join(proyecto, f), '# x\n');
	fs.writeFileSync(path.join(proyecto, '.claude', 'commands', 'pedido.md'), '$ARGUMENTS\n');
	const correr = () => execFileSync('java', [JAVA, '--proyecto', proyecto, '--bandeja', bandeja,
		'--claude', `node ${FALSO}`], { encoding: 'utf8' });
	const escribir = (carpeta, nombre, texto) => {
		fs.mkdirSync(path.join(bandeja, carpeta), { recursive: true });
		fs.writeFileSync(path.join(bandeja, carpeta, nombre), texto);
	};
	const estado = (id) => {
		const props = {};
		for (const l of fs.readFileSync(path.join(bandeja, 'estado', id + '.properties'), 'utf8').split(/\r?\n/)) {
			const m = l.match(/^([^#=]+)=(.*)$/);
			if (m) props[m[1]] = m[2];
		}
		return props;
	};
	const llamadas = () => fs.readFileSync(path.join(proyecto, 'llamadas.jsonl'), 'utf8')
		.trim().split('\n').map((l) => JSON.parse(l));
	const hay = (carpeta, nombre) => fs.existsSync(path.join(bandeja, carpeta, nombre));
	return { bandeja, correr, escribir, estado, llamadas, hay };
}

test('un pedido corre /pedido y queda esperando el gate que dice el bloque de estado', () => {
	const t = armar();
	t.escribir('entrada', 'FAC-12.txt', 'autor: Ana\nQue facturar a un cliente inexistente\ndevuelva un error.\n');
	t.correr();
	const e = t.estado('fac-12');
	assert.strictEqual(e.espera, 'APROBAR_SPEC');
	assert.strictEqual(e.sesion, 'sesion-falsa-1');
	assert.strictEqual(e.change, 'cambio-falso');
	const [ll] = t.llamadas();
	assert.strictEqual(ll.prompt, '/pedido Que facturar a un cliente inexistente\ndevuelva un error.');
	assert.ok(ll.args.includes('--settings') && ll.args.includes('-p') && !ll.args.includes('--resume'));
	assert.ok(t.hay('gates', 'fac-12-1.md') && t.hay('procesados', 'FAC-12.txt'));
	const gate = fs.readFileSync(path.join(t.bandeja, 'gates', 'fac-12-1.md'), 'utf8');
	assert.match(gate, /gate: APROBAR_SPEC/);
});

test('las decisiones retoman la misma sesión y se descartan las que no corresponden', () => {
	const t = armar();
	t.escribir('entrada', 'p1.txt', 'Un pedido.\n');
	t.correr();

	t.escribir('decisiones', 'a.txt', 'pedido: p1\ngate: APROBAR_SPEC\ndecision: rechazada\n');
	t.escribir('decisiones', 'b.txt', 'pedido: p1\ngate: APROBAR_DISENO\ndecision: aprobada\n');
	t.escribir('decisiones', 'c.txt', 'pedido: otro\ngate: APROBAR_SPEC\ndecision: aprobada\n');
	t.correr();
	assert.ok(t.hay('descartados', 'a.txt'), 'rechazo sin comentario');
	assert.ok(t.hay('descartados', 'b.txt'), 'gate equivocado');
	assert.ok(t.hay('descartados', 'c.txt'), 'pedido desconocido');
	assert.strictEqual(t.llamadas().length, 1);

	t.escribir('decisiones', 'd.txt', 'pedido: p1\ngate: APROBAR_SPEC\ndecision: rechazada\nFaltan los bordes\nnuméricos.\n');
	t.correr();
	let ll = t.llamadas().at(-1);
	assert.strictEqual(ll.prompt, 'Decisión del gate APROBAR_SPEC: rechazada: Faltan los bordes\nnuméricos.');
	assert.strictEqual(ll.args[ll.args.indexOf('--resume') + 1], 'sesion-falsa-1');
	assert.strictEqual(t.estado('p1').espera, 'APROBAR_SPEC');

	t.escribir('decisiones', 'e.txt', 'pedido: p1\ngate: APROBAR_SPEC\ndecision: aprobada\n');
	t.correr();
	const e = t.estado('p1');
	assert.strictEqual(e.espera, 'NADA');
	assert.strictEqual(e.corridas, '3');
	assert.strictEqual(e.costo, '1.5000');
	assert.ok(t.hay('gates', 'p1-3.md'));
});

test('un pedido repetido se descarta', () => {
	const t = armar();
	t.escribir('entrada', 'p1.txt', 'Un pedido.\n');
	t.correr();
	t.escribir('entrada', 'p1.txt', 'Otra vez.\n');
	t.correr();
	assert.ok(t.hay('descartados', 'p1.txt'));
	assert.strictEqual(t.llamadas().length, 1);
});

test('sin bloque de estado queda ESCALADA y se responde con "respuesta"', () => {
	const t = armar();
	t.escribir('entrada', 'p2.txt', 'SIN-BLOQUE\n');
	t.correr();
	assert.strictEqual(t.estado('p2').espera, 'ESCALADA');
	t.escribir('decisiones', 'r.txt', 'pedido: p2\ngate: ESCALADA\ndecision: respuesta\nCerrá con el bloque.\n');
	t.correr();
	assert.strictEqual(t.llamadas().at(-1).prompt, 'Decisión del gate ESCALADA: Cerrá con el bloque.');
	assert.strictEqual(t.estado('p2').espera, 'APROBAR_SPEC');
});

test('los permisos negados quedan en el gate', () => {
	const t = armar();
	t.escribir('entrada', 'p3.txt', 'NEGAR algo\n');
	t.correr();
	const gate = fs.readFileSync(path.join(t.bandeja, 'gates', 'p3-1.md'), 'utf8');
	assert.match(gate, /Permisos negados/);
	assert.match(gate, /rm -rf x/);
});
