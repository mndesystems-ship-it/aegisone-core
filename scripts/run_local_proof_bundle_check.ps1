param(
  [switch]$SkipGenerate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "local-test-helpers.ps1")

$repoRoot = Split-Path -Parent $PSScriptRoot
$summaryPath = Join-Path $repoRoot "audit-proof-bundle\summary.json"
$parityPath = Join-Path $repoRoot "audit-proof-bundle\proof_bundle\parity_report.json"
$benchmarkSummaryPath = Join-Path $repoRoot "mnde-controlled-benchmark-bundle\summary.json"

if (-not $SkipGenerate) {
  Invoke-NpmScript -Name "audit"
  Invoke-NpmScript -Name "benchmark:mnde"
}

$summary = Read-JsonFile -Path $summaryPath
$parity = Read-JsonFile -Path $parityPath
$benchmark = Read-JsonFile -Path $benchmarkSummaryPath

Assert-Equal -Actual $summary.rejection_accuracy -Expected 100 -Message "Rejection accuracy regressed"
Assert-Equal -Actual $parity.mismatch_count -Expected 0 -Message "Cross-runtime parity mismatch detected"
Assert-Equal -Actual $benchmark.reproducibility.zero_drift -Expected $true -Message "Controlled benchmark drift regressed"
Assert-Equal -Actual $benchmark.reproducibility.zero_replay_mismatch -Expected $true -Message "Controlled benchmark replay mismatch regressed"
Assert-Equal -Actual $benchmark.before_vs_after.cost_control.cost_reduction_percent -Expected 98 -Message "Cost reduction benchmark regressed"

Write-TestSummary -TestName "proof_bundle_check" -Summary @{
  rejection_accuracy = $summary.rejection_accuracy
  parity_mismatch_count = $parity.mismatch_count
  controlled_zero_drift = $benchmark.reproducibility.zero_drift
  controlled_zero_replay_mismatch = $benchmark.reproducibility.zero_replay_mismatch
  cost_reduction_percent = $benchmark.before_vs_after.cost_control.cost_reduction_percent
}
