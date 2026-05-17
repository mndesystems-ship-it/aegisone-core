param(
  [switch]$SkipGenerate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "local-test-helpers.ps1")

$repoRoot = Split-Path -Parent $PSScriptRoot
$reportPath = Join-Path $repoRoot "post-remediation-verification-bundle\post_verification_report.json"

if (-not $SkipGenerate) {
  Invoke-NpmScript -Name "audit"
  Invoke-NodeTypeScript -ScriptPath "audit/run_attack_wave.ts"
  Invoke-NodeTypeScript -ScriptPath "audit/run_remediation_wave.ts"
  Invoke-NodeTypeScript -ScriptPath "audit/run_post_remediation_verification.ts"
}

$report = Read-JsonFile -Path $reportPath
$concurrency = $report.concurrency_summary

Assert-Equal -Actual $report.executive_result.double_allow_count -Expected 0 -Message "Double allows detected"
Assert-Equal -Actual $concurrency.duplicate_allows -Expected 0 -Message "Concurrent duplicate allow detected"
Assert-Equal -Actual $concurrency.winner_count -Expected 100 -Message "Expected one winner per concurrency probe"
Assert-Equal -Actual $concurrency.loser_count -Expected 100 -Message "Expected one loser per concurrency probe"
Assert-Equal -Actual $concurrency.refusal_code_distribution.ERR_EXECUTION_ID_ALREADY_CONSUMED -Expected 100 -Message "Concurrency refusal code distribution regressed"

Write-TestSummary -TestName "concurrency_storm" -Summary @{
  total_tests_run = $report.executive_result.total_tests_run
  total_passed = $report.executive_result.total_passed
  duplicate_allows = $concurrency.duplicate_allows
  winner_count = $concurrency.winner_count
  loser_count = $concurrency.loser_count
  refusal_code = "ERR_EXECUTION_ID_ALREADY_CONSUMED"
}
