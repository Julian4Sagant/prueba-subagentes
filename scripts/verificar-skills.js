#!/usr/bin/env node
// Comprueba que las skills oficiales de OpenSpec sigan diciendo lo que los agentes asumen.
//
// Los agentes adaptan pasos concretos de las skills ("Paso 6", "Pasos 2, 3 y 5") y citan
// secciones por su título ("Check for context"). Si una versión nueva de OpenSpec renumera un
// paso o renombra una sección, el agente sigue una instrucción que ya no existe y nada falla.
//
// scripts/skills-referenciadas.json guarda, para cada skill, el título de cada paso y sección
// citados, tal como estaban cuando se escribieron los prompts.
//
// Uso:
//   node scripts/verificar-skills.js
//       Sin CLI: cada paso y sección que citan los agentes tiene que estar en el archivo de
//       referencias. Detecta una cita nueva que nadie registró.
//   node scripts/verificar-skills.js --openspec
//       Además genera las skills con la CLI instalada (openspec init --tools claude en una
//       carpeta temporal) y compara cada referencia con la skill real.
//   node scripts/verificar-skills.js --openspec --actualizar
//       Reescribe el archivo de referencias con los títulos de la skill real. Usalo solo después
//       de revisar que los prompts siguen teniendo sentido con la versión nueva.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const raiz = path.resolve(__dirname, '..');
const archivoReferencias = path.join(__dirname, 'skills-referenciadas.json');
const args = process.argv.slice(2);
const conOpenspec = args.includes('--openspec');
const actualizar = args.includes('--actualizar');

const problemas = [];

/** Normaliza espacios y saltos de línea para buscar citas que cruzan líneas. */
function plano(texto) {
	return texto.replace(/\r\n/g, '\n').replace(/\s+/g, ' ');
}

/**
 * Recorre los agentes y devuelve las citas: { skill: { pasos: Set<n>, secciones: Set<título> } }.
 * Un tramo de un agente pertenece a una skill desde una línea que la nombra
 * ("**Ronda 1: skill `openspec-propose`**" o "## Cómo usás la skill openspec-explore") hasta
 * la siguiente que nombra otra o hasta el siguiente encabezado "## ".
 */
function citasDeLosAgentes() {
	const citas = {};
	const carpeta = path.join(raiz, 'agents');
	for (const archivo of fs.readdirSync(carpeta).filter(f => f.endsWith('.md'))) {
		const lineas = fs.readFileSync(path.join(carpeta, archivo), 'utf8').replace(/\r\n/g, '\n').split('\n');
		// Los títulos del propio agente ("Ronda con feedback") no son citas a la skill.
		const propios = new Set(lineas.filter(l => /^#{2,4} /.test(l)).map(l => l.replace(/^#+ /, '').trim()));
		let skill = null;
		let tramo = [];
		const cerrar = () => {
			if (skill) {
				registrar(citas, skill, plano(tramo.join('\n')), archivo, propios);
			}
			tramo = [];
		};
		for (const linea of lineas) {
			const nombra = /skill `?(openspec-[\w-]+)`?/.exec(linea);
			const esTitulo = linea.startsWith('## ');
			if (nombra && (esTitulo || linea.startsWith('**'))) {
				cerrar();
				skill = nombra[1];
			}
			else if (esTitulo) {
				cerrar();
				skill = null;
			}
			if (skill) {
				tramo.push(linea);
			}
		}
		cerrar();
	}
	return citas;
}

function registrar(citas, skill, texto, archivo, propios) {
	const c = citas[skill] || (citas[skill] = { pasos: new Map(), secciones: new Map() });
	for (const m of texto.matchAll(/\*\*Pasos? ([\d, y]+?)[:,]?(?: y salida| solo [^*]*)?:?\*\*/g)) {
		for (const n of m[1].match(/\d+/g)) {
			c.pasos.set(n, archivo);
		}
	}
	// Secciones citadas entre comillas: títulos en inglés, como están en la skill.
	for (const m of texto.matchAll(/"([A-Z][A-Za-z]*(?: [a-z][A-Za-z]*)+)"/g)) {
		if (!propios.has(m[1])) {
			c.secciones.set(m[1], archivo);
		}
	}
}

/** Pasos ("1. **Título**") y secciones (encabezados y líneas en negrita) de una skill real. */
function leerSkill(carpetaSkills, skill) {
	const archivo = path.join(carpetaSkills, skill, 'SKILL.md');
	if (!fs.existsSync(archivo)) {
		return null;
	}
	const texto = fs.readFileSync(archivo, 'utf8').replace(/\r\n/g, '\n');
	const pasos = {};
	for (const m of texto.matchAll(/^(\d+)\. \*\*(.+?)\*\*/gm)) {
		if (!(m[1] in pasos)) {
			pasos[m[1]] = m[2].trim();
		}
	}
	const secciones = new Set();
	for (const m of texto.matchAll(/^#{2,4} (.+)$|^\*\*(.+?)\*\*\s*$/gm)) {
		secciones.add((m[1] || m[2]).trim());
	}
	return { pasos, secciones };
}

function generarSkills() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-openspec-'));
	// Un comando armado a mano: en Windows openspec es un .cmd y necesita la shell. Los únicos
	// argumentos variables son la carpeta temporal, que va entre comillas.
	execSync(`openspec init --tools claude --no-animation "${dir}"`, { stdio: 'ignore' });
	const version = execSync('openspec --version', { encoding: 'utf8' }).trim();
	return { carpeta: path.join(dir, '.claude', 'skills'), version, dir };
}

const citas = citasDeLosAgentes();
const referencias = fs.existsSync(archivoReferencias) ? JSON.parse(fs.readFileSync(archivoReferencias, 'utf8')) : { skills: {} };

// 1. Toda cita de un agente tiene que estar registrada.
for (const [skill, c] of Object.entries(citas)) {
	const ref = referencias.skills[skill] || { pasos: {}, secciones: [] };
	for (const [n, archivo] of c.pasos) {
		if (!actualizar && !(n in ref.pasos)) {
			problemas.push(`agents/${archivo}: cita el paso ${n} de ${skill}, que no está en skills-referenciadas.json`);
		}
	}
	for (const [s, archivo] of c.secciones) {
		if (!actualizar && !ref.secciones.includes(s)) {
			problemas.push(`agents/${archivo}: cita la sección "${s}" de ${skill}, que no está en skills-referenciadas.json`);
		}
	}
}

// 2. Con la CLI: cada referencia tiene que seguir existiendo, con el mismo título.
if (conOpenspec) {
	const generadas = generarSkills();
	const nuevas = { openspec: generadas.version, skills: {} };
	for (const [skill, c] of Object.entries(citas)) {
		const real = leerSkill(generadas.carpeta, skill);
		if (!real) {
			problemas.push(`${skill}: OpenSpec ${generadas.version} no genera esta skill`);
			continue;
		}
		const ref = referencias.skills[skill] || { pasos: {}, secciones: [] };
		const pasos = {};
		for (const n of [...c.pasos.keys()].sort((a, b) => a - b)) {
			pasos[n] = real.pasos[n] || null;
			if (actualizar) {
				if (!real.pasos[n]) {
					problemas.push(`${skill}: no tiene paso ${n}, que citan los agentes`);
				}
			}
			else if (ref.pasos[n] && real.pasos[n] !== ref.pasos[n]) {
				problemas.push(`${skill}: el paso ${n} era "${ref.pasos[n]}" y en OpenSpec ${generadas.version} es "${real.pasos[n] || '(no existe)'}"`);
			}
		}
		const secciones = [...c.secciones.keys()].sort();
		for (const s of secciones) {
			if (!real.secciones.has(s)) {
				problemas.push(`${skill}: no tiene la sección "${s}" en OpenSpec ${generadas.version}`);
			}
		}
		nuevas.skills[skill] = { pasos, secciones };
	}
	fs.rmSync(generadas.dir, { recursive: true, force: true });
	if (actualizar && problemas.length === 0) {
		fs.writeFileSync(archivoReferencias, `${JSON.stringify(nuevas, null, '\t')}\n`);
		console.log(`skills-referenciadas.json actualizado con OpenSpec ${generadas.version}.`);
	}
	else if (!actualizar) {
		console.log(`Comparado con las skills de OpenSpec ${generadas.version} (referencias de ${referencias.openspec}).`);
	}
}

if (problemas.length) {
	console.error(problemas.map(p => `- ${p}`).join('\n'));
	process.exit(1);
}
const total = Object.values(citas).reduce((n, c) => n + c.pasos.size + c.secciones.size, 0);
console.log(`OK: ${total} citas a ${Object.keys(citas).length} skills de OpenSpec.`);
