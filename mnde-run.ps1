param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $CommandArgs
)

$ErrorActionPreference = "Stop"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = $env:MNDE_NODE
if (-not $Node) {
  $Node = "node"
}

& $Node (Join-Path $ScriptRoot "mnde-run.mjs") @CommandArgs
exit $LASTEXITCODE
