# Instala los agentes de planificación, el hook, el schema, el guion del orquestador y los carriles en un proyecto.
# Uso: powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Proyecto C:\ruta\al\proyecto
#
# Los agentes van al proyecto y no a ~/.claude, porque el hook se resuelve con $CLAUDE_PROJECT_DIR.
# No toca openspec/config.yaml ni CLAUDE.md: al final dice qué falta configurar a mano.
# Las rutas usan '/' para que corra igual en Windows PowerShell y en pwsh de Linux (CI).
param([Parameter(Mandatory)][string]$Proyecto)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Proyecto -PathType Container)) {
	throw "No existe el proyecto: $Proyecto"
}
if (-not (Test-Path (Join-Path $Proyecto 'openspec') -PathType Container)) {
	throw "El proyecto no usa OpenSpec (no hay carpeta openspec/). Corré antes: openspec init --tools claude"
}

$raiz = Split-Path -Parent $PSScriptRoot
$claude = Join-Path $Proyecto '.claude'
$schemas = Join-Path $Proyecto 'openspec/schemas'
$scripts = Join-Path $Proyecto 'scripts'
$workflows = Join-Path $Proyecto '.github/workflows'
New-Item -ItemType Directory -Force -Path (Join-Path $claude 'agents'), (Join-Path $claude 'hooks'), (Join-Path $claude 'commands'), $schemas, $scripts, $workflows | Out-Null

Copy-Item (Join-Path $raiz 'agents/*.md') (Join-Path $claude 'agents') -Force
Copy-Item (Join-Path $raiz 'hooks/*.js') (Join-Path $claude 'hooks') -Force
Copy-Item (Join-Path $raiz 'commands/*.md') (Join-Path $claude 'commands') -Force
Copy-Item (Join-Path $raiz 'schemas/*') $schemas -Recurse -Force
Copy-Item (Join-Path $raiz 'ORQUESTACION.md'), (Join-Path $raiz 'CARRILES.md'), (Join-Path $raiz 'APLICACION.md') $Proyecto -Force
# Tramo de apply: el control de alcance por agente y su workflow de CI (GitHub Actions).
Copy-Item (Join-Path $raiz 'scripts/check-agent-scope.py') $scripts -Force
Copy-Item (Join-Path $raiz 'ci/alcance-agentes.yml') $workflows -Force
Write-Host "Agentes, hook, comando /pedido, schema, ORQUESTACION.md, CARRILES.md y APLICACION.md instalados en $Proyecto"
Write-Host "Apply: scripts/check-agent-scope.py y .github/workflows/alcance-agentes.yml (control de alcance por agente en cada PR)"

# Lo que el instalador no hace por su cuenta.
$pendientes = @()
foreach ($skill in 'openspec-explore', 'openspec-propose', 'openspec-update-change') {
	if (-not (Test-Path (Join-Path $claude "skills/$skill/SKILL.md"))) {
		$pendientes += "Falta la skill $skill. Corré: openspec init --tools claude (o openspec update)"
	}
}
$config = Join-Path $Proyecto 'openspec/config.yaml'
if (-not (Test-Path $config) -or -not (Select-String -Path $config -Pattern '^schema:\s*spec-driven-agentes\s*$' -Quiet)) {
	$pendientes += 'openspec/config.yaml no usa el schema: poné "schema: spec-driven-agentes"'
}
$claudeMd = Join-Path $Proyecto 'CLAUDE.md'
if (-not (Test-Path $claudeMd) -or -not (Select-String -Path $claudeMd -Pattern 'ORQUESTACION\.md' -Quiet)) {
	$pendientes += 'CLAUDE.md no menciona ORQUESTACION.md: sumá que la sesión principal lo siga para todo pedido nuevo'
}

if ($pendientes.Count) {
	Write-Host ''
	Write-Host 'Pendiente:'
	$pendientes | ForEach-Object { Write-Host "- $_" }
}
