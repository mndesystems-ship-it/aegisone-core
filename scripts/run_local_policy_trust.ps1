param(
  [switch]$SkipGenerate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "local-test-helpers.ps1")

$repoRoot = Split-Path -Parent $PSScriptRoot
$reportPath = Join-Path $repoRoot "remediation-wave-bundle\remediation_wave_results.json"

if (-not $SkipGenerate) {
  Invoke-NodeTypeScript -ScriptPath "audit/run_remediation_wave.ts"
}

$report = Read-JsonFile -Path $reportPath
$policyCases = @("TC-068", "TC-069", "TC-070")
$cases = foreach ($caseId in $policyCases) {
  $match = $report.cases | Where-Object { $_.test_id -eq $caseId } | Select-Object -First 1
  Assert-True -Condition ($null -ne $match) -Message "Expected $caseId in remediation wave report"
  $match
}

foreach ($case in $cases) {
  Assert-Equal -Actual $case.status -Expected "PASS" -Message "Policy trust case $($case.test_id) failed"
}

Assert-Equal -Actual $report.summary.fail_count -Expected 0 -Message "Remediation wave contains failures"

Write-TestSummary -TestName "policy_trust" -Summary @{
  total_cases = $report.summary.total_cases
  fail_count = $report.summary.fail_count
  checked_cases = @(
    @{ test_id = "TC-068"; reason = "ERR_POLICY_VERSION_MISMATCH" }
    @{ test_id = "TC-069"; reason = "ERR_POLICY_KEY_ID_MISMATCH" }
    @{ test_id = "TC-070"; reason = "ERR_INVALID_POLICY_SIGNATURE" }
  )
}
