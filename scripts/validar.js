#!/usr/bin/env node
// Valida los agentes y el schema del repo. Sale con 0 si está todo bien y con 1 si hay problemas.
//
// Agentes: frontmatter (name igual al archivo, description, model, tools), skills openspec-*,
// hook sin-escritura.js existente, y bloques JSON de ejemplo que parsean con exactamente los
// campos que el orquestador chequea.
// Los campos no están escritos acá: salen de la tabla "Campos obligatorios" de ORQUESTACION.md
// (planificación) y de APLICACION.md (apply), y las señales, de la tabla de CARRILES.md. Así
// cada dato tiene un solo dueño, y este script comprueba que los ejemplos de los agentes coincidan.
// Schema: schema.yaml con el artefacto impacto primero y cada template referenciado presente.

const fs = require('fs');
const path = require('path');

const raiz = path.resolve(__dirname, '..');
const MODELOS = ['haiku', 'sonnet', 'opus'];
// Resultados que puede devolver cada agente; los que no están en la lista devuelven OK o BLOQUEADO.
const RESULTADOS_PROPIOS = { 'explorador': ['YA_CUMPLE'], 'arquitecto': ['HUECO_EN_SPEC'], 'planner': ['HUECO_EN_DISENO'], 'implementador': ['TEST_CUESTIONADO'] };
const resultadosDe = agente => ['OK', 'BLOQUEADO', ...(RESULTADOS_PROPIOS[agente] || [])];

const problemas = [];

function leer(rel) {
	const archivo = path.join(raiz, rel);
	return fs.existsSync(archivo) ? fs.readFileSync(archivo, 'utf8').replace(/\r\n/g, '\n') : null;
}

/**
 * Lee la tabla "| Agente | Campos obligatorios |" de un guion. Devuelve { <agente>: [...] }
 * con los nombres entre backticks de cada fila, sin lo que está entre paréntesis (por
 * ejemplo, "(con `OK`)" es una aclaración, no un campo). {} si el guion no tiene la tabla.
 */
function camposDeTabla(rel) {
	const texto = leer(rel);
	if (!texto) {
		return {};
	}
	const inicio = texto.indexOf('| Agente | Campos obligatorios |');
	if (inicio < 0) {
		return {};
	}
	const campos = {};
	for (const linea of texto.slice(inicio).split('\n').slice(2)) {
		const fila = /^\s*\|\s*([\w-]+)\s*\|(.*)\|\s*$/.exec(linea);
		if (!fila) {
			break;
		}
		campos[fila[1]] = [...fila[2].replace(/\([^)]*\)/g, '').matchAll(/`(\w+)`/g)].map(m => m[1]);
	}
	return campos;
}

/**
 * Los campos salen de los dos guiones: ORQUESTACION.md (planificación) y APLICACION.md
 * (apply). Cada agente tiene su fila en el guion de su tramo; la fila "todos" (campos
 * comunes) la define ORQUESTACION.md.
 */
function camposObligatorios() {
	const orq = camposDeTabla('ORQUESTACION.md');
	if (Object.keys(orq).length === 0) {
		problemas.push('ORQUESTACION.md: no tiene la tabla "| Agente | Campos obligatorios |"');
	}
	const campos = { ...orq, ...camposDeTabla('APLICACION.md') };
	if (!campos.todos) {
		problemas.push('ORQUESTACION.md: la tabla de campos no tiene la fila "todos"');
	}
	return campos;
}

/** Las señales de la tabla de CARRILES.md: las filas que empiezan con un nombre entre backticks. */
function senalesDeCarriles() {
	const texto = leer('CARRILES.md');
	return texto ? [...texto.matchAll(/^\| `(\w+)` \|/gm)].map(m => m[1]) : [];
}

const CAMPOS = camposObligatorios();
const COMUNES = CAMPOS.todos || [];
const SENALES = senalesDeCarriles();

function campo(fm, nombre) {
	const m = new RegExp(`^${nombre}:[ \\t]*(.+)$`, 'm').exec(fm);
	return m ? m[1].trim() : null;
}

function validarAgente(archivo) {
	const rel = path.relative(raiz, archivo).replace(/\\/g, '/');
	const base = path.basename(archivo, '.md');
	const texto = fs.readFileSync(archivo, 'utf8').replace(/\r\n/g, '\n');
	const m = /^---\n([\s\S]*?)\n---\n/.exec(texto);
	if (!m) {
		problemas.push(`${rel}: sin frontmatter`);
		return;
	}
	const fm = m[1];
	if (campo(fm, 'name') !== base) {
		problemas.push(`${rel}: name "${campo(fm, 'name')}" no coincide con el archivo`);
	}
	if (!campo(fm, 'description')) {
		problemas.push(`${rel}: falta description`);
	}
	if (!MODELOS.includes(campo(fm, 'model'))) {
		problemas.push(`${rel}: model "${campo(fm, 'model')}" no es uno de ${MODELOS.join(', ')}`);
	}
	if (!campo(fm, 'tools')) {
		problemas.push(`${rel}: falta tools`);
	}
	const skills = [...fm.matchAll(/^[ \t]+-[ \t]+(openspec-[\w-]+)[ \t]*$/gm)].map(s => s[1]);
	if (skills.length === 0) {
		problemas.push(`${rel}: no precarga ninguna skill openspec-*`);
	}
	for (const hook of fm.matchAll(/\.claude\/hooks\/([\w.-]+\.js)/g)) {
		if (!fs.existsSync(path.join(raiz, 'hooks', hook[1]))) {
			problemas.push(`${rel}: el hook ${hook[1]} no está en hooks/`);
		}
	}
	if (!fm.includes('sin-escritura.js')) {
		problemas.push(`${rel}: no declara el hook sin-escritura.js`);
	}

	const requeridos = CAMPOS[base];
	if (!requeridos) {
		problemas.push(`${rel}: ni ORQUESTACION.md ni APLICACION.md tienen una fila para este agente en "Campos obligatorios"`);
		return;
	}
	const bloques = [...texto.matchAll(/```json\n([\s\S]*?)\n```/g)];
	if (bloques.length === 0) {
		problemas.push(`${rel}: sin bloque JSON de ejemplo`);
	}
	bloques.forEach((b, i) => {
		let json;
		try {
			json = JSON.parse(b[1]);
		}
		catch (e) {
			problemas.push(`${rel}: el JSON de ejemplo ${i + 1} no parsea (${e.message})`);
			return;
		}
		const esperados = [...COMUNES, ...requeridos];
		for (const c of esperados) {
			if (!(c in json)) {
				problemas.push(`${rel}: al JSON de ejemplo ${i + 1} le falta "${c}", que ORQUESTACION.md exige`);
			}
		}
		for (const c of Object.keys(json)) {
			if (!esperados.includes(c)) {
				problemas.push(`${rel}: el JSON de ejemplo ${i + 1} trae "${c}", que no está en la tabla de campos de ORQUESTACION.md`);
			}
		}
		if (json.agente !== base) {
			problemas.push(`${rel}: el JSON de ejemplo ${i + 1} dice agente "${json.agente}"`);
		}
		if (!resultadosDe(base).includes(json.resultado)) {
			problemas.push(`${rel}: resultado "${json.resultado}" no es uno de ${resultadosDe(base).join(', ')}`);
		}
		if (json.senales) {
			const claves = Object.keys(json.senales).sort().join();
			if (claves !== [...SENALES].sort().join()) {
				problemas.push(`${rel}: senales no tiene exactamente las ${SENALES.length} señales de CARRILES.md`);
			}
		}
	});
}

function validarSchema(carpeta) {
	const rel = path.relative(raiz, carpeta).replace(/\\/g, '/');
	const archivo = path.join(carpeta, 'schema.yaml');
	if (!fs.existsSync(archivo)) {
		problemas.push(`${rel}: falta schema.yaml`);
		return;
	}
	const texto = fs.readFileSync(archivo, 'utf8').replace(/\r\n/g, '\n');
	if (campo(texto, 'name') !== path.basename(carpeta)) {
		problemas.push(`${rel}: name no coincide con la carpeta`);
	}
	const ids = [...texto.matchAll(/^  - id: ([\w-]+)$/gm)].map(m => m[1]);
	if (ids[0] !== 'impacto') {
		problemas.push(`${rel}: el primer artefacto es "${ids[0]}", se esperaba "impacto"`);
	}
	for (const id of ['proposal', 'specs', 'design', 'tasks']) {
		if (!ids.includes(id)) {
			problemas.push(`${rel}: falta el artefacto ${id}`);
		}
	}
	for (const t of texto.matchAll(/^    template: ([\w.-]+)$/gm)) {
		if (!fs.existsSync(path.join(carpeta, 'templates', t[1]))) {
			problemas.push(`${rel}: falta templates/${t[1]}`);
		}
	}
}

// CARRILES.md es la única definición de señales y carriles: tiene que traer la tabla de señales y
// los 4 carriles, y el explorador y el orquestador tienen que citarlo en vez de repetir la tabla.
// Que la tabla tenga las señales correctas lo comprueba el JSON de ejemplo del explorador.
function validarCarriles() {
	const texto = leer('CARRILES.md');
	if (!texto) {
		problemas.push('CARRILES.md: falta');
		return;
	}
	if (SENALES.length === 0) {
		problemas.push('CARRILES.md: no tiene la tabla de señales (filas "| `señal` | ... |")');
	}
	for (const c of ['RAPIDO', 'ESTANDAR', 'COMPLETO', 'LEGACY']) {
		if (!texto.includes(`**${c}**`)) {
			problemas.push(`CARRILES.md: falta el carril ${c}`);
		}
	}
	for (const rel of ['agents/explorador.md', 'agents/arquitecto.md', 'ORQUESTACION.md']) {
		const otro = fs.readFileSync(path.join(raiz, rel), 'utf8');
		if (!otro.includes('CARRILES.md')) {
			problemas.push(`${rel}: no cita CARRILES.md`);
		}
		if (SENALES.some(s => otro.includes(`| \`${s}\` |`))) {
			problemas.push(`${rel}: repite la tabla de señales; tiene que citar CARRILES.md`);
		}
	}
}

// Cada comando tiene description en el frontmatter y usa $ARGUMENTS; /pedido además manda a
// seguir ORQUESTACION.md, que es para lo que existe.
function validarComandos() {
	const carpeta = path.join(raiz, 'commands');
	const comandos = fs.existsSync(carpeta) ? fs.readdirSync(carpeta).filter(f => f.endsWith('.md')) : [];
	if (!comandos.includes('pedido.md')) {
		problemas.push('commands/pedido.md: falta');
	}
	for (const archivo of comandos) {
		const texto = leer(`commands/${archivo}`);
		const fm = /^---\n([\s\S]*?)\n---\n/.exec(texto);
		if (!fm || !campo(fm[1], 'description')) {
			problemas.push(`commands/${archivo}: falta description en el frontmatter`);
		}
		if (!texto.includes('$ARGUMENTS')) {
			problemas.push(`commands/${archivo}: no usa $ARGUMENTS`);
		}
	}
	if (comandos.includes('pedido.md') && !leer('commands/pedido.md').includes('ORQUESTACION.md')) {
		problemas.push('commands/pedido.md: no manda a seguir ORQUESTACION.md');
	}
}

const carpetaAgentes = path.join(raiz, 'agents');
const agentes = fs.readdirSync(carpetaAgentes).filter(f => f.endsWith('.md'));
agentes.forEach(f => validarAgente(path.join(carpetaAgentes, f)));
for (const nombre of Object.keys(CAMPOS).filter(n => n !== 'todos')) {
	if (!agentes.includes(`${nombre}.md`)) {
		problemas.push(`agents/${nombre}.md: ORQUESTACION.md le define campos, pero el agente no existe`);
	}
}
const carpetaSchemas = path.join(raiz, 'schemas');
const schemas = fs.readdirSync(carpetaSchemas);
schemas.forEach(s => validarSchema(path.join(carpetaSchemas, s)));
if (!fs.existsSync(path.join(raiz, 'ORQUESTACION.md'))) {
	problemas.push('ORQUESTACION.md: falta');
}
validarCarriles();
validarComandos();

if (problemas.length) {
	console.error(problemas.map(p => `- ${p}`).join('\n'));
	process.exit(1);
}
console.log(`OK: ${agentes.length} agentes y ${schemas.length} schema(s) válidos.`);
