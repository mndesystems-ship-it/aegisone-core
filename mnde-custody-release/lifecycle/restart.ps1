. "$PSScriptRoot\common.ps1"

& "$PSScriptRoot\stop.ps1"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$PSScriptRoot\start.ps1"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Pass @{ service_name = $script:ServiceName; restarted = $true }
