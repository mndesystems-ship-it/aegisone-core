param(
  [string]$Label = "proof",
  [switch]$SkipGenerate,
  [switch]$SkipBenchmark
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "local-test-helpers.ps1")

$repoRoot = Split-Path -Parent $PSScriptRoot
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$captureRoot = Join-Path $repoRoot "external-review-drop\runs\$timestamp-$Label"

if (-not $SkipGenerate) {
  $null = & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "run_full_local_proof.ps1") @(
    $(if ($SkipBenchmark) { "-SkipBenchmark" })
  )
  if ($LASTEXITCODE -ne 0) {
    throw "Full local proof run failed."
  }
}

$sources = @(
  "stable-proof-bundle",
  "volatile-benchmark-bundle"
)

New-Item -ItemType Directory -Force -Path $captureRoot | Out-Null

foreach ($source in $sources) {
  $from = Join-Path $repoRoot $source
  $to = Join-Path $captureRoot $source
  Copy-Item -Recurse -Force -LiteralPath $from -Destination $to
}

$stableManifest = Join-Path $captureRoot "stable-proof-bundle\manifest.json"
$stableReceipts = Join-Path $captureRoot "stable-proof-bundle\receipts.jsonl"

$hashes = [ordered]@{
  timestamp = $timestamp
  label = $Label
  stable_manifest_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $stableManifest).Hash
  stable_receipts_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $stableReceipts).Hash
}

$hashes | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $captureRoot "capture_hashes.json")

$fileHashes = Get-ChildItem -Recurse -File -LiteralPath $captureRoot | ForEach-Object {
  [ordered]@{
    file = $_.FullName.Substring($captureRoot.Length + 1).Replace("\", "/")
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
    length = $_.Length
  }
}

$fileHashes | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $captureRoot "recursive_hashes.json")

[ordered]@{
  ok = $true
  capture_root = $captureRoot
  hashes = $hashes
} | ConvertTo-Json -Depth 6
