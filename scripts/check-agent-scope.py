#!/usr/bin/env python3
"""
Control de alcance por agente.

Recorre los commits de la rama (base..HEAD) y, para cada commit que tenga el
trailer "Agente: <nombre>", verifica que solo toque rutas permitidas para ese
agente. Pensado para correr en CI sobre cada Merge Request / Pull Request.

Uso:
    python3 scripts/check-agent-scope.py --base origin/main
    python3 scripts/check-agent-scope.py --base origin/main --strict

--strict: falla también si hay commits sin trailer "Agente:" (por defecto se
          asumen commits humanos y se permiten).

Sale con código 1 si encuentra violaciones.
"""
import argparse
import re
import subprocess
import sys

# Rutas permitidas por agente. "*" no cruza directorios; "**" sí.
SCOPES = {
    "explorador": [
        "openspec/changes/*/impacto.md",
        "openspec/changes/*/.openspec.yaml",
    ],
    "arqueologo-legacy": [
        "openspec/changes/baseline-*/**",
        "**/src/test/**",
    ],
    # Carril estándar: la sesión principal genera los artefactos con /opsx:continue.
    "opsx-continue": [
        "openspec/changes/*/.openspec.yaml",
        "openspec/changes/*/impacto.md",
        "openspec/changes/*/proposal.md",
        "openspec/changes/*/specs/**",
        "openspec/changes/*/design.md",
        "openspec/changes/*/tasks.md",
    ],
    "spec-writer": [
        "openspec/changes/*/proposal.md",
        "openspec/changes/*/specs/**",
    ],
    "arquitecto": [
        "openspec/changes/*/design.md",
        "docs/adr/**",
    ],
    "planner": [
        "openspec/changes/*/tasks.md",
    ],
    "test-author": [
        "**/src/test/**",
    ],
    "implementador": [
        "**/src/main/**",
        "**/pom.xml",
        "openspec/changes/*/tasks.md",
    ],
    "reviewer": [
        "openspec/changes/*/revision.md",
    ],
    "security-reviewer": [
        "openspec/changes/*/seguridad.md",
    ],
    "archivista": [
        "openspec/**",
        "CHANGELOG.md",
        "docs/adr/**",
        "docs/metricas/**",
    ],
}

TRAILER = re.compile(r"^Agente:\s*(\S+)\s*$", re.MULTILINE)


def glob_to_regex(pattern: str) -> re.Pattern:
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif pattern.startswith("**", i):
            out += ".*"
            i += 2
        elif pattern[i] == "*":
            out += "[^/]*"
            i += 1
        elif pattern[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(pattern[i])
            i += 1
    return re.compile("^" + out + "$")


COMPILED = {agent: [glob_to_regex(p) for p in pats] for agent, pats in SCOPES.items()}


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True
    ).stdout


def changed_paths(sha: str) -> list[str]:
    """Todas las rutas tocadas, incluidas origen y destino de renombres."""
    out = git("diff-tree", "--no-commit-id", "-r", "-M", "--name-status", sha)
    paths = []
    for line in out.splitlines():
        parts = line.split("\t")
        paths.extend(parts[1:])
    return paths


def allowed(agent: str, path: str) -> bool:
    return any(rx.match(path) for rx in COMPILED[agent])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="origin/main")
    ap.add_argument("--strict", action="store_true")
    args = ap.parse_args()

    shas = git("rev-list", "--reverse", "--no-merges", f"{args.base}..HEAD").split()
    violations, untagged, checked = [], [], 0

    for sha in shas:
        body = git("log", "-1", "--format=%B", sha)
        subject = body.splitlines()[0] if body else ""
        m = TRAILER.search(body)
        if not m:
            untagged.append((sha, subject))
            continue
        agent = m.group(1)
        checked += 1
        if agent not in COMPILED:
            violations.append((sha, subject, agent, "agente desconocido"))
            continue
        for path in changed_paths(sha):
            if not allowed(agent, path):
                violations.append((sha, subject, agent, path))

    print(f"Commits revisados: {len(shas)} | con agente: {checked} | sin agente: {len(untagged)}")

    if untagged and args.strict:
        for sha, subject in untagged:
            violations.append((sha, subject, "-", "commit sin trailer 'Agente:' (modo estricto)"))
    elif untagged:
        print("Commits sin trailer (se asumen humanos):")
        for sha, subject in untagged:
            print(f"  {sha[:10]}  {subject}")

    if violations:
        print("\nVIOLACIONES DE ALCANCE:")
        for sha, subject, agent, detail in violations:
            print(f"  {sha[:10]}  [{agent}]  {detail}    ({subject})")
        return 1

    print("OK: todos los commits de agentes respetan su alcance.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
