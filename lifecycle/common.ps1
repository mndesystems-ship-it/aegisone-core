$ErrorActionPreference = "Stop"

$script:ServiceName = "MNDeCustody"
$script:DefaultInstallDir = Join-Path $env:ProgramFiles "MNDe\custody"
$script:DefaultDataDir = Join-Path $env:ProgramData "MNDe"
$script:DefaultConfigPath = Join-Path $script:DefaultDataDir "config\custody.config.json"
$script:DefaultRuntimeLog = Join-Path $script:DefaultDataDir "logs\runtime.log"
$script:DefaultInstallLog = Join-Path $script:DefaultDataDir "logs\install.log"

function Write-TypedFailure {
  param([string]$Code, [string]$Message, [hashtable]$Extra = @{})
  $payload = @{ verdict = "REFUSE"; reason_code = $Code; error = $Message }
  foreach ($key in $Extra.Keys) { $payload[$key] = $Extra[$key] }
  $payload | ConvertTo-Json -Depth 8
  exit 1
}

function Write-Pass {
  param([hashtable]$Payload = @{})
  $out = @{ verdict = "PASS" }
  foreach ($key in $Payload.Keys) { $out[$key] = $Payload[$key] }
  $out | ConvertTo-Json -Depth 8
}

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-PackageRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Read-CustodyConfig {
  param([string]$ConfigPath = $script:DefaultConfigPath)
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-TypedFailure "ERR_INVALID_CONFIG" "Config file not found" @{ field = "config"; path = $ConfigPath }
  }
  try {
    return Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  } catch {
    Write-TypedFailure "ERR_INVALID_CONFIG" "Config JSON parse failed: $($_.Exception.Message)" @{ field = "config"; path = $ConfigPath }
  }
}

function Get-BindUri {
  param($Config, [string]$Path = "/readyz")
  $bind = [string]$Config.runtime.bind
  return "http://$bind$Path"
}

function Test-PortClosed {
  param($Config)
  $bind = [string]$Config.runtime.bind
  $parts = $bind.Split(":")
  $port = [int]$parts[$parts.Length - 1]
  $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  return $null -eq $connections
}

function Get-ServiceOrNull {
  return Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue
}

function Invoke-Health {
  param($Config)
  $readyPath = if ($Config.runtime.ready_path) { [string]$Config.runtime.ready_path } else { "/readyz" }
  $uri = Get-BindUri -Config $Config -Path $readyPath
  try {
    return Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 2
  } catch {
    return $null
  }
}
