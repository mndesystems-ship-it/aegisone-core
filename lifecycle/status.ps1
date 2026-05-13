. "$PSScriptRoot\common.ps1"

$service = Get-ServiceOrNull
$config = $null
$health = $null
$configOk = $true
try {
  if (Test-Path -LiteralPath $script:DefaultConfigPath) {
    $config = Get-Content -LiteralPath $script:DefaultConfigPath -Raw | ConvertFrom-Json
    $health = Invoke-Health -Config $config
  } else {
    $configOk = $false
  }
} catch {
  $configOk = $false
}

$manifest = $null
$installDir = $script:DefaultInstallDir
$verify = Join-Path $installDir "bin\verify-custody-release.cmd"
if (Test-Path -LiteralPath $verify) {
  $out = & $verify 2>$null
  $manifest = if ($LASTEXITCODE -eq 0) { "PASS" } else { "REFUSE" }
}

@{
  service_name = $script:ServiceName
  installed = [bool]$service
  running = ($service -and $service.Status -eq "Running")
  config_ok = $configOk
  health = $health
  active_policy_version = if ($health) { $health.active_policy_version } else { $null }
  policy_hash = if ($health) { $health.policy_hash } else { $null }
  manifest_integrity = $manifest
} | ConvertTo-Json -Depth 8
