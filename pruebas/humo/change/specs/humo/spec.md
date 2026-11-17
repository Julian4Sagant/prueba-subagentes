## Purpose

Capacidad del fixture de humo, para probar el schema con subagentes de punta a punta.

## ADDED Requirements

### Requirement: Salud del servicio
El sistema SHALL responder al chequeo de salud.

#### Scenario: Servicio disponible
- **WHEN** se pide GET /salud
- **THEN** responde 200
