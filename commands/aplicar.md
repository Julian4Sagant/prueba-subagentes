---
description: Implementa un change ya planificado (spec, diseño y tasks aprobados) con los subagentes de apply, siguiendo APLICACION.md
argument-hint: <change-id> (el change con tasks.md aprobado)
---
Apply de un change. Sos el orquestador del apply: seguí `APLICACION.md` para el change `$ARGUMENTS`. No escribís código ni artefactos vos; llamás a los subagentes, verificás lo que devuelven y frenás en los gates. A diferencia de la planificación, acá los agentes **commitean** su trabajo (con el trailer `Agente: <nombre>`); el hook `sin-escritura.js --permitir-commit` deja `git add`/`commit` pero bloquea push, reset, rebase y demás.

El flujo, grupo por grupo de `tasks.md`, **Contratos primero**:
- **Grupo Contratos:** solo `implementador` (escribe las firmas, compilan), sin `test-author`.
- **Cada tarea con tests:** `test-author` (tests en rojo por la razón correcta) → `implementador` (código mínimo a verde, marca `[x]`, un commit). Una tarea por vez.
- **Con todas las tareas en `[x]`:** `reviewer` + `security-reviewer` en paralelo (seguridad corre en COMPLETO, o en ESTANDAR si toca datos personales, auth o dependencias) → si hay un hallazgo BLOQUEANTE/ALTO/CRÍTICO vuelve el `implementador` → gate **Aprobar MR** → `archivista` (último commit) → merge (lo hace una persona; vos no mergeás).

Lo que no cambia entre corridas (el detalle está en `APLICACION.md`):
- **No le creas a los agentes:** releé los archivos, corré el comando de verificación de cada tarea y el build, y chequeá que el bloque JSON de cada agente traiga sus campos.
- **Pasales siempre:** el change-id, la ronda y el feedback si lo hay; al `test-author` la tarea `N.M` y sus escenarios; al `implementador` la tarea (o los hallazgos a corregir); a los revisores la base de la rama.
- **Topes:** `implementador` hasta 3 intentos por tarea; hasta 3 rondas de revisión. Un `TEST_CUESTIONADO`, un hueco o un tope → frená y consultame.
- **Alcance:** cada commit lleva su trailer `Agente:`; `check-agent-scope.py` lo verifica en el PR.

Antes de arrancar:
- Si `$ARGUMENTS` está vacío, pedime el change-id y no arranques.
- Si no existe `APLICACION.md` en la raíz, o el change no tiene `tasks.md` en `done` (`openspec status --change "$ARGUMENTS" --json`), frená y avisame.
- Trabajá en la rama `change/$ARGUMENTS`; si no existe, decímelo antes de tocar nada.
