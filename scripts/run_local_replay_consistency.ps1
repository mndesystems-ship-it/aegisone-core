param(
  [switch]$SkipGenerate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "local-test-helpers.ps1")

$repoRoot = Split-Path -Parent $PSScriptRoot
$summaryPath = Join-Path $repoRoot "audit-proof-bundle\summary.json"
$replayPath = Join-Path $repoRoot "audit-proof-bundle\proof_bundle\replay_results.json"
$determinismPath = Join-Path $repoRoot "audit-proof-bundle\determinism_proof.json"

if (-not $SkipGenerate) {
  Invoke-NpmScript -Name "audit"
}

$summary = Read-JsonFile -Path $summaryPath
$replay = Read-JsonFile -Path $replayPath
$determinism = Read-JsonFile -Path $determinismPath

Assert-Equal -Actual $summary.determinism_mismatch_rate -Expected 0 -Message "Determinism mismatch rate regressed"
Assert-Equal -Actual $summary.replay_drift_rate -Expected 0 -Message "Replay drift rate regressed"
Assert-Equal -Actual $replay.drift_count -Expected 0 -Message "Replay drift count regressed"
Assert-Equal -Actual $determinism.mismatch_count -Expected 0 -Message "Determinism mismatch count regressed"

Write-TestSummary -TestName "replay_consistency" -Summary @{
  total_runs = $summary.total_runs
  determinism_mismatch_rate = $summary.determinism_mismatch_rate
  replay_drift_rate = $summary.replay_drift_rate
  replay_receipts = $replay.total_receipts
  determinism_mismatch_count = $determinism.mismatch_count
}
