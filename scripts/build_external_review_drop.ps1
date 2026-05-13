Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$dropRoot = Join-Path $repoRoot "external-review-drop"
$packageRoot = Join-Path $dropRoot "package"

New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

Copy-Item -Recurse -Force -LiteralPath (Join-Path $repoRoot "audit-proof-bundle") -Destination (Join-Path $packageRoot "audit-proof-bundle")
Copy-Item -Recurse -Force -LiteralPath (Join-Path $repoRoot "stable-proof-bundle") -Destination (Join-Path $packageRoot "stable-proof-bundle")
Copy-Item -Recurse -Force -LiteralPath (Join-Path $repoRoot "volatile-benchmark-bundle") -Destination (Join-Path $packageRoot "volatile-benchmark-bundle")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "TEST_MATRIX.md") -Destination (Join-Path $packageRoot "TEST_MATRIX.md")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "REVIEWER_PATH.md") -Destination (Join-Path $packageRoot "REVIEWER_PATH.md")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "SCOPED_POLICY_PROOF.md") -Destination (Join-Path $packageRoot "SCOPED_POLICY_PROOF.md")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "CLAIM.md") -Destination (Join-Path $packageRoot "CLAIM.md")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "external-review-drop\failure_proofs.json") -Destination (Join-Path $packageRoot "failure_proofs.json")

$hashManifest = [ordered]@{
  stable_manifest_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageRoot "stable-proof-bundle\manifest.json")).Hash
  stable_receipts_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageRoot "stable-proof-bundle\receipts.jsonl")).Hash
}

$hashManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $packageRoot "hashes.json")
$hashManifest | ConvertTo-Json -Depth 4
