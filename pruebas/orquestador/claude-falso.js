#!/usr/bin/env node
// Claude Code falso para probar Orquestador.java sin gastar: lee el prompt de stdin, anota la
// llamada en llamadas.jsonl (en el directorio del proyecto) y responde como `claude -p
// --output-format json`, con un bloque de estado según el prompt.
const fs = require('fs');

const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync('llamadas.jsonl', JSON.stringify({ args, prompt }) + '\n');

// total_cost_usd viene ACUMULADO de la sesión: cada corrida devuelve 0.5 más que la anterior.
// Así el test distingue la cuenta correcta (acumulado) de la vieja que sumaba (triplicaba).
const nLlamadas = fs.readFileSync('llamadas.jsonl', 'utf8').trim().split('\n').length;

const i = args.indexOf('--resume');
const sesion = i >= 0 ? args[i + 1] : 'sesion-falsa-1';

let espera = 'APROBAR_SPEC';
if (prompt.includes('aprobada')) espera = 'NADA';
if (prompt.includes('rechazada:')) espera = 'APROBAR_SPEC';

const bloque = { orquestador: 'estado', change: 'cambio-falso', carril: 'ESTANDAR', espera, motivo: 'Respuesta falsa.' };
let texto = `Gate falso para: ${prompt.split('\n')[0]}\n\n` +
	'```json\n{"agente":"spec-writer","resultado":"OK"}\n```\n\n' +
	'```json\n' + JSON.stringify(bloque) + '\n```\n';
if (prompt.includes('SIN-BLOQUE')) texto = 'Me olvidé del bloque.';

const salida = {
	type: 'result',
	subtype: 'success',
	is_error: false,
	session_id: sesion,
	total_cost_usd: 0.5 * nLlamadas,
	result: texto,
	permission_denials: prompt.includes('NEGAR') ? [{ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }] : [],
};
process.stdout.write(JSON.stringify(salida));
