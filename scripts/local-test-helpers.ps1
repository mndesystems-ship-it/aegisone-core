Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-NodeTypeScript {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptPath,

    [string[]]$Arguments = @()
  )

  $repoRoot = Split-Path -Parent $PSScriptRoot
  $fullPath = Join-Path $repoRoot $ScriptPath
  & node --experimental-strip-types $fullPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: node --experimental-strip-types $ScriptPath"
  }
}

function Invoke-NpmScript {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  & npm.cmd run $Name
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: npm run $Name"
  }
}

function Read-JsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Assert-Equal {
  param(
    [Parameter(Mandatory = $true)]
    $Actual,

    [Parameter(Mandatory = $true)]
    $Expected,

    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  if ($Actual -ne $Expected) {
    throw "$Message. Expected '$Expected' but got '$Actual'."
  }
}

function Assert-True {
  param(
    [Parameter(Mandatory = $true)]
    [bool]$Condition,

    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Write-TestSummary {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TestName,

    [Parameter(Mandatory = $true)]
    [hashtable]$Summary
  )

  $payload = [ordered]@{
    test = $TestName
    ok = $true
    summary = $Summary
  }

  $payload | ConvertTo-Json -Depth 8
}
