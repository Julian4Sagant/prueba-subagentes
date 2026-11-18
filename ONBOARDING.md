# Onboarding: subagentes de planificación

Guía para empezar a usar estos subagentes. Para el detalle de cada parte, el
[README](README.md) y los dos archivos de reglas: [ORQUESTACION.md](ORQUESTACION.md)
(el guion del orquestador) y [CARRILES.md](CARRILES.md) (carriles y señales).

## La idea en una frase

Pegás un pedido (un ticket, un bug, una idea) y los agentes lo llevan hasta un
change de OpenSpec listo para implementar. Vos solo decidís en los **gates**
(aprobar / rechazar). Todo lo que el pedido no aclara, los agentes lo resuelven
con la opción más razonable y te la muestran como **decisión pendiente** en el gate.

## Antes de empezar

- [OpenSpec](https://github.com/Fission-AI/OpenSpec) 1.16+ inicializado en tu
  proyecto con las skills de Claude: `openspec init --tools claude`.
- Node.js (para el hook que bloquea git).
- Para la automatización sin terminal: Java 17 o más.

## Paso 1 — Instalar en tu proyecto

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Proyecto C:\ruta\al\proyecto
```

Después, a mano (el instalador te lo recuerda):
1. En `openspec/config.yaml`: `schema: spec-driven-agentes`.
2. En `CLAUDE.md`: que la sesión principal siga `ORQUESTACION.md` para todo pedido nuevo.
3. Poné las reglas del proyecto (stack, formato de errores, qué es BREAKING) en el
   `context` de `openspec/config.yaml`: todos los agentes lo leen.

## Paso 2 — Tu primer pedido

En una sesión de Claude Code en el proyecto:

```text
/pedido Al dar de alta un cliente, recortar los espacios del nombre.
```

El pedido puede ocupar varias líneas (pegá el ticket entero si querés). A partir
de ahí, la sesión **es el orquestador**: llama a los agentes en orden, verifica lo
que devuelven y frena en el primer gate. No le tenés que decir nada entre agente
y agente.

## Paso 3 — Responder los gates

En cada gate, el orquestador te muestra qué aprobar, un resumen, las **decisiones
pendientes** (con la opción elegida y las alternativas) y sus observaciones. Vos:

- **Aprobás:** escribís `aprobada` (o confirmás).
- **Rechazás:** escribís qué hay que cambiar. Ese comentario es la corrección; el
  agente vuelve a su ronda.

Los gates son:

| Gate | Cuándo | Qué mirás |
|---|---|---|
| **Validar baseline** | solo LEGACY | que el baseline describa bien lo que el sistema hace hoy |
| **Aprobar spec** | siempre (salvo RAPIDO) | Requirements, Scenarios, "Contratos afectados" y "Fuera de alcance" |
| **Aprobar diseño** | si se escribió design | las decisiones del diseño |

Al final, el orquestador te dice cómo seguir con el apply. Tope: hasta 3
correcciones por agente y 2 vueltas por hueco; si haría falta una más, frena y te
explica qué pasó.

## El carril (por qué a veces hay más pasos)

El **explorador** marca señales objetivas (¿toca un contrato? ¿datos personales?
¿el área tiene spec y tests?) y el orquestador fija el carril con reglas fijas. El
carril **nunca baja**.

| Carril | Para qué | Pasos |
|---|---|---|
| **RAPIDO** | Typo, config, trivial | directo al MR, sin change |
| **ESTANDAR** | Cambio acotado, sin riesgo | spec → arquitecto → planner |
| **COMPLETO** | Toca contrato, datos personales, auth o varios repos | igual, con design siempre |
| **LEGACY** | El área no tiene spec ni tests y se modifica | primero un baseline, después su carril base |

El detalle está en [CARRILES.md](CARRILES.md). Nota útil: en un código donde casi
todo toca contratos o datos personales, la mayoría de los cambios caen en COMPLETO
o LEGACY; ESTANDAR es raro.

## Correrlo sin terminal (opcional)

`orquestador/Orquestador.java` corre todo el flujo fuera de la terminal de Claude:
recibe pedidos y decisiones, lanza `claude -p` en el proyecto y retoma la misma
sesión en cada gate. Dos formas de darle entrada:

- **Bandeja de archivos:** dejás el pedido en `bandeja/entrada/<id>.txt` y las
  respuestas en `bandeja/decisiones/`.
- **Webhook HTTP** (`--http <puerto>`): un `POST /pedido` y un `POST /decision`,
  como lo mandaría un webhook de Jira.

```text
java orquestador/Orquestador.java --proyecto C:/ruta/al/proyecto --bandeja bandeja --vigilar
```

Los gates salen en `bandeja/gates/<id>-<n>.md`. El orquestador corre en Sonnet por
defecto (barato); los subagentes que necesitan Opus lo conservan. El costo que
informa es una estimación a precio de lista. El detalle (permisos, topes, el bloque
de estado) está en el [README](README.md).

## Cuando algo para fuera de un gate

- **`YA_CUMPLE`:** el explorador encontró que el pedido ya está hecho (código y
  test). No se crea change; el orquestador te muestra la evidencia.
- **`BLOQUEADO`:** una imposibilidad real (pedido ininteligible, repo inaccesible).
- **Tope:** haría falta una 4ª corrección o una 3ª vuelta por hueco. El orquestador
  frena y te explica qué pasó en cada ronda.

## Qué esperar y qué no

- Los agentes **no te preguntan nada** fuera de los gates: las dudas van como
  decisiones pendientes.
- Ninguno hace **git**: el hook `sin-escritura.js` lo bloquea. Los commits son del
  tramo de apply, que es otra cosa.
- El orquestador **no le cree a los agentes**: relee los archivos y verifica. Si
  algo está mal, lo devuelve; nunca edita un artefacto él mismo.
- Un cambio chico cuesta poco (~US$ 1-2 estimados); un LEGACY, más (~US$ 4).

## Mapa de archivos

```
agents/          los 5 agentes (fuente de verdad)
ORQUESTACION.md  el guion del orquestador
CARRILES.md      carriles, señales y reglas
schemas/         el schema spec-driven-agentes
hooks/           sin-escritura.js (bloquea git)
commands/        /pedido
orquestador/     Orquestador.java (automatización por bandeja o webhook)
scripts/         instalador, validaciones y tests
```

## Qué sigue

Este repo cubre la **planificación**. La **implementación** (apply, tests, revisión,
el control de alcance por agente) es el tramo siguiente, con `/apply-grupo`, y
todavía no está acá.
