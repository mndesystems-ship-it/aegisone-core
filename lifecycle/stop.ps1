param([int]$TimeoutSeconds = 30)
. "$PSScriptRoot\common.ps1"

$service = Get-ServiceOrNull
if (-not $service) { Write-Pass @{ service_name = $script:ServiceName; installed = $false; running = $false }; exit 0 }
$config = Read-CustodyConfig
try {
  if ($service.Status -ne "Stopped") { Stop-Service -Name $script:ServiceName -Force }
  $service.WaitForStatus("Stopped", "00:00:$TimeoutSeconds")
} catch {
  Write-TypedFailure "ERR_SERVICE_STOP_FAILED" "Service failed to stop: $($_.Exception.Message)"
}

Start-Sleep -Seconds 1
if (-not (Test-PortClosed -Config $config)) {
  Write-TypedFailure "ERR_SERVICE_STOP_FAILED" "Port remains bound after service stop" @{ bind = $config.runtime.bind }
}
Write-Pass @{ service_name = $script:ServiceName; running = $false; port_released = $true }
