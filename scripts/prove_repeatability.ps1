param(
  [switch]$SkipBenchmark
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$firstJson = & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "capture_timestamped_bundle.ps1") -Label "run1" @(
  $(if ($SkipBenchmark) { "-SkipBenchmark" })
)
if ($LASTEXITCODE -ne 0) {
  throw "First capture failed."
}

$secondJson = & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "capture_timestamped_bundle.ps1") -Label "run2" @(
  $(if ($SkipBenchmark) { "-SkipBenchmark" })
)
if ($LASTEXITCODE -ne 0) {
  throw "Second capture failed."
}

$first = $firstJson | ConvertFrom-Json
$second = $secondJson | ConvertFrom-Json

$firstHashes = Get-Content -Raw -LiteralPath (Join-Path $first.capture_root "recursive_hashes.json") | ConvertFrom-Json
$secondHashes = Get-Content -Raw -LiteralPath (Join-Path $second.capture_root "recursive_hashes.json") | ConvertFrom-Json

$firstMap = @{}
foreach ($row in $firstHashes) {
  $firstMap[$row.file] = "$($row.sha256):$($row.length)"
}

$mismatches = @()
foreach ($row in $secondHashes) {
  $expected = $firstMap[$row.file]
  $actual = "$($row.sha256):$($row.length)"
  if ($expected -ne $actual) {
    $mismatches += [ordered]@{
      file = $row.file
      first = $expected
      second = $actual
    }
  }
}

$stableMismatches = @($mismatches | Where-Object { $_.file -like "stable-proof-bundle/*" })

$firstValidation = Get-Content -Raw -LiteralPath (Join-Path $first.capture_root "volatile-benchmark-bundle\benchmark_validation.json") | ConvertFrom-Json
$secondValidation = Get-Content -Raw -LiteralPath (Join-Path $second.capture_root "volatile-benchmark-bundle\benchmark_validation.json") | ConvertFrom-Json

function Percent-Delta {
  param(
    [double]$First,
    [double]$Second
  )

  if ($First -eq 0) {
    return 0
  }

  return [math]::Abs((($Second - $First) / $First) * 100)
}

$throughputDeltas = @()
foreach ($metric in $firstValidation.metrics.throughput_rps) {
  $match = $secondValidation.metrics.throughput_rps | Where-Object { $_.profile -eq $metric.profile } | Select-Object -First 1
  $throughputDeltas += [ordered]@{
    profile = $metric.profile
    delta_percent = [math]::Round((Percent-Delta -First ([double]$metric.throughput_rps) -Second ([double]$match.throughput_rps)), 6)
  }
}

$latencyDeltas = @()
foreach ($metric in $firstValidation.metrics.latency_p99_ms) {
  $match = $secondValidation.metrics.latency_p99_ms | Where-Object { $_.profile -eq $metric.profile } | Select-Object -First 1
  $latencyDeltas += [ordered]@{
    profile = $metric.profile
    delta_percent = [math]::Round((Percent-Delta -First ([double]$metric.p99) -Second ([double]$match.p99)), 6)
  }
}

$throughputWithinBand = (@($throughputDeltas | Where-Object { $_.delta_percent -gt 3 })).Count -eq 0
$latencyWithinBand = (@($latencyDeltas | Where-Object { $_.delta_percent -gt 3 })).Count -eq 0

$stableHashPath = Join-Path $first.capture_root "stable-proof-bundle\hashes.json"
$stableHashes = Get-Content -Raw -LiteralPath $stableHashPath | ConvertFrom-Json

[ordered]@{
  ok = ($stableMismatches.Count -eq 0)
  first_capture = $first.capture_root
  second_capture = $second.capture_root
  scoped_reproducibility = "stable-proof-bundle only"
  stable_bundle_byte_equality = ($stableMismatches.Count -eq 0)
  stable_manifest_hashes_match = ($first.hashes.stable_manifest_sha256 -eq $second.hashes.stable_manifest_sha256)
  stable_receipts_hashes_match = ($first.hashes.stable_receipts_sha256 -eq $second.hashes.stable_receipts_sha256)
  stable_manifest_sha256 = $stableHashes.stable_manifest_sha256
  stable_receipts_sha256 = $stableHashes.stable_receipts_sha256
  throughput_within_band = $throughputWithinBand
  latency_p99_within_band = $latencyWithinBand
  throughput_deltas = $throughputDeltas
  latency_p99_deltas = $latencyDeltas
  stable_mismatches = $stableMismatches
} | ConvertTo-Json -Depth 8
