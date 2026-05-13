param(
  [switch]$SkipBenchmark
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "local-test-helpers.ps1")

Invoke-NpmScript -Name "audit"
Invoke-NodeTypeScript -ScriptPath "audit/run_attack_wave.ts"
Invoke-NodeTypeScript -ScriptPath "audit/run_remediation_wave.ts"
Invoke-NodeTypeScript -ScriptPath "audit/run_post_remediation_verification.ts"
& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "emit_failure_proofs.ps1") | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failure proof generation failed."
}

if (-not $SkipBenchmark) {
  Invoke-NpmScript -Name "benchmark:mnde"
}

Invoke-NodeTypeScript -ScriptPath "scripts/build_scoped_bundles.ts"

& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "run_top5_local_tests.ps1") -SkipGenerate
if ($LASTEXITCODE -ne 0) {
  throw "Top 5 verification failed after proof run."
}
