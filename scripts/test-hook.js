// Tests de hooks/sin-escritura.js. Uso: node --test scripts/
//
// El hook recibe por stdin el JSON de PreToolUse. Si bloquea, escribe un JSON con
// permissionDecision "deny"; si deja pasar, no escribe nada. Siempre sale con 0.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const HOOK = path.join(__dirname, '..', 'hooks', 'sin-escritura.js');

function correr(entrada, ...args) {
	const r = spawnSync(process.execPath, [HOOK, ...args], { input: JSON.stringify(entrada), encoding: 'utf8' });
	assert.strictEqual(r.status, 0, `el hook salió con ${r.status}: ${r.stderr}`);
	return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

function bash(comando, ...args) {
	return correr({ tool_name: 'Bash', tool_input: { command: comando }, cwd: os.tmpdir() }, ...args);
}

const GIT_BLOQUEADO = [
	'git commit -m "x"',
	'git push origin main',
	'git reset --hard HEAD',
	'git checkout main',
	'git switch -c otra',
	'git stash',
	'git add .',
	'git merge otra',
	'git rebase main',
	'git restore archivo.txt',
	'cd repo && git commit -am x',
];

const PERMITIDO = [
	'openspec status --change "x" --json',
	'openspec validate x --strict',
	'git status',
	'git diff --no-index a b',
	'git log --oneline -5',
	'./mvnw -B -q test',
	'ls -la',
];

for (const comando of GIT_BLOQUEADO) {
	test(`bloquea: ${comando}`, () => {
		const salida = bash(comando);
		assert.ok(salida, 'no bloqueó');
		assert.strictEqual(salida.permissionDecision, 'deny');
		assert.match(salida.permissionDecisionReason, /git/);
	});
}

for (const comando of PERMITIDO) {
	test(`deja pasar: ${comando}`, () => {
		assert.strictEqual(bash(comando), null);
	});
}

test('sin --solo-lectura deja escribir con la shell', () => {
	assert.strictEqual(bash('mkdir -p salida && echo hola > salida/a.txt'), null);
});

test('con --solo-lectura bloquea escribir con la shell', () => {
	assert.strictEqual(bash('rm -rf salida', '--solo-lectura').permissionDecision, 'deny');
	assert.strictEqual(bash('echo hola > a.txt', '--solo-lectura').permissionDecision, 'deny');
});

test('con --permitir-commit deja pasar git add y git commit', () => {
	assert.strictEqual(bash('git add .', '--permitir-commit'), null);
	assert.strictEqual(bash('git commit -m "x"', '--permitir-commit'), null);
	assert.strictEqual(bash('cd repo && git commit -am x', '--permitir-commit'), null);
});

test('con --permitir-commit sigue bloqueando lo que integra o reescribe', () => {
	for (const comando of ['git push origin main', 'git reset --hard HEAD', 'git checkout main', 'git switch -c otra', 'git rebase main', 'git merge otra', 'git restore archivo.txt', 'git rm archivo.txt', 'git clean -fd']) {
		const salida = bash(comando, '--permitir-commit');
		assert.ok(salida, `no bloqueó: ${comando}`);
		assert.strictEqual(salida.permissionDecision, 'deny');
	}
});

test('ignora las herramientas que no son Bash', () => {
	assert.strictEqual(correr({ tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'git commit' } }), null);
});

test('una entrada vacía o rota no bloquea ni rompe', () => {
	const r = spawnSync(process.execPath, [HOOK], { input: 'no es json', encoding: 'utf8' });
	assert.strictEqual(r.status, 0);
	assert.strictEqual(r.stdout.trim(), '');
});
