# Run once from any working directory. No game launch, asset export or copy.
$ErrorActionPreference = 'Stop'
$taskRepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$taskVenv = Join-Path $taskRepoRoot 'local/python/.venv'
$taskPython = Join-Path $taskVenv 'Scripts/python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    & py -3.12 -m venv $taskVenv
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 virtual environment creation failed.' }
}
& $taskPython -m pip install -r (Join-Path $PSScriptRoot 'requirements-all.txt')
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
$taskNpm = if ($env:OS -eq 'Windows_NT') { 'npm.cmd' } else { 'npm' }
& $taskNpm ci --prefix (Join-Path $PSScriptRoot 'gltf-deps')
if ($LASTEXITCODE -ne 0) { throw 'GLB dependency installation failed.' }
Write-Host "Tool environment ready: $taskPython"
