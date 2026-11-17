# Instala los agentes de planificación, el hook, el schema y el guion del orquestador en un proyecto.
# Uso: powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Proyecto C:\ruta\al\proyecto
#
# Los agentes van al proyecto y no a ~/.claude, porque el hook se resuelve con $CLAUDE_PROJECT_DIR.
# No toca openspec/config.yaml ni CLAUDE.md: al final dice qué falta configurar a mano.
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
$schemas = Join-Path $Proyecto 'openspec\schemas'
New-Item -ItemType Directory -Force -Path (Join-Path $claude 'agents'), (Join-Path $claude 'hooks'), $schemas | Out-Null

Copy-Item (Join-Path $raiz 'agents\*.md') (Join-Path $claude 'agents') -Force
Copy-Item (Join-Path $raiz 'hooks\*.js') (Join-Path $claude 'hooks') -Force
Copy-Item (Join-Path $raiz 'schemas\*') $schemas -Recurse -Force
Copy-Item (Join-Path $raiz 'ORQUESTACION.md') $Proyecto -Force
Write-Host "Agentes, hook, schema y ORQUESTACION.md instalados en $Proyecto"

# Lo que el instalador no hace por su cuenta.
$pendientes = @()
foreach ($skill in 'openspec-explore', 'openspec-propose', 'openspec-update-change') {
	if (-not (Test-Path (Join-Path $claude "skills\$skill\SKILL.md"))) {
		$pendientes += "Falta la skill $skill. Corré: openspec init --tools claude (o openspec update)"
	}
}
$config = Join-Path $Proyecto 'openspec\config.yaml'
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
