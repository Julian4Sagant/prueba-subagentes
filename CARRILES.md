# Carriles

Un carril define qué pasos recorre un pedido. Es el único lugar donde se
definen los carriles: el orquestador y el explorador lo leen, y los demás
archivos lo citan sin repetirlo. Si cambiás una regla, cambiala acá.

## Los carriles

| Carril | Para qué | Qué recorre en este tramo |
| --- | --- | --- |
| **RAPIDO** | Typo, texto, configuración o un cambio trivial sin comportamiento nuevo. | Nada: no se crea change. Va directo a la implementación y al gate de Aprobar MR. |
| **ESTANDAR** | Un cambio acotado a un área, sin ninguna señal de riesgo. | explorador → spec-writer → Aprobar spec → arquitecto (design solo si el schema lo pide) → Aprobar diseño. |
| **COMPLETO** | Contratos, datos personales, auth, varios repos o lógica crítica. | Igual que ESTANDAR, pero el design se escribe siempre. |
| **LEGACY** | El área no tiene spec ni tests y el cambio modifica comportamiento. | Primero el baseline: arqueologo-legacy → Validar baseline → archivar. Después sigue por su **carril base** (ver abajo). |

**Sin carril:** si el explorador comprueba que el pedido ya se cumple (código
y test que lo cubren), devuelve `YA_CUMPLE` y no hay carril ni change. No es
RAPIDO: RAPIDO implementa algo, y acá no hay nada que implementar. Qué hace el
orquestador en ese caso está en `ORQUESTACION.md`.

## Señales

Las detecta el explorador y las devuelve en su JSON, cada una con evidencia en
`impacto.md`. Son hechos, no opiniones: se marcan `true` solo con evidencia.

| Señal | `true` cuando |
| --- | --- |
| `tocaContrato` | Cambia una API pública, un mensaje, un evento, un archivo de intercambio o un esquema que consume otro sistema |
| `datosPersonales` | Lee, guarda, muestra o registra en logs datos que identifican a una persona |
| `auth` | Toca autenticación, autorización, roles, tokens o sesiones |
| `dependencias` | Agrega o actualiza una librería o un servicio externo |
| `multiRepo` | El cambio necesita modificaciones en más de un repositorio |
| `areaSinSpec` | Ninguna spec vigente describe el comportamiento del área afectada |
| `areaSinTests` | No hay tests que cubran el comportamiento que se va a modificar |
| `modificaComportamiento` | El cambio altera algo que el sistema ya hace (no solo agrega algo nuevo) |

## Reglas para fijar el carril

El explorador **recomienda** un carril; el orquestador lo **fija** con estas
reglas, en este orden:

1. `areaSinSpec`, `areaSinTests` y `modificaComportamiento` en `true` →
   **LEGACY**.
2. `tocaContrato`, `datosPersonales`, `auth` o `multiRepo` en `true` → como
   mínimo **COMPLETO**.
3. `dependencias` en `true` → como mínimo **ESTANDAR**: sumar o actualizar una
   librería nunca es RAPIDO.
4. Si no aplica ninguna, el carril que recomendó el explorador.

- **Nunca baja.** Si el explorador recomienda un carril más alto que el que
  dan las reglas, queda el del explorador. Ante la duda, el más alto.
- **El carril base de LEGACY** sale de las reglas 2 a 4 y de la recomendación
  del explorador, y nunca es RAPIDO: si da RAPIDO, es ESTANDAR. Es el carril
  con el que siguen el spec-writer y el arquitecto después del baseline.
- El orquestador le dice a la persona qué carril quedó (y el base, en LEGACY)
  y qué regla lo decidió.

## Qué corre cada carril

| Paso | RAPIDO | ESTANDAR | COMPLETO | LEGACY |
| --- | --- | --- | --- | --- |
| explorador (`impacto`) | sí, sin change | sí | sí | sí |
| arqueologo-legacy + Validar baseline | — | — | — | sí |
| spec-writer + Aprobar spec | — | sí | sí | sí |
| arquitecto: `design` | — | si el schema lo pide | siempre | según el carril base |
| arquitecto: `tasks` + Aprobar diseño | — | sí | sí | sí |

### Después de este tramo (referencia)

El apply y la revisión no los ejecuta este tramo. Para el tramo siguiente
(por ejemplo, `/apply-grupo` de subagentesCC-openspec), las señales también
activan:

| Señal en `true` | Activa |
| --- | --- |
| `auth`, `datosPersonales` o `dependencias` | la revisión de seguridad (`security-auditor`) |
| `tocaContrato` o `multiRepo` | revisar la compatibilidad con quienes consumen el contrato, contra lo que el proposal marca como BREAKING |

En todos los carriles, el cierre es el gate de Aprobar MR.
