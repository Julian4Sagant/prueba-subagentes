// Tests de orquestador/Orquestador.java con un Claude Code falso (pruebas/orquestador/claude-falso.js).
// Necesita Java 17 o más en el PATH. Uso: node --test scripts/test-orquestador.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

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
	return { proyecto, bandeja, correr, escribir, estado, llamadas, hay };
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
	assert.strictEqual(ll.args[ll.args.indexOf('--model') + 1], 'sonnet', 'el orquestador corre en Sonnet por defecto');
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
	// total_cost_usd viene acumulado (0.5, 1.0, 1.5): e.costo guarda el acumulado de la sesión,
	// no la suma de los tres (que daría 3.0, el bug viejo).
	assert.strictEqual(e.costo, '1.5000');
	assert.ok(t.hay('gates', 'p1-3.md'));
	const gate = fs.readFileSync(path.join(t.bandeja, 'gates', 'p1-3.md'), 'utf8');
	assert.match(gate, /US\$ 0\.50 \(acumulado US\$ 1\.50\)/, 'el gate muestra el costo de la corrida y el acumulado');
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

// --- Fuente webhook (HTTP) --------------------------------------------------

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Reintenta conectar al puerto hasta que el servidor esté arriba. */
async function esperarPuerto(puerto, msMax) {
	const hasta = Date.now() + msMax;
	while (Date.now() < hasta) {
		const ok = await new Promise((res) => {
			const s = net.connect(puerto, '127.0.0.1');
			s.on('connect', () => { s.destroy(); res(true); });
			s.on('error', () => res(false));
		});
		if (ok) return;
		await esperar(200);
	}
	throw new Error('el webhook no abrió el puerto ' + puerto);
}

async function esperarArchivo(ruta, msMax) {
	const hasta = Date.now() + msMax;
	while (Date.now() < hasta) {
		if (fs.existsSync(ruta)) return;
		await esperar(300);
	}
	throw new Error('no apareció ' + ruta);
}

function post(puerto, ruta, cuerpo, headers = {}) {
	return new Promise((res, rej) => {
		const req = http.request({ host: '127.0.0.1', port: puerto, path: ruta, method: 'POST',
			headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } }, (r) => {
			let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ codigo: r.statusCode, cuerpo: b }));
		});
		req.on('error', rej);
		req.end(Buffer.from(cuerpo, 'utf8'));
	});
}

test('un POST al webhook deja el pedido en la bandeja y el flujo lo procesa', async () => {
	const t = armar();
	const puerto = 18737;
	const proc = spawn('java', [JAVA, '--proyecto', t.proyecto, '--bandeja', t.bandeja,
		'--claude', `node ${FALSO}`, '--http', String(puerto)], { stdio: 'ignore' });
	try {
		await esperarPuerto(puerto, 20000);

		// Pedido con id en el header, como lo mandaría un webhook.
		const r = await post(puerto, '/pedido', 'autor: Ana\nUn pedido por webhook.\n', { 'X-Pedido-Id': 'WH-1' });
		assert.strictEqual(r.codigo, 202);
		await esperarArchivo(path.join(t.bandeja, 'gates', 'wh-1-1.md'), 25000);
		assert.strictEqual(t.estado('wh-1').espera, 'APROBAR_SPEC');
		const ll = t.llamadas().at(-1);
		assert.strictEqual(ll.prompt, '/pedido Un pedido por webhook.');

		// El mismo id otra vez: 409.
		const dup = await post(puerto, '/pedido', 'otra vez\n', { 'X-Pedido-Id': 'WH-1' });
		assert.strictEqual(dup.codigo, 409);

		// Una decisión por el webhook retoma la sesión.
		const d = await post(puerto, '/decision', 'pedido: WH-1\ngate: APROBAR_SPEC\ndecision: aprobada\n');
		assert.strictEqual(d.codigo, 202);
		await esperarArchivo(path.join(t.bandeja, 'gates', 'wh-1-2.md'), 25000);
		assert.strictEqual(t.estado('wh-1').espera, 'NADA');
	} finally {
		proc.kill();
	}
});
