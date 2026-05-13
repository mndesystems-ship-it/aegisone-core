param(
  [int]$Runs = 3,
  [int]$WarmupSeconds = 60,
  [int]$AnchorSamples = 500000,
  [int]$CostLatencySamples = 200000,
  [int]$AgentLatencySamples = 100000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runRoot = Join-Path $repoRoot "volatile-benchmark-bundle\runs"
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null

$artifacts = @(
  "summary.json",
  "latency_report.json",
  "latency_real_validation.json",
  "workload_manifest.json"
)

$rows = @()

for ($i = 1; $i -le $Runs; $i += 1) {
  $env:BENCHMARK_WARMUP_SECONDS = "$WarmupSeconds"
  $env:BENCHMARK_ANCHOR_SAMPLE_TARGET = "$AnchorSamples"
  $env:BENCHMARK_COST_LATENCY_SAMPLES = "$CostLatencySamples"
  $env:BENCHMARK_AGENT_LATENCY_SAMPLES = "$AgentLatencySamples"
  & npm.cmd run benchmark:mnde | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "benchmark:mnde failed on run $i"
  }

  $dest = Join-Path $runRoot ("run-" + $i)
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  foreach ($artifact in $artifacts) {
    Copy-Item -Force -LiteralPath (Join-Path $repoRoot "mnde-controlled-benchmark-bundle\$artifact") -Destination (Join-Path $dest $artifact)
  }

  $summary = Get-Content -Raw -LiteralPath (Join-Path $dest "summary.json") | ConvertFrom-Json
  $latency = Get-Content -Raw -LiteralPath (Join-Path $dest "latency_report.json") | ConvertFrom-Json
  $workload = Get-Content -Raw -LiteralPath (Join-Path $dest "workload_manifest.json") | ConvertFrom-Json

  $rows += [ordered]@{
    run = $i
    workload_hash = $workload.workload_hash
    anchor_hash = $workload.anchor_test.workload_hash
    anchor_throughput_rps = [double]$summary.anchor_reference.throughput_rps
    anchor_p99_ns = [double]$summary.anchor_reference.latency_ns.p99
    combined_p99_ns = [double]$latency.real_latency.combined_decision_layer.p99
  }
}

function Get-Median {
  param([double[]]$Values)
  $sorted = $Values | Sort-Object
  if ($sorted.Count -eq 0) { return 0 }
  $mid = [int]($sorted.Count / 2)
  if ($sorted.Count % 2 -eq 1) { return $sorted[$mid] }
  return ($sorted[$mid - 1] + $sorted[$mid]) / 2
}

function Get-SpreadPercent {
  param(
    [double[]]$Values,
    [double]$Median
  )
  if ($Median -eq 0) { return 0 }
  $maxDelta = 0.0
  foreach ($value in $Values) {
    $delta = [math]::Abs((($value - $Median) / $Median) * 100)
    if ($delta -gt $maxDelta) { $maxDelta = $delta }
  }
  return [math]::Round($maxDelta, 6)
}

$throughputValues = @($rows | ForEach-Object { [double]$_.anchor_throughput_rps })
$p99Values = @($rows | ForEach-Object { [double]$_.anchor_p99_ns })
$reportedP99Values = @($rows | ForEach-Object { [double]$_.combined_p99_ns })
$medianThroughput = Get-Median -Values $throughputValues
$spreadThroughput = Get-SpreadPercent -Values $throughputValues -Median $medianThroughput
$medianP99 = Get-Median -Values $p99Values
$spreadP99 = Get-SpreadPercent -Values $p99Values -Median $medianP99
$medianReportedP99 = Get-Median -Values $reportedP99Values
$spreadReportedP99 = Get-SpreadPercent -Values $reportedP99Values -Median $medianReportedP99
$sameWorkload = (@($rows | ForEach-Object { $_["workload_hash"] } | Sort-Object -Unique)).Count -eq 1
$sameAnchor = (@($rows | ForEach-Object { $_["anchor_hash"] } | Sort-Object -Unique)).Count -eq 1
$withinBand = $spreadThroughput -le 3 -and $spreadP99 -le 3

$report = [ordered]@{
  benchmark_environment = [ordered]@{
    preconditions = @(
      "same machine",
      "same Node runtime and flags",
      "background processes minimized",
      "fixed thermal state before run",
      "CPU governor pinned to performance when available"
    )
    monotonic_clock = "process.hrtime.bigint"
    warmup_window_seconds = $WarmupSeconds
    anchor_sample_target = $AnchorSamples
    cost_latency_samples = $CostLatencySamples
    agent_latency_samples = $AgentLatencySamples
    tolerance_percent = 3
    pass_definition = "within band across 3 consecutive runs"
  }
  anchor_test = [ordered]@{
    name = "mixed_50_50_allow_refuse"
    workload_hash = $rows[0]["anchor_hash"]
  }
  workload_hash = $rows[0]["workload_hash"]
  throughput = [ordered]@{
    median_rps = $medianThroughput
    spread_percent = $spreadThroughput
  }
  p99_latency = [ordered]@{
    median_ns = $medianP99
    spread_percent = $spreadP99
  }
  combined_decision_layer_p99 = [ordered]@{
    median_ns = $medianReportedP99
    spread_percent = $spreadReportedP99
  }
  same_workload_across_runs = $sameWorkload
  same_anchor_across_runs = $sameAnchor
  within_band = $withinBand
  runs = $rows
}

$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $repoRoot "volatile-benchmark-bundle\benchmark_consistency_report.json")
$report | ConvertTo-Json -Depth 8
