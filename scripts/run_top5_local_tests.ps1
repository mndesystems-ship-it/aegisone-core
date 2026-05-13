param(
  [switch]$SkipGenerate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$tests = @(
  "run_local_replay_consistency.ps1",
  "run_local_concurrency_storm.ps1",
  "run_local_malformed_input.ps1",
  "run_local_policy_trust.ps1",
  "run_local_proof_bundle_check.ps1"
)

$results = @()

foreach ($test in $tests) {
  $scriptPath = Join-Path $PSScriptRoot $test
  $args = @("-ExecutionPolicy", "Bypass", "-File", $scriptPath)
  if ($SkipGenerate) {
    $args += "-SkipGenerate"
  }

  $output = & powershell @args
  if ($LASTEXITCODE -ne 0) {
    throw "Top 5 local test run failed at $test"
  }

  $results += ($output | ConvertFrom-Json)
}

[ordered]@{
  ok = $true
  test_count = $results.Count
  tests = $results
} | ConvertTo-Json -Depth 8
