param(
  [switch]$SkipGenerate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "local-test-helpers.ps1")

$repoRoot = Split-Path -Parent $PSScriptRoot
$schemaPath = Join-Path $repoRoot "audit-proof-bundle\schema_enforcement_report.json"
$attackWavePath = Join-Path $repoRoot "attack-wave-bundle\attack_wave_results.json"

if (-not $SkipGenerate) {
  Invoke-NpmScript -Name "audit"
  Invoke-NpmScript -Name "test:regression"
}

$schema = Read-JsonFile -Path $schemaPath
$attackWave = Read-JsonFile -Path $attackWavePath

$invalidJsonCase = $attackWave.cases | Where-Object { $_.test_id -eq "TC-058" } | Select-Object -First 1

Assert-True -Condition ($null -ne $invalidJsonCase) -Message "Expected TC-058 in attack wave results"
Assert-Equal -Actual $schema.incorrect_accept_rate -Expected 0 -Message "Incorrect malformed-input accepts detected"
Assert-Equal -Actual $schema.target_full_rejection -Expected $true -Message "Malformed-input rejection target regressed"
Assert-Equal -Actual $invalidJsonCase.status -Expected "PASS" -Message "Typed failure regression case failed"
Assert-Equal -Actual $invalidJsonCase.actual_reason_code -Expected "ERR_BUDGET_TOKEN_EXHAUSTED" -Message "Typed failure reason code regressed"

Write-TestSummary -TestName "malformed_input" -Summary @{
  total_invalid_inputs = $schema.total_invalid_inputs
  incorrect_accept_rate = $schema.incorrect_accept_rate
  target_full_rejection = $schema.target_full_rejection
  regression_case = $invalidJsonCase.test_id
  regression_reason_code = $invalidJsonCase.actual_reason_code
}
