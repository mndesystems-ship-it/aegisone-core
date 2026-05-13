param([int]$TimeoutSeconds = 30)
. "$PSScriptRoot\common.ps1"

$service = Get-ServiceOrNull
if (-not $service) { Write-TypedFailure "ERR_SERVICE_START_FAILED" "Service is not installed" }
$config = Read-CustodyConfig
try {
  if ($service.Status -ne "Running") { Start-Service -Name $script:ServiceName }
} catch {
  Write-TypedFailure "ERR_SERVICE_START_FAILED" "Service failed to start: $($_.Exception.Message)"
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
  Start-Sleep -Milliseconds 500
  $health = Invoke-Health -Config $config
  if ($health -and $health.ok) {
    Write-Pass @{ service_name = $script:ServiceName; health = $health }
    exit 0
  }
} while ((Get-Date) -lt $deadline)

Write-TypedFailure "ERR_HEALTH_TIMEOUT" "Service did not become ready before timeout" @{ timeout_seconds = $TimeoutSeconds }
