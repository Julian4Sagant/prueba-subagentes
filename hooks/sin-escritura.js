#!/usr/bin/env node
// Guarda de escritura para los subagentes que no deben cambiar el repo. Hook PreToolUse de Bash.
//
// Por defecto bloquea los comandos de git que cambian el estado (commit, push, reset, stash, checkout...):
// en el tramo de planificación integrar y commitear es del orquestador, y la persona revisa el diff.
// Con --solo-lectura, además bloquea escribir o borrar archivos con comandos de shell y con
// redirecciones dentro del proyecto.
// Con --permitir-commit (tramo de apply), deja pasar `git add` y `git commit` —para que el agente
// registre su trabajo con el trailer Agente:— pero sigue bloqueando lo que integra o reescribe el
// repo (push, reset, rebase, checkout, merge, clean...). El alcance por agente lo controla el CI
// (check-agent-scope.py), no este hook.
//
// Se declara en el frontmatter del agente, así que solo corre mientras trabaja ese agente.
//
// Es una barrera contra escrituras accidentales o por atajo, no un límite de seguridad: un comando
// armado en partes o un script que escriba por su cuenta puede esquivarla. La garantía fuerte es no
// darle al agente herramientas de escritura (sin Write ni Edit).

const fs = require('fs');
const path = require('path');

function leerEntrada() {
	try {
		return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
	}
	catch {
		return {};
	}
}

const GIT_SUBCOMANDOS = ['commit', 'push', 'reset', 'stash', 'checkout', 'switch', 'merge', 'rebase', 'add', 'tag', 'restore', 'clean', 'rm', 'mv', 'cherry-pick', 'revert', 'am', 'apply', 'pull'];
// Con --permitir-commit, el agente puede registrar su trabajo (git add / git commit) pero no
// integrar ni reescribir el repo (push, reset, rebase, checkout...). Es el modo del tramo de apply.
const GIT_PERMITIDOS_AL_COMMITEAR = ['commit', 'add'];
const COMANDOS_QUE_ESCRIBEN = /(^|[;&|(\s])(tee|cp|mv|rm|mkdir|touch|chmod|chown)\b|\bsed\s+-i/;
const REDIRECCION = /(^|[^0-9&])>{1,2}\s*("[^"]*"|'[^']*'|[^\s;&|)]+)/g;

function regexGitQueCambia(permitirCommit) {
	const bloqueados = GIT_SUBCOMANDOS.filter((c) => !(permitirCommit && GIT_PERMITIDOS_AL_COMMITEAR.includes(c)));
	return new RegExp(`\\bgit\\s+(${bloqueados.join('|')})\\b`);
}

/** Verdadero si `destino` cae dentro de `base` (la raíz del proyecto). */
function dentroDe(destino, base) {
	const relativo = path.relative(base, destino);
	return relativo !== '' && !relativo.startsWith('..') && !path.isAbsolute(relativo);
}

function motivoDeBloqueo(comando, cwd, soloLectura, permitirCommit) {
	if (regexGitQueCambia(permitirCommit).test(comando)) {
		return permitirCommit
			? 'integrar o reescribir el repo con git (push, reset, rebase, checkout y similares); git add y git commit sí están permitidos'
			: 'cambiar el repo con git (commit, push, reset, stash, checkout y similares)';
	}
	if (!soloLectura) {
		return null;
	}
	if (COMANDOS_QUE_ESCRIBEN.test(comando)) {
		return 'escribir o borrar archivos con un comando de shell';
	}
	const base = path.resolve(cwd || process.cwd());
	for (const [, , destinoCrudo] of comando.matchAll(REDIRECCION)) {
		const destino = path.resolve(base, destinoCrudo.replace(/^["']|["']$/g, ''));
		if (dentroDe(destino, base)) {
			return 'escribir dentro del proyecto con una redirección';
		}
	}
	return null;
}

const entrada = leerEntrada();
const soloLectura = process.argv.includes('--solo-lectura');
const permitirCommit = process.argv.includes('--permitir-commit');
const comando = entrada.tool_name === 'Bash' ? String((entrada.tool_input || {}).command || '') : '';
const motivo = comando ? motivoDeBloqueo(comando, entrada.cwd, soloLectura, permitirCommit) : null;
if (motivo) {
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: `Este agente no puede ${motivo}. Reportá lo que necesitás al orquestador en vez de hacerlo.`,
		},
	}));
}
process.exit(0);
