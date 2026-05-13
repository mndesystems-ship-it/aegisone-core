import { join } from "path";
import { readFileSync, writeFileSync } from "fs";
import type { JsonValue } from "../shared/json.ts";
import { canonicalizeJson } from "../shared/json.ts";
import {
  appendReceipts,
  ensureDir,
  executeDeterministicPipeline,
  hashFileArtifact,
  makeBaseInput,
  rawJson,
  resetRuntimeState,
  replayReceiptStore,
  writeJsonArtifact
} from "./node_runtime.ts";
import type { SignedReceipt } from "./types.ts";
import {
  buildBenchmarkMatrix,
  buildCanonicalVariant,
  buildMatrixReport,
  canonicalBytes,
  ensureOutputDirs,
  FULL_LOGS_DIR,
  getCanonicalizationBaseCases,
  OUTPUT_DIR,
  PARITY_VECTOR_PATH,
  PROFILE_ORDER,
  PROOF_BUNDLE_DIR,
  RECEIPT_PATH,
  writeParityVectors
} from "./harness.ts";

type PipelineOutcome = {
  output_bytes: string;
  decision: "ALLOW" | "REFUSE";
  decision_hash: string;
  receipt_signature: string | null;
  reason_code: string;
  valid_receipt: boolean;
  receipt?: SignedReceipt;
};

type DeterminismMismatch = {
  case_id: string;
  profile: string;
  run_index: number;
  field: string;
  expected: string | null;
  actual: string | null;
  raw_input: string;
};

const DETERMINISM_REPETITIONS = 1000;
const PERFORMANCE_RUNS_PER_PROFILE = 1000;
const PERFORMANCE_SAMPLE_STEP = 25;
const BENCHMARK_TIMESTAMP = new Date().toISOString();

function executeOutcome(rawInput: string): PipelineOutcome {
  resetRuntimeState();
  const result = executeDeterministicPipeline(rawInput);
  if ("parse_boundary" in result) {
    return {
      output_bytes: canonicalizeJson(result as unknown as JsonValue),
      decision: result.decision,
      decision_hash: result.decision_hash,
      receipt_signature: null,
      reason_code: result.reason_code,
      valid_receipt: false
    };
  }

  return {
    output_bytes: result.receipt_bytes,
    decision: result.receipt.decision_output.decision,
    decision_hash: result.receipt.decision_output.decision_hash,
    receipt_signature: result.receipt.signature.value,
    reason_code: result.receipt.decision_output.reason_code,
    valid_receipt: true,
    receipt: result.receipt
  };
}

function writeJsonl(path: string, items: unknown[]): void {
  const lines = items.map((item) => JSON.stringify(item));
  writeFileSync(path, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf8");
}

function percent(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }
  return Number(((numerator / denominator) * 100).toFixed(6));
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio));
  return Number(sorted[index].toFixed(6));
}

function performancePercentDifference(sut: number, baseline: number): number {
  if (baseline === 0) {
    return 0;
  }
  return Number((((sut - baseline) / baseline) * 100).toFixed(6));
}

function measurePerformance(name: string, inputs: string[], runner: (rawInput: string) => unknown) {
  const latenciesMs: number[] = [];
  let peakRss = process.memoryUsage().rss;
  let peakHeapUsed = process.memoryUsage().heapUsed;
  const cpuStart = process.cpuUsage();
  const start = process.hrtime.bigint();

  for (let index = 0; index < PERFORMANCE_RUNS_PER_PROFILE; index += 1) {
    const rawInput = inputs[index % inputs.length];
    const runStart = process.hrtime.bigint();
    runner(rawInput);
    const runEnd = process.hrtime.bigint();
    latenciesMs.push(Number(runEnd - runStart) / 1_000_000);
    if (index % PERFORMANCE_SAMPLE_STEP === 0) {
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  const cpu = process.cpuUsage(cpuStart);

  return {
    name,
    runs: PERFORMANCE_RUNS_PER_PROFILE,
    throughput_rps: Number(((PERFORMANCE_RUNS_PER_PROFILE * 1000) / elapsedMs).toFixed(6)),
    latency_ms: {
      p50: percentile(latenciesMs, 0.5),
      p95: percentile(latenciesMs, 0.95),
      p99: percentile(latenciesMs, 0.99)
    },
    cpu_usage: {
      user_microseconds: cpu.user,
      system_microseconds: cpu.system,
      normalized_percent: Number((((cpu.user + cpu.system) / 1000 / elapsedMs) * 100).toFixed(6))
    },
    memory_usage: {
      peak_rss_bytes: peakRss,
      peak_heap_used_bytes: peakHeapUsed
    }
  };
}

function executeBaseline(rawInput: string) {
  try {
    const parsed = JSON.parse(rawInput) as Record<string, any>;
    const executionRequest = parsed.execution_request;
    const policyDocument = parsed.policy_document;
    const pricingData = parsed.pricing_data;
    if (!executionRequest || !policyDocument || !pricingData) {
      return { decision: "REFUSE", reason_code: "ERR_SCHEMA" };
    }
    const resources = executionRequest.resources ?? {};
    const execution = executionRequest.execution ?? {};
    const release = executionRequest.release_request ?? {};
    const runtime = executionRequest.runtime_observation ?? {};
    const rules = policyDocument.rules ?? {};

    const gpuCount = Number(resources.gpu_count ?? 0);
    const hours = Number(resources.hours ?? 0);
    const rate = Number(pricingData.gpu_hour_cents ?? 0);
    const scaleMultiplier = execution.auto_scale ? Number(execution.max_scale_multiplier ?? 1) : 1;
    const retryMultiplier = execution.retry_on_fail ? Number(execution.max_retries ?? 0) + 1 : 1;
    const projected = gpuCount * hours * rate * scaleMultiplier * retryMultiplier;

    if (release.already_consumed) {
      return { decision: "REFUSE", reason_code: "ERR_RELEASE_ALREADY_CONSUMED" };
    }
    if (gpuCount > Number(rules.max_gpu_count ?? 0)) {
      return { decision: "REFUSE", reason_code: "ERR_GPU_LIMIT" };
    }
    if (hours > Number(rules.max_hours ?? 0)) {
      return { decision: "REFUSE", reason_code: "ERR_HOURS_LIMIT" };
    }
    if (projected > Number(rules.max_total_cost_cents ?? 0)) {
      return { decision: "REFUSE", reason_code: "ERR_COST_LIMIT" };
    }
    if (projected > Number(rules.require_manual_approval_above_cents ?? 0) && release.hold_state !== "APPROVED") {
      return { decision: "REFUSE", reason_code: "ERR_MANUAL_APPROVAL_REQUIRED" };
    }
    if (runtime.kill_switch_active) {
      return { decision: "REFUSE", reason_code: "ERR_KILL_SWITCH" };
    }
    return { decision: "ALLOW", reason_code: "OK_ALLOW" };
  } catch {
    return { decision: "REFUSE", reason_code: "ERR_PARSE" };
  }
}

function categoryForMalformed(caseId: string): string {
  const index = Number(caseId.split("-").at(-1) ?? "0");
  const category = index % 6;
  if (category === 0) {
    return "duplicate_keys";
  }
  if (category === 1) {
    return "unknown_fields";
  }
  if (category === 2) {
    return "missing_required_fields";
  }
  if (category === 3) {
    return "float_overflow";
  }
  if (category === 4) {
    return "invalid_integers";
  }
  return "malformed_json";
}

function buildFailureModeReport(validReceipt: SignedReceipt, secondReceipt: SignedReceipt) {
  const goodLine = canonicalizeJson(validReceipt as unknown as JsonValue);
  const secondLine = canonicalizeJson(secondReceipt as unknown as JsonValue);

  const partialPath = join(PROOF_BUNDLE_DIR, "failure_partial_write.jsonl");
  writeFileSync(partialPath, `${goodLine.slice(0, Math.floor(goodLine.length / 2))}\n`, "utf8");
  const partialReplay = replayReceiptStore(partialPath);

  const concurrentPath = join(PROOF_BUNDLE_DIR, "failure_concurrent_write.jsonl");
  const interleaved = `${goodLine.slice(0, 128)}${secondLine.slice(0, 128)}\n`;
  writeFileSync(concurrentPath, interleaved, "utf8");
  const concurrentReplay = replayReceiptStore(concurrentPath);

  const corruptedPath = join(PROOF_BUNDLE_DIR, "failure_corrupted_entry.jsonl");
  const corruptedReceipt = JSON.parse(goodLine) as SignedReceipt;
  corruptedReceipt.signature.value = `ff${corruptedReceipt.signature.value.slice(2)}`;
  writeFileSync(corruptedPath, `${canonicalizeJson(corruptedReceipt as unknown as JsonValue)}\n`, "utf8");
  const corruptedReplay = replayReceiptStore(corruptedPath);

  const interruptedPath = join(PROOF_BUNDLE_DIR, "failure_interrupted_execution.jsonl");
  writeFileSync(interruptedPath, goodLine.slice(0, Math.floor(goodLine.length * 0.67)), "utf8");
  const interruptedReplay = replayReceiptStore(interruptedPath);

  const clockBase = rawJson(makeBaseInput() as unknown as JsonValue);
  process.env.BUILD_TIMESTAMP_UTC = "1970-01-01T00:00:00.000Z";
  const clockA = executeOutcome(clockBase);
  process.env.BUILD_TIMESTAMP_UTC = "2099-12-31T23:59:59.000Z";
  const clockB = executeOutcome(clockBase);

  return {
    schema_version: "ecs.audit.failure_mode_report.v1",
    cases: [
      {
        case_id: "partial_writes",
        fails_closed: partialReplay.exact_matches === 0 && partialReplay.mismatches.length > 0,
        total_entries: partialReplay.total,
        mismatches: partialReplay.mismatches
      },
      {
        case_id: "concurrent_writes",
        fails_closed: concurrentReplay.exact_matches === 0 && concurrentReplay.mismatches.length > 0,
        total_entries: concurrentReplay.total,
        mismatches: concurrentReplay.mismatches
      },
      {
        case_id: "corrupted_entries",
        fails_closed: corruptedReplay.exact_matches === 0 && corruptedReplay.mismatches.length > 0,
        total_entries: corruptedReplay.total,
        mismatches: corruptedReplay.mismatches
      },
      {
        case_id: "clock_skew",
        fails_closed: clockA.output_bytes === clockB.output_bytes,
        total_entries: 2,
        mismatches: []
      },
      {
        case_id: "interrupted_execution",
        fails_closed: interruptedReplay.exact_matches === 0 && interruptedReplay.mismatches.length > 0,
        total_entries: interruptedReplay.total,
        mismatches: interruptedReplay.mismatches
      }
    ]
  };
}

function buildCostImpactReport() {
  const workloads = [
    {
      case_id: "gpu_jobs",
      input: makeBaseInput({
        execution_request: {
          request_id: "cost-gpu-jobs",
          resources: { gpu_type: "h100", gpu_count: 64, hours: 24 },
          runtime_observation: { kill_switch_active: false, actual_gpu_count: 64, actual_hours: 24, actual_total_cost_cents: 768000 }
        }
      })
    },
    {
      case_id: "autoscaling_loops",
      input: makeBaseInput({
        execution_request: {
          request_id: "cost-autoscale",
          execution: { auto_scale: true, max_scale_multiplier: 24, retry_on_fail: false, max_retries: 0 },
          runtime_observation: { kill_switch_active: false, actual_gpu_count: 2, actual_hours: 4, actual_total_cost_cents: 4000 }
        }
      })
    },
    {
      case_id: "retry_storms",
      input: makeBaseInput({
        execution_request: {
          request_id: "cost-retry",
          execution: { auto_scale: false, max_scale_multiplier: 1, retry_on_fail: true, max_retries: 14 },
          runtime_observation: { kill_switch_active: false, actual_gpu_count: 2, actual_hours: 4, actual_total_cost_cents: 4000 }
        }
      })
    }
  ];

  const cases = workloads.map((workload) => {
    const result = executeOutcome(rawJson(workload.input as unknown as JsonValue));
    const projectedCost = workload.input.execution_request.resources.gpu_count *
      workload.input.execution_request.resources.hours *
      workload.input.pricing_data.gpu_hour_cents *
      (workload.input.execution_request.execution.auto_scale
        ? workload.input.execution_request.execution.max_scale_multiplier
        : 1) *
      (workload.input.execution_request.execution.retry_on_fail
        ? workload.input.execution_request.execution.max_retries + 1
        : 1);
    const allowedCost = Math.min(projectedCost, workload.input.policy_document.rules.max_total_cost_cents);
    return {
      case_id: workload.case_id,
      total_projected_cost_cents: projectedCost,
      allowed_cost_cents: allowedCost,
      prevented_cost_cents: projectedCost - allowedCost,
      decision: result.decision,
      reason_code: result.reason_code
    };
  });

  return {
    schema_version: "ecs.audit.cost_impact_report.v1",
    cases,
    aggregate_prevented_spend_cents: cases.reduce((sum, item) => sum + item.prevented_cost_cents, 0)
  };
}

function buildBenchmarkReportMarkdown(summary: Record<string, any>, performance: Record<string, any>) {
  const lines = [
    "# benchmark_report",
    "",
    `generated_at: ${BENCHMARK_TIMESTAMP}`,
    `total_runs: ${summary.total_runs}`,
    `determinism_mismatch_rate: ${summary.determinism_mismatch_rate}`,
    `parity_mismatch_rate: ${summary.parity_mismatch_rate}`,
    `replay_drift_rate: ${summary.replay_drift_rate}`,
    `rejection_accuracy: ${summary.rejection_accuracy}`,
    "",
    "| profile | throughput_rps | p50_ms | p95_ms | p99_ms | cpu_percent | peak_rss_bytes | baseline_throughput_delta_percent | baseline_p95_delta_percent |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];

  for (const profile of PROFILE_ORDER) {
    const item = performance.profiles.find((entry: any) => entry.profile === profile);
    lines.push(
      `| ${profile} | ${item.sut.throughput_rps} | ${item.sut.latency_ms.p50} | ${item.sut.latency_ms.p95} | ${item.sut.latency_ms.p99} | ${item.sut.cpu_usage.normalized_percent} | ${item.sut.memory_usage.peak_rss_bytes} | ${item.delta_percent.throughput_rps} | ${item.delta_percent.p95_latency_ms} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  ensureOutputDirs();
  ensureDir(OUTPUT_DIR);
  ensureDir(FULL_LOGS_DIR);
  ensureDir(PROOF_BUNDLE_DIR);

  const allCases = buildBenchmarkMatrix();
  writeParityVectors(allCases);
  writeJsonArtifact(join(OUTPUT_DIR, "test_matrix.json"), buildMatrixReport(allCases) as unknown as JsonValue);

  const mismatchLogs: DeterminismMismatch[] = [];
  const baselineReceipts: SignedReceipt[] = [];
  let determinismRuns = 0;
  let determinismMismatches = 0;
  const profileMismatchCounts: Record<string, number> = {};

  for (const profile of PROFILE_ORDER) {
    profileMismatchCounts[profile] = 0;
  }

  for (const testCase of allCases) {
    const baseline = executeOutcome(testCase.raw_input);
    determinismRuns += 1;
    if (baseline.valid_receipt && baseline.receipt) {
      baselineReceipts.push(baseline.receipt);
    }

    for (let runIndex = 1; runIndex < DETERMINISM_REPETITIONS; runIndex += 1) {
      const next = executeOutcome(testCase.raw_input);
      determinismRuns += 1;

      if (next.output_bytes !== baseline.output_bytes) {
        determinismMismatches += 1;
        profileMismatchCounts[testCase.profile] += 1;
        if (mismatchLogs.length < 25) {
          mismatchLogs.push({
            case_id: testCase.case_id,
            profile: testCase.profile,
            run_index: runIndex,
            field: "output_bytes",
            expected: baseline.output_bytes,
            actual: next.output_bytes,
            raw_input: testCase.raw_input
          });
        }
        continue;
      }
      if (next.decision !== baseline.decision) {
        determinismMismatches += 1;
        profileMismatchCounts[testCase.profile] += 1;
      } else if (next.decision_hash !== baseline.decision_hash) {
        determinismMismatches += 1;
        profileMismatchCounts[testCase.profile] += 1;
      } else if (next.receipt_signature !== baseline.receipt_signature) {
        determinismMismatches += 1;
        profileMismatchCounts[testCase.profile] += 1;
      }
    }
  }

  appendReceipts(RECEIPT_PATH, baselineReceipts);
  writeJsonl(join(FULL_LOGS_DIR, "determinism_failures.jsonl"), mismatchLogs);

  const determinismReport = {
    schema_version: "ecs.audit.determinism_report.v2",
    total_runs: determinismRuns,
    mismatch_count: determinismMismatches,
    mismatch_percentage: percent(determinismMismatches, determinismRuns),
    target_zero_mismatches: determinismMismatches === 0,
    profiles: PROFILE_ORDER.map((profile) => ({
      profile,
      mismatch_count: profileMismatchCounts[profile],
      mismatch_percentage: percent(profileMismatchCounts[profile], VALID_PROFILE_RUNS(profile))
    })),
    minimal_failing_cases: mismatchLogs
  };
  writeJsonArtifact(join(OUTPUT_DIR, "determinism_proof.json"), determinismReport as unknown as JsonValue);

  const invalidCases = allCases.filter((item) => !item.expected_valid);
  const invalidAccepts: Array<Record<string, string>> = [];
  const categoryStats: Record<string, { total: number; rejected: number; incorrect_accepts: number }> = {};

  for (const testCase of invalidCases) {
    const category = categoryForMalformed(testCase.case_id);
    categoryStats[category] ??= { total: 0, rejected: 0, incorrect_accepts: 0 };
    categoryStats[category].total += 1;
    const outcome = executeOutcome(testCase.raw_input);
    if (outcome.decision === "REFUSE") {
      categoryStats[category].rejected += 1;
    } else {
      categoryStats[category].incorrect_accepts += 1;
      invalidAccepts.push({
        case_id: testCase.case_id,
        category,
        raw_input: testCase.raw_input
      });
    }
  }

  writeJsonArtifact(
    join(OUTPUT_DIR, "schema_enforcement_report.json"),
    {
      schema_version: "ecs.audit.schema_enforcement_report.v1",
      total_invalid_inputs: invalidCases.length,
      rejection_rate: percent(
        Object.values(categoryStats).reduce((sum, item) => sum + item.rejected, 0),
        invalidCases.length
      ),
      incorrect_accept_rate: percent(invalidAccepts.length, invalidCases.length),
      target_full_rejection: invalidAccepts.length === 0,
      categories: Object.entries(categoryStats).map(([category, stats]) => ({
        category,
        total: stats.total,
        rejected: stats.rejected,
        rejection_rate: percent(stats.rejected, stats.total),
        incorrect_accepts: stats.incorrect_accepts
      })),
      incorrect_accept_cases: invalidAccepts
    } as unknown as JsonValue
  );
  writeJsonl(join(FULL_LOGS_DIR, "schema_incorrect_accepts.jsonl"), invalidAccepts);

  const canonicalizationBases = getCanonicalizationBaseCases(allCases);
  const canonicalizationFailures: Array<Record<string, string>> = [];
  let divergenceCount = 0;
  let canonicalizationRuns = 0;

  for (const baseCase of canonicalizationBases) {
    const baseline = executeOutcome(baseCase.raw_input);
    const baselineCanonical = canonicalBytes(JSON.parse(baseCase.raw_input) as JsonValue);
    for (let variantIndex = 0; variantIndex < 50; variantIndex += 1) {
      const rawVariant = buildCanonicalVariant(baseCase, variantIndex);
      const variantOutcome = executeOutcome(rawVariant);
      const variantCanonical = canonicalBytes(JSON.parse(rawVariant) as JsonValue);
      canonicalizationRuns += 1;
      if (baselineCanonical !== variantCanonical || baseline.decision_hash !== variantOutcome.decision_hash) {
        divergenceCount += 1;
        if (canonicalizationFailures.length < 50) {
          canonicalizationFailures.push({
            case_id: baseCase.case_id,
            variant_index: String(variantIndex),
            base_decision_hash: baseline.decision_hash,
            variant_decision_hash: variantOutcome.decision_hash
          });
        }
      }
    }
  }

  writeJsonArtifact(
    join(OUTPUT_DIR, "canonicalization_attack_report.json"),
    {
      schema_version: "ecs.audit.canonicalization_report.v1",
      base_case_count: canonicalizationBases.length,
      variants_per_case: 50,
      total_variants: canonicalizationRuns,
      divergence_count: divergenceCount,
      divergence_rate: percent(divergenceCount, canonicalizationRuns),
      failures: canonicalizationFailures
    } as unknown as JsonValue
  );
  writeJsonl(join(FULL_LOGS_DIR, "canonicalization_failures.jsonl"), canonicalizationFailures);

  const replayStore = replayReceiptStore(RECEIPT_PATH);
  const replayReport = {
    schema_version: "ecs.audit.replay_report.v2",
    total_receipts: replayStore.total,
    exact_matches: replayStore.exact_matches,
    drift_count: replayStore.mismatches.length,
    replay_drift_rate: percent(replayStore.mismatches.length, replayStore.total),
    mismatches: replayStore.mismatches
  };
  writeJsonArtifact(join(PROOF_BUNDLE_DIR, "replay_results.json"), replayReport as unknown as JsonValue);
  writeJsonl(join(FULL_LOGS_DIR, "replay_failures.jsonl"), replayStore.mismatches);

  const rustOutputPath = process.env.RUST_PARITY_OUTPUT_PATH;
  if (!rustOutputPath) {
    throw new Error("RUST_PARITY_OUTPUT_PATH is required");
  }
  const rustOutputs = JSON.parse(readFileSync(rustOutputPath, "utf8")) as Array<{
    case_id: string;
    receipt_bytes: string;
    decision_hash: string;
    decision: string;
  }>;
  const parityVectors = JSON.parse(readFileSync(PARITY_VECTOR_PATH, "utf8")) as Array<{ case_id: string; raw_input: string }>;
  const parityFailures: Array<Record<string, string | boolean>> = [];
  const parityCases = parityVectors.map((vector, index) => {
    const nodeOutcome = executeOutcome(vector.raw_input);
    const rustOutcome = rustOutputs[index];
    const nodeReceipt = nodeOutcome.receipt ? JSON.parse(nodeOutcome.output_bytes) as SignedReceipt : null;
    const rustReceipt = JSON.parse(rustOutcome.receipt_bytes) as Partial<SignedReceipt>;
    const caseResult = {
      case_id: vector.case_id,
      receipt_bytes_identical: nodeOutcome.output_bytes === rustOutcome.receipt_bytes,
      decision_hash_identical: nodeOutcome.decision_hash === rustOutcome.decision_hash,
      signature_identical: (nodeReceipt?.signature.value ?? null) === (rustReceipt.signature?.value ?? null)
    };
    if (!caseResult.receipt_bytes_identical || !caseResult.decision_hash_identical || !caseResult.signature_identical) {
      parityFailures.push(caseResult);
    }
    return caseResult;
  });
  const parityReport = {
    schema_version: "ecs.audit.parity_report.v2",
    total_comparisons: parityCases.length,
    mismatch_count: parityFailures.length,
    parity_mismatch_rate: percent(parityFailures.length, parityCases.length),
    cases: parityCases
  };
  writeJsonArtifact(join(PROOF_BUNDLE_DIR, "parity_report.json"), parityReport as unknown as JsonValue);
  writeJsonl(join(FULL_LOGS_DIR, "parity_failures.jsonl"), parityFailures);

  const performanceProfiles = PROFILE_ORDER.map((profile) => {
    const inputs = allCases.filter((item) => item.profile === profile).slice(0, 100).map((item) => item.raw_input);
    const sut = measurePerformance(profile, inputs, executeOutcome);
    const baseline = measurePerformance(`${profile}_baseline`, inputs, executeBaseline);
    return {
      profile,
      sut,
      baseline,
      delta_percent: {
        throughput_rps: performancePercentDifference(sut.throughput_rps, baseline.throughput_rps),
        p50_latency_ms: performancePercentDifference(sut.latency_ms.p50, baseline.latency_ms.p50),
        p95_latency_ms: performancePercentDifference(sut.latency_ms.p95, baseline.latency_ms.p95),
        p99_latency_ms: performancePercentDifference(sut.latency_ms.p99, baseline.latency_ms.p99),
        peak_rss_bytes: performancePercentDifference(sut.memory_usage.peak_rss_bytes, baseline.memory_usage.peak_rss_bytes),
        cpu_percent: performancePercentDifference(sut.cpu_usage.normalized_percent, baseline.cpu_usage.normalized_percent)
      },
      neutrality_band_percent: 3
    };
  });
  const performanceReport = {
    schema_version: "ecs.audit.performance_report.v1",
    profiles: performanceProfiles
  };
  writeJsonArtifact(join(OUTPUT_DIR, "performance_report.json"), performanceReport as unknown as JsonValue);

  const firstReceipt = baselineReceipts[0];
  const secondReceipt = baselineReceipts[1] ?? baselineReceipts[0];
  const failureModeReport = firstReceipt && secondReceipt
    ? buildFailureModeReport(firstReceipt, secondReceipt)
    : {
        schema_version: "ecs.audit.failure_mode_report.v1",
        cases: []
      };
  writeJsonArtifact(join(OUTPUT_DIR, "failure_mode_report.json"), failureModeReport as unknown as JsonValue);

  const costImpactReport = buildCostImpactReport();
  writeJsonArtifact(join(OUTPUT_DIR, "cost_impact_report.json"), costImpactReport as unknown as JsonValue);

  const summary = {
    schema_version: "ecs.audit.summary.v2",
    generated_at: BENCHMARK_TIMESTAMP,
    total_runs:
      determinismRuns +
      canonicalizationRuns +
      invalidCases.length +
      replayStore.total +
      parityCases.length +
      PERFORMANCE_RUNS_PER_PROFILE * PROFILE_ORDER.length * 2,
    determinism_mismatch_rate: determinismReport.mismatch_percentage,
    parity_mismatch_rate: parityReport.parity_mismatch_rate,
    replay_drift_rate: replayReport.replay_drift_rate,
    rejection_accuracy: Number((100 - percent(invalidAccepts.length, invalidCases.length)).toFixed(6)),
    throughput: performanceProfiles.map((item) => ({
      profile: item.profile,
      throughput_rps: item.sut.throughput_rps
    })),
    latency_stats: performanceProfiles.map((item) => ({
      profile: item.profile,
      ...item.sut.latency_ms
    }))
  };
  writeJsonArtifact(join(OUTPUT_DIR, "summary.json"), summary as unknown as JsonValue);

  const allFailingCases = [
    ...mismatchLogs,
    ...invalidAccepts,
    ...canonicalizationFailures,
    ...replayStore.mismatches,
    ...parityFailures
  ];
  writeJsonl(join(FULL_LOGS_DIR, "all_failing_cases.jsonl"), allFailingCases);
  writeJsonArtifact(
    join(FULL_LOGS_DIR, "minimal_repro_inputs.json"),
    {
      determinism: mismatchLogs.slice(0, 5).map((item) => ({ case_id: item.case_id, raw_input: item.raw_input })),
      schema_incorrect_accepts: invalidAccepts.slice(0, 5),
      canonicalization: canonicalizationFailures.slice(0, 5),
      parity: parityFailures.slice(0, 5),
      replay: replayStore.mismatches.slice(0, 5)
    } as unknown as JsonValue
  );

  const benchmarkReport = buildBenchmarkReportMarkdown(summary, performanceReport);
  writeFileSync(join(OUTPUT_DIR, "benchmark_report.md"), benchmarkReport, "utf8");

  const manifestFiles = [
    "summary.json",
    "test_matrix.json",
    "determinism_proof.json",
    "canonicalization_attack_report.json",
    "schema_enforcement_report.json",
    "performance_report.json",
    "failure_mode_report.json",
    "cost_impact_report.json",
    "benchmark_report.md",
    "full_logs/all_failing_cases.jsonl",
    "full_logs/determinism_failures.jsonl",
    "full_logs/canonicalization_failures.jsonl",
    "full_logs/minimal_repro_inputs.json",
    "full_logs/parity_failures.jsonl",
    "full_logs/replay_failures.jsonl",
    "proof_bundle/signed_receipts.jsonl",
    "proof_bundle/replay_results.json",
    "proof_bundle/parity_report.json",
    "proof_bundle/parity_vectors.json"
  ];
  writeJsonArtifact(
    join(OUTPUT_DIR, "manifest.json"),
    {
      schema_version: "ecs.audit.manifest.v2",
      generated_at: BENCHMARK_TIMESTAMP,
      artifacts: manifestFiles.map((file) => ({
        file,
        sha256: hashFileArtifact(join(OUTPUT_DIR, file))
      }))
    } as unknown as JsonValue
  );
}

function VALID_PROFILE_RUNS(profile: string): number {
  return buildProfileCaseCount(profile) * DETERMINISM_REPETITIONS;
}

function buildProfileCaseCount(profile: string): number {
  return profile === "adversarial_malformed" ? 200 : 200;
}

main();
