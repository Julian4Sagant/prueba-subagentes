#!/usr/bin/env node
// Prueba de punta a punta del schema y el instalador con la CLI real de OpenSpec.
//
// En una carpeta temporal:
//  1. openspec init --tools claude y el instalador, que tiene que listar lo pendiente;
//     con config.yaml y CLAUDE.md completos, no tiene que quedar nada pendiente.
//  2. openspec schema validate spec-driven-agentes.
//  3. Un change con el schema del proyecto: impacto es el primer artefacto y el proposal depende
//     de él; con los fixtures de pruebas/humo/change (sin design), valida en modo estricto y el
//     apply lee las tareas de los grupos "## Grupo N:".
//  4. Un baseline con spec-driven (proposal y specs): valida, se archiva y crea la spec principal.
//
// Requiere openspec en el PATH y PowerShell (pwsh, o powershell en Windows).
// Uso: node scripts/humo.js [--conservar]  (--conservar deja la carpeta temporal para mirarla)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const raiz = path.resolve(__dirname, '..');
const fixtures = path.join(raiz, 'pruebas', 'humo');
const conservar = process.argv.includes('--conservar');
const proyecto = fs.mkdtempSync(path.join(os.tmpdir(), 'humo-subagentes-'));

let pasos = 0;
function paso(descripcion, fn) {
	pasos++;
	try {
		fn();
		console.log(`ok ${pasos} - ${descripcion}`);
	}
	catch (e) {
		console.error(`FALLA ${pasos} - ${descripcion}\n${e.message}`);
		terminar(1);
	}
}

function terminar(codigo) {
	if (!conservar) {
		fs.rmSync(proyecto, { recursive: true, force: true });
	}
	else {
		console.log(`Proyecto temporal: ${proyecto}`);
	}
	process.exit(codigo);
}

/** Corre un comando en el proyecto temporal y devuelve su salida; si falla, la incluye en el error. */
function correr(comando) {
	try {
		return execSync(comando, { cwd: proyecto, encoding: 'utf8', stdio: 'pipe' });
	}
	catch (e) {
		throw new Error(`"${comando}" salió con ${e.status}:\n${e.stdout || ''}${e.stderr || ''}`);
	}
}

function json(comando) {
	return JSON.parse(correr(comando));
}

function powershell() {
	for (const exe of ['pwsh', 'powershell']) {
		if (spawnSync(exe, ['-NoProfile', '-Command', 'exit 0']).status === 0) {
			return exe;
		}
	}
	throw new Error('No hay PowerShell (pwsh ni powershell) para correr el instalador');
}

function instalar() {
	const r = spawnSync(powershell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(raiz, 'scripts', 'install.ps1'), '-Proyecto', proyecto], { encoding: 'utf8' });
	if (r.status !== 0) {
		throw new Error(`el instalador salió con ${r.status}:\n${r.stdout}${r.stderr}`);
	}
	return r.stdout;
}

function copiar(origen, destino) {
	fs.cpSync(origen, destino, { recursive: true });
}

function igual(real, esperado, que) {
	if (JSON.stringify(real) !== JSON.stringify(esperado)) {
		throw new Error(`${que}: se esperaba ${JSON.stringify(esperado)} y es ${JSON.stringify(real)}`);
	}
}

function artefactos(change) {
	return Object.fromEntries(json(`openspec status --change "${change}" --json`).artifacts.map(a => [a.id, a]));
}

paso('openspec init --tools claude', () => {
	correr('openspec init --tools claude --no-animation .');
	if (!fs.existsSync(path.join(proyecto, '.claude', 'skills', 'openspec-propose', 'SKILL.md'))) {
		throw new Error('no se generaron las skills de Claude');
	}
});

paso('el instalador copia todo y lista lo pendiente', () => {
	const salida = instalar();
	for (const archivo of ['.claude/agents/explorador.md', '.claude/hooks/sin-escritura.js', 'openspec/schemas/spec-driven-agentes/schema.yaml', 'ORQUESTACION.md', 'CARRILES.md']) {
		if (!fs.existsSync(path.join(proyecto, archivo))) {
			throw new Error(`no copió ${archivo}`);
		}
	}
	if (!/schema: spec-driven-agentes/.test(salida) || !/CLAUDE\.md no menciona/.test(salida)) {
		throw new Error(`no listó lo pendiente:\n${salida}`);
	}
});

paso('con config.yaml y CLAUDE.md completos no queda nada pendiente', () => {
	const config = path.join(proyecto, 'openspec', 'config.yaml');
	const texto = fs.readFileSync(config, 'utf8');
	fs.writeFileSync(config, /^schema:/m.test(texto) ? texto.replace(/^schema:.*$/m, 'schema: spec-driven-agentes') : `schema: spec-driven-agentes\n${texto}`);
	fs.writeFileSync(path.join(proyecto, 'CLAUDE.md'), 'Para todo pedido nuevo, seguí ORQUESTACION.md.\n');
	const salida = instalar();
	if (/Pendiente/.test(salida)) {
		throw new Error(`quedó algo pendiente:\n${salida}`);
	}
});

paso('openspec schema validate spec-driven-agentes', () => {
	correr('openspec schema validate spec-driven-agentes');
});

paso('un change nuevo arranca por impacto, y el proposal depende de él', () => {
	correr('openspec new change humo');
	const a = artefactos('humo');
	igual(Object.keys(a), ['impacto', 'proposal', 'specs', 'design', 'tasks'], 'artefactos');
	igual(a.impacto.status, 'ready', 'impacto');
	igual(a.proposal.requires, ['impacto'], 'proposal.requires');
	igual(a.design.requires, ['proposal', 'specs'], 'design.requires');
});

paso('con impacto, proposal, specs y tasks (sin design) valida en modo estricto', () => {
	copiar(path.join(fixtures, 'change'), path.join(proyecto, 'openspec', 'changes', 'humo'));
	const a = artefactos('humo');
	for (const id of ['impacto', 'proposal', 'specs', 'tasks']) {
		igual(a[id].status, 'done', id);
	}
	correr('openspec validate humo --strict');
});

paso('el apply lee las tareas de los grupos "## Grupo N:"', () => {
	const apply = json('openspec instructions apply --change humo --json');
	igual(apply.state, 'ready', 'state');
	igual(apply.progress, { total: 3, complete: 1, remaining: 2 }, 'progress');
});

paso('un baseline con spec-driven valida, se archiva y crea la spec principal', () => {
	correr('openspec new change baseline-humo --schema spec-driven');
	copiar(path.join(fixtures, 'baseline'), path.join(proyecto, 'openspec', 'changes', 'baseline-humo'));
	correr('openspec validate baseline-humo --strict');
	correr('openspec archive baseline-humo --yes');
	const spec = path.join(proyecto, 'openspec', 'specs', 'humo-base', 'spec.md');
	if (!fs.existsSync(spec) || !/<!-- a-revisar:/.test(fs.readFileSync(spec, 'utf8'))) {
		throw new Error('no creó openspec/specs/humo-base/spec.md con la marca a-revisar');
	}
});

console.log(`OK: ${pasos} pasos con OpenSpec ${correr('openspec --version').trim()}.`);
terminar(0);
