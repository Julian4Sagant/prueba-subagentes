#!/usr/bin/env python3
"""
Tests de check-agent-scope.py, sin git: prueban la traducción de globs a regex
(que `*` no cruce `/` y `**` sí), el alcance por agente y el parseo del trailer.

Uso: python scripts/test-check-agent-scope.py
"""
import importlib.util
import pathlib
import sys

RUTA = pathlib.Path(__file__).with_name("check-agent-scope.py")
spec = importlib.util.spec_from_file_location("check_agent_scope", RUTA)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

fallos = []


def chequear(cond, msg):
    if not cond:
        fallos.append(msg)


# glob_to_regex: `*` no cruza `/`, `**` sí
rx = mod.glob_to_regex("openspec/changes/*/impacto.md")
chequear(rx.match("openspec/changes/foo/impacto.md"), "* debería matchear un nivel")
chequear(not rx.match("openspec/changes/foo/bar/impacto.md"), "* no debe cruzar /")

rx2 = mod.glob_to_regex("**/src/test/**")
chequear(rx2.match("app/src/test/java/X.java"), "** debería cruzar directorios")
chequear(rx2.match("src/test/java/X.java"), "**/ inicial es opcional")
chequear(not rx2.match("app/src/main/java/X.java"), "no debe matchear src/main")

rx3 = mod.glob_to_regex("openspec/changes/*/specs/**")
chequear(rx3.match("openspec/changes/foo/specs/clientes/spec.md"), "specs/** anidado")

# allowed por agente: cada uno solo sus rutas
chequear(mod.allowed("implementador", "src/main/java/X.java"), "implementador toca src/main")
chequear(mod.allowed("implementador", "app/pom.xml"), "implementador toca pom.xml")
chequear(mod.allowed("implementador", "openspec/changes/foo/tasks.md"), "implementador marca [x] en tasks")
chequear(not mod.allowed("implementador", "src/test/java/X.java"), "implementador NO toca tests")
chequear(mod.allowed("test-author", "app/src/test/java/XTest.java"), "test-author toca tests")
chequear(not mod.allowed("test-author", "src/main/java/X.java"), "test-author NO toca src/main")
chequear(mod.allowed("reviewer", "openspec/changes/foo/revision.md"), "reviewer -> revision.md")
chequear(not mod.allowed("reviewer", "openspec/changes/foo/seguridad.md"), "reviewer NO seguridad.md")
chequear(mod.allowed("security-reviewer", "openspec/changes/foo/seguridad.md"), "security -> seguridad.md")
chequear(mod.allowed("archivista", "CHANGELOG.md"), "archivista -> CHANGELOG")
chequear(mod.allowed("archivista", "openspec/specs/clientes/spec.md"), "archivista -> openspec/**")
chequear(mod.allowed("archivista", "docs/metricas/cambios.csv"), "archivista -> métricas")

# trailer Agente:
m = mod.TRAILER.search("feat(x): y\n\nAgente: implementador\n")
chequear(m and m.group(1) == "implementador", "trailer Agente: parseado")
chequear(not mod.TRAILER.search("feat(x): y\n\nsin trailer\n"), "sin trailer -> None")

if fallos:
    print("FALLOS:")
    for f in fallos:
        print(" -", f)
    sys.exit(1)
print("OK: check-agent-scope.py pasa todos los chequeos.")
