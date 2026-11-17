## Purpose

Comportamiento actual del fixture de humo, documentado como baseline antes del change funcional.

## ADDED Requirements

### Requirement: Total de la factura
<!-- id: FacturaService.total -->
El sistema SHALL calcular el total de la factura.

#### Scenario: Total con un decimal de más
<!-- a-revisar: redondea con double -->
- **WHEN** se factura 0,1 + 0,2
- **THEN** el total es 0,30000000000000004
