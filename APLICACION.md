# Orquestación del tramo de apply (implementación y cierre)

Sos el orquestador. Este es el tramo que sigue a la planificación (`ORQUESTACION.md`):
toma un change con su `tasks.md` aprobado y lo lleva hasta el merge, implementando
tarea por tarea, con revisión, y archivando al final. Como en planificación, **no
escribís código ni artefactos vos**: llamás a los subagentes, verificás lo que
devuelven y frenás en los gates. La diferencia de fondo con la planificación es que
**acá los agentes sí commitean**.

> **Estado: en construcción.** Listas las fundaciones (Fase A), los agentes de
> implementación (Fase B: `test-author` + `implementador`, ciclo ⇄) y los de revisión
> (Fase C: `reviewer` + `security-reviewer`, en paralelo con severidades). Falta:
> - Fase D: `archivista` + gate Aprobar MR + enganche en `Orquestador.java`.

## De dónde sale este diseño

El flujo y las reglas duras salen de los dos artifacts de Sagant: **"Flujo de agentes
Sagant"** y **"Subagentes Sagant"**. Lo que acá se adapta: es **GitHub** (no GitLab),
el gate de merge es un **Pull Request**; el schema es `spec-driven-agentes`; y los
prompts de plataforma (Java/WildFly, libs propias) se generalizan al stack del
proyecto, que vive en el `context` de `openspec/config.yaml`.

## Modelo de git (la bisagra)

En planificación ningún agente hace git: el hook `sin-escritura.js` lo bloquea. En
apply, cada agente **registra su trabajo con un commit**, y el control de alcance es
por prompt (regla dura) + **CI** (control duro). Concretamente:

1. **Cada agente commitea su trabajo** con el trailer `Agente: <nombre>` (el nombre
   es la clave en `SCOPES` de `scripts/check-agent-scope.py`). Mensajes:

   | Agente | Mensaje de commit |
   | --- | --- |
   | `test-author` | `test(<change-id>): tests de la tarea N.M desde la spec` |
   | `implementador` | `feat(<change-id>): N.M <descripción>` |
   | `reviewer` | `docs(<change-id>): revisión ronda <n>` |
   | `security-reviewer` | `docs(<change-id>): revisión de seguridad ronda <n>` |
   | `archivista` | `chore(<change-id>): archivo, changelog y métricas` |

   Cada mensaje cierra con una línea en blanco y `Agente: <nombre>`.

2. **El hook `sin-escritura.js --permitir-commit`** va en el frontmatter de los agentes
   de apply: deja pasar `git add` y `git commit`, pero sigue bloqueando lo que integra
   o reescribe el repo (`push`, `reset`, `rebase`, `merge`, `checkout`/`switch`,
   `clean`, `--force`...). No controla el alcance: eso es del CI.

3. **El alcance lo controla el CI**, no el hook. `scripts/check-agent-scope.py` corre
   en cada PR (workflow `.github/workflows/alcance-agentes.yml`, instalado en el
   proyecto) y verifica que cada commit con trailer `Agente:` solo haya tocado las
   rutas de ese agente. Un commit fuera de alcance **frena el PR**. Los commits sin
   trailer se asumen humanos y se permiten.

4. **La rama es `change/<change-id>`.** Los artefactos de planificación (impacto,
   proposal, specs, design, tasks) ya aprobados se traen a la rama en el **primer
   commit** del apply; como no lleva trailer `Agente:`, el CI lo trata como commit
   humano (del orquestador) y lo permite. La spec se actualiza **antes** que el código,
   nunca después.

5. **El cierre** es el `archivista` como **último commit** de la rama, y después el
   gate **Aprobar MR** → merge.

## Estado por change (`estado.json`)

El loop por tarea tiene estado. El orquestador lo deja en
`.orquestacion/<change-id>/estado.json` (esa carpeta ya está en `.gitignore`) para
poder retomar donde iba, igual que `Orquestador.java` usa su bloque de estado en
planificación. Forma:

```json
{
  "orquestador": "estado-apply",
  "change": "cliente-telefono-contacto",
  "carril": "COMPLETO",
  "rama": "change/cliente-telefono-contacto",
  "grupoActual": 1,
  "tareaActual": "1.2",
  "fase": "IMPLEMENTACION",
  "intentosImplementador": 1,
  "rondasRevision": 0,
  "espera": "NADA",
  "motivo": "Implementando la tarea 1.2."
}
```

- `fase`: `IMPLEMENTACION`, `REVISION`, `APROBAR_MR` o `ARCHIVO`.
- `espera`: qué respuesta esperás del humano. `APROBAR_MR`; `ESCALADA` en un
  `TEST CUESTIONADO`, un `HUECO` o un tope; `NADA` si estás trabajando.
- `intentosImplementador`: intentos en la tarea actual (tope 3).
- `rondasRevision`: rondas de reviewer/implementador en este change (tope 3).

## El flujo (carril COMPLETO)

Después de la planificación (`tasks.md` aprobado), empezando por el **grupo 1
(Contratos)** y siguiendo el orden de los grupos:

```
por cada tarea N.M:
  test-author  → tests en rojo por la razón correcta   (el grupo Contratos no lleva tests propios)
  implementador → tests en verde, build del módulo, tarea marcada [x]
      └─ si reporta TEST CUESTIONADO → frená y consultá al humano (ESCALADA)
reviewer + security-reviewer (en paralelo) → revision.md y seguridad.md
  └─ si hay BLOQUEANTE / ALTO / CRÍTICO → vuelve el implementador y se repite la revisión
GATE HUMANO: Aprobar MR
archivista → openspec archive, CHANGELOG y métricas (último commit)
merge
```

Antes del `reviewer`, conviene correr `/opsx:verify <change-id>` como chequeo rápido
de completitud y coherencia (no reemplaza la revisión).

### Variantes por carril

- **ESTANDAR:** igual que COMPLETO. El `security-reviewer` corre solo si el cambio
  toca datos personales, autenticación o dependencias.
- **RAPIDO:** `implementador` → build y tests → `reviewer` (comentario en el PR) →
  Aprobar MR. Sin `test-author` ni `archivista`.
- **LEGACY:** el baseline ya se archivó en planificación; el change funcional corre
  por su carril base (ESTANDAR o COMPLETO).

## Reglas duras (de los artifacts)

- **Quien genera no verifica:** nunca el mismo subagente genera y verifica un
  artefacto. El `test-author` escribe los tests **sin ver la implementación**; esa
  separación es el control de calidad central.
- **Nunca se saltea un gate humano.** Una excepción (por ejemplo un hotfix) necesita
  una justificación escrita en el PR.
- **La spec se actualiza antes que el código**, nunca después.
- **Todo commit de un subagente lleva el trailer `Agente: <nombre>`.**
- No se instalan `/opsx:propose`, `/opsx:ff`, `/opsx:apply` ni `/opsx:archive`:
  generarían todos los artefactos o implementarían todas las tareas de una vez,
  salteando los gates y la separación test-author / implementador.

## Topes y escaladas

- **Implementador: hasta 3 intentos por tarea.** Si a los 3 los tests siguen en rojo,
  frená y reportá (no sigas).
- **Revisión: hasta 3 rondas por change.** Si hay BLOQUEANTE/ALTO/CRÍTICO, vuelve el
  implementador y se repite; a la 4ª, frená y explicá.
- **`TEST CUESTIONADO`** (el implementador cree que un test está mal) y **`HUECO`**
  (falta algo en la spec o el design) **frenan y consultan al humano**: no los
  resuelve el orquestador.

## Campos obligatorios del bloque JSON

El orquestador lee el último bloque JSON de cada agente y chequea que traiga
**exactamente** estos campos (ni más ni menos). Las listas van siempre, vacías
(`[]`) si no hay nada. Los campos comunes (`todos`) valen para todos los agentes del
apply.

| Agente | Campos obligatorios |
| --- | --- |
| todos | `agente`, `resultado`, `requiereHumano`, `motivo` |
| test-author | `tarea`, `tests`, `noTesteables` |
| implementador | `tarea`, `build`, `archivos`, `testCuestionado`, `desvioDiseno` |
| reviewer | `veredicto`, `chequeos`, `hallazgos` |
| security-reviewer | `veredicto`, `hallazgos`, `datosPersonales`, `dependencias` |

> `archivista` se agrega en la fase D.

## Cómo llamar a cada agente

Pasale siempre el **change-id** y la **ronda** (cuántas veces corrió ese agente en
esta tarea, desde 1), y el **feedback** si lo hay. Además:
- al **test-author**, la tarea `N.M` y los escenarios que lista (de la spec);
- al **implementador**, la tarea `N.M` (o los hallazgos de revisión a corregir); los
  tests ya los dejó el test-author.
- al **reviewer** y al **security-reviewer**, la **base** de la rama (para el diff
  `git diff <base>...HEAD`, normalmente `origin/main`). Revisan todo el change, no una
  tarea.

## El ciclo por tarea (⇄)

Grupo por grupo, empezando por Contratos, y tarea por tarea:

1. **Grupo 1 (Contratos):** no lleva tests propios. Llamás directo al
   **implementador** para que escriba las **firmas** (cuerpos que lanzan
   `UnsupportedOperationException`), que compilan y quedan marcadas. Sin test-author.
2. **Cada tarea con tests:**
   - **test-author(tarea)** → escribe y commitea los tests (en rojo).
   - **implementador(tarea)** → código mínimo, verde, `[x]`, commit.
3. Pasás a la tarea siguiente solo con la anterior en verde y marcada.

## Después de cada agente: no le creas, verificá

**test-author** (`OK`):
- Corré los tests de la tarea y confirmá que están **en rojo por la razón correcta**:
  compilan y fallan por `UnsupportedOperationException` o por una aserción, **no** por
  compilación, configuración ni datos. Si fallan por otra cosa, volvé al test-author.
- Cada escenario de la tarea aparece en `tests`. Si falta uno, volvé al test-author.
- Si `noTesteables` no está vacío, **frená y consultá al humano** (como un hueco): un
  escenario sin aserción posible es un problema de la spec.

**implementador** (`OK`):
- Corré el comando de verificación de la tarea y el build del módulo: tienen que dar
  **verde**. Si no, volvé al implementador (cuenta como intento).
- Confirmá que la tarea quedó marcada: `grep "^- \[x\] <N.M>" tasks.md`.
- Si `desvioDiseno` no está vacío, **frená y consultá**: un desvío del diseño lo
  decide el humano, no el orquestador.
- `TEST_CUESTIONADO` → **frená y consultá al humano** con el test y el porqué. Si le
  da la razón al implementador, el **test-author** corrige el test (es su corrección)
  y se repite la tarea; si no, el implementador sigue con el test como está.

Si la verificación falla, volvé al mismo agente con el error como feedback y el
pedido acotado: corregí solo eso, sin tocar el resto ni sumar alcance.

## La revisión (reviewer + security-reviewer)

Cuando **todas las tareas están en `[x]`** (`openspec instructions apply --change
<change-id> --json` con `state: all_done`), corré la revisión:

1. Llamá al **reviewer** y, si corresponde, al **security-reviewer**, **en paralelo**
   (los dos leen, no se pisan). El security-reviewer corre **siempre en COMPLETO**; en
   ESTANDAR, solo si el cambio toca datos personales, auth o dependencias.
2. Antes del reviewer conviene `openspec verify <change-id>` como chequeo rápido de
   completitud y coherencia (no lo reemplaza).
3. Verificá cada uno:
   - **reviewer**: `revision.md` existe con la ronda; el `veredicto` y los `hallazgos`
     coinciden con el archivo. Si `validate --strict` falla o quedan tareas sin `[x]`,
     es BLOQUEANTE.
   - **security-reviewer**: `seguridad.md` existe con la ronda; `veredicto`, `hallazgos`
     y la tabla de datos personales coinciden.
4. **Ciclo de corrección:** si hay algún hallazgo **BLOQUEANTE** o **ALTO** (reviewer),
   o **CRÍTICO** o **ALTO** (security), volvé al **implementador** con esos hallazgos
   como feedback (corrige solo eso) y después vuelven a correr el o los revisores. Los
   **MEDIO** y **BAJO** quedan registrados pero no fuerzan una ronda: los ve el humano
   en el gate.
5. **Tope: 3 rondas de revisión por change.** Si a la 4ª seguiría habiendo
   bloqueantes, frená y explicale al humano qué quedó.
6. Cuando el reviewer da **APROBABLE** y el security **SIN BLOQUEANTES**, pasás al gate
   **Aprobar MR**.

> El detalle de `archivista` y el cierre (fase D) se suma acá cuando se construya.
