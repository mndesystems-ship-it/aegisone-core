Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

$attack = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "attack-wave-bundle\attack_wave_results.json") | ConvertFrom-Json
$remediation = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "remediation-wave-bundle\remediation_wave_results.json") | ConvertFrom-Json
$failureMode = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "audit-proof-bundle\failure_mode_report.json") | ConvertFrom-Json

$proofs = @(
  [ordered]@{
    test_name = "replay_consistency"
    input = "audit-proof-bundle/proof_bundle/failure_corrupted_entry.jsonl"
    refusal_code = "ERR_REPLAY_MISMATCH"
    reason = "Corrupted receipt entry fails exact replay equivalence and is recorded as a mismatch."
  }
  [ordered]@{
    test_name = "concurrency_storm"
    input = "TC-056 duplicate execution_id under double_run"
    refusal_code = "ERR_EXECUTION_ID_ALREADY_CONSUMED"
    reason = "The second concurrent claimant must lose and refuse once the shared execution_id is consumed."
  }
  [ordered]@{
    test_name = "malformed_input"
    input = "TC-046 malformed numeric edge case"
    refusal_code = "ERR_INVALID_JSON_NUMBER"
    reason = "Invalid numeric payloads fail at the parse boundary instead of being normalized."
  }
  [ordered]@{
    test_name = "policy_trust"
    input = "TC-070 delivered policy differs from signed canonical payload"
    refusal_code = "ERR_INVALID_POLICY_SIGNATURE"
    reason = "Policy trust verification must refuse when the signature covers different bytes than the delivered policy."
  }
  [ordered]@{
    test_name = "proof_bundle_check"
    input = "audit-proof-bundle/proof_bundle/failure_partial_write.jsonl"
    refusal_code = "ERR_RECEIPT_STREAM_TRUNCATED"
    reason = "Interrupted or partial receipt writes must fail closed during proof replay."
  }
)

$outputPath = Join-Path $repoRoot "external-review-drop\failure_proofs.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outputPath) | Out-Null
$proofs | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $outputPath
$proofs | ConvertTo-Json -Depth 5
