param([switch]$RemoveData)
. "$PSScriptRoot\common.ps1"

if (-not (Test-IsAdmin)) { Write-TypedFailure "ERR_UNINSTALL_FAILED" "Run uninstall.cmd from an elevated prompt" }
try {
  $service = Get-ServiceOrNull
  if ($service) {
    if ($service.Status -ne "Stopped") { Stop-Service -Name $script:ServiceName -Force -ErrorAction SilentlyContinue; $service.WaitForStatus("Stopped", "00:00:30") }
    sc.exe delete $script:ServiceName | Out-Null
  }
  if (Test-Path -LiteralPath $script:DefaultInstallDir) { Remove-Item -Recurse -Force -LiteralPath $script:DefaultInstallDir }
  if ($RemoveData -and (Test-Path -LiteralPath $script:DefaultDataDir)) { Remove-Item -Recurse -Force -LiteralPath $script:DefaultDataDir }
} catch {
  Write-TypedFailure "ERR_UNINSTALL_FAILED" $_.Exception.Message
}
Write-Pass @{ service_name = $script:ServiceName; binaries_removed = $true; data_removed = [bool]$RemoveData }
