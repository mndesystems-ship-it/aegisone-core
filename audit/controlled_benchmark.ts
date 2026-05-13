import { createHmac, createHash } from "crypto";
import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import type { JsonValue } from "../shared/json.ts";
import { canonicalizeJson } from "../shared/json.ts";
import { executeDeterministicPipeline, makeBaseInput, rawJson, writeJsonArtifact } from "./node_runtime.ts";
import type { SignedReceipt } from "./types.ts";

const OUTPUT_DIR = join(process.cwd(), "controlled-benchmark-bundle");
const FULL_LOGS_DIR = join(OUTPUT_DIR, "full_logs");
const PROOF_BUNDLE_DIR = join(OUTPUT_DIR, "proof_bundle");
const ENABLED_RECEIPTS_PATH = join(PROOF_BUNDLE_DIR, "enabled_signed_receipts.jsonl");
const DISABLED_RECEIPTS_PATH = join(PROOF_BUNDLE_DIR, "disabled_signed_receipts.jsonl");
const PARITY_VECTORS_PATH = join(PROOF_BUNDLE_DIR, "parity_vectors.json");
const RUST_OUTPUT_PATH = join(PROOF_BUNDLE_DIR, "rust_parity_output.json");
const CONTINUOUS_LOAD_DURATION_MS = Number(process.env.CONTROLLED_CONTINUOUS_LOAD_DURATION_MS ?? "60000");
const REQUESTED_CONTINUOUS_HOURS = 24;
const REPLAYS_PER_SCENARIO = 1000;
const DISABLED_SIGNING_SECRET = "controlled-benchmark-disabled-secret-v1";
const DISABLED_KEY_ID = "controlled-benchmark-disabled-key-v1";
const BENCHMARK_TIMESTAMP = new Date().toISOString();

type ScenarioId = "high_cost_allow_path" | "runaway_execution_path" | "mixed_production_traffic";

type ScenarioCase = {
  case_id: string;
  scenario: ScenarioId;
  raw_input: string;
  projected_cost_cents: number;
  expected_enabled_decision: "ALLOW" | "REFUSE";
  expected_disabled_decision: "ALLOW" | "REFUSE";
};

type EnabledOutcome = {
  receipt_bytes: string;
  receipt: SignedReceipt;
  decision: "ALLOW" | "REFUSE";
  decision_hash: string;
  reason_code: string;
  projected_cost_cents: number;
};

type DisabledReceipt = {
  schema_version: "ecs.benchmark.disabled_receipt.v1";
  mode: "mnde_disabled";
  scenario: ScenarioId;
  request_hash: string;
  decision_output: {
    decision: "ALLOW" | "REFUSE";
    decision_hash: string;
    reason_code: string;
    projected_cost_cents: number;
    incurred_cost_cents: number;
    prevented_cost_cents: number;
  };
  signature: {
    algorithm: "HMAC-SHA256";
    key_id: string;
    value: string;
  };
};

type DisabledOutcome = {
  receipt_bytes: string;
  receipt: DisabledReceipt;
  decision: "ALLOW" | "REFUSE";
  decision_hash: string;
  reason_code: string;
  projected_cost_cents: number;
};

type FaultCase = {
  case_id: string;
  category: "malformed_json" | "duplicate_keys" | "unknown_fields" | "boundary_limit_violation";
  expected_reason_code: string;
  raw_input: string;
};

type ScenarioReport = {
  scenario: ScenarioId;
  total_executions: number;
  enabled: {
    total_cost_incurred_cents: number;
    total_cost_prevented_cents: number;
    decision_distribution: Record<string, number>;
    latency_ms: { p50: number; p95: number; p99: number };
  };
  disabled: {
    total_cost_incurred_cents: number;
    total_cost_prevented_cents: number;
    decision_distribution: Record<string, number>;
    latency_ms: { p50: number; p95: number; p99: number };
  };
  latency_impact_percent: {
    p50: number;
    p95: number;
    p99: number;
  };
  before_cost_cents: number;
  after_cost_cents: number;
  percent_cost_reduction: number;
};

function prepareDirs(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(FULL_LOGS_DIR, { recursive: true });
  mkdirSync(PROOF_BUNDLE_DIR, { recursive: true });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function percent(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }
  return Number((((numerator / denominator) * 100)).toFixed(6));
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio));
  return Number(sorted[index].toFixed(6));
}

function stableDecisionDistribution(): Record<string, number> {
  return { ALLOW: 0, REFUSE: 0 };
}

function projectedCostCents(rawInput: string): number {
  const parsed = JSON.parse(rawInput) as ReturnType<typeof makeBaseInput>;
  const request = parsed.execution_request;
  const scaleMultiplier = request.execution.auto_scale ? request.execution.max_scale_multiplier : 1;
  const retryMultiplier = request.execution.retry_on_fail ? request.execution.max_retries + 1 : 1;
  return request.resources.gpu_count * request.resources.hours * parsed.pricing_data.gpu_hour_cents * scaleMultiplier * retryMultiplier;
}

function buildHighCostAllowCase(index: number): ScenarioCase {
  const gpuCount = 20 + (index % 11);
  const hours = 16 + (index % 14);
  const input = makeBaseInput({
    execution_request: {
      request_id: `high-cost-${index.toString().padStart(4, "0")}`,
      resources: { gpu_type: "a10g", gpu_count: gpuCount, hours },
      execution: { auto_scale: false, max_scale_multiplier: 1, retry_on_fail: false, max_retries: 0 },
      release_request: { hold_state: "APPROVED", already_consumed: false, execution_id: `exec-high-cost-${index.toString().padStart(4, "0")}` },
      runtime_observation: {
        kill_switch_active: false,
        actual_gpu_count: gpuCount,
        actual_hours: hours,
        actual_total_cost_cents: gpuCount * hours * 500
      }
    }
  });
  const rawInput = rawJson(input as unknown as JsonValue);
  return {
    case_id: input.execution_request.request_id,
    scenario: "high_cost_allow_path",
    raw_input: rawInput,
    projected_cost_cents: projectedCostCents(rawInput),
    expected_enabled_decision: "ALLOW",
    expected_disabled_decision: "ALLOW"
  };
}

function buildRunawayCase(index: number): ScenarioCase {
  const gpuCount = 8 + (index % 8);
  const hours = 12 + (index % 8);
  const maxRetries = 6 + (index % 5);
  const scale = 12 + (index % 10);
  const input = makeBaseInput({
    execution_request: {
      request_id: `runaway-${index.toString().padStart(4, "0")}`,
      resources: { gpu_type: "a10g", gpu_count: gpuCount, hours },
      execution: { auto_scale: true, max_scale_multiplier: scale, retry_on_fail: true, max_retries: maxRetries },
      release_request: { hold_state: "PENDING", already_consumed: false, execution_id: `exec-runaway-${index.toString().padStart(4, "0")}` },
      runtime_observation: {
        kill_switch_active: false,
        actual_gpu_count: gpuCount,
        actual_hours: hours,
        actual_total_cost_cents: gpuCount * hours * 500
      }
    }
  });
  const rawInput = rawJson(input as unknown as JsonValue);
  return {
    case_id: input.execution_request.request_id,
    scenario: "runaway_execution_path",
    raw_input: rawInput,
    projected_cost_cents: projectedCostCents(rawInput),
    expected_enabled_decision: "REFUSE",
    expected_disabled_decision: "ALLOW"
  };
}

function buildMixedCase(index: number): ScenarioCase {
  if (index < 40) {
    return buildHighCostAllowCase(1000 + index).scenario === "high_cost_allow_path"
      ? { ...buildHighCostAllowCase(1000 + index), scenario: "mixed_production_traffic" }
      : buildHighCostAllowCase(1000 + index);
  }
  if (index < 80) {
    return { ...buildRunawayCase(1000 + index), scenario: "mixed_production_traffic" };
  }
  const gpuCount = 2 + (index % 4);
  const hours = 4 + (index % 6);
  const input = makeBaseInput({
    execution_request: {
      request_id: `mixed-runtime-${index.toString().padStart(4, "0")}`,
      resources: { gpu_type: "a10g", gpu_count: gpuCount, hours },
      execution: { auto_scale: false, max_scale_multiplier: 1, retry_on_fail: false, max_retries: 0 },
      release_request: { hold_state: "APPROVED", already_consumed: false, execution_id: `exec-mixed-runtime-${index.toString().padStart(4, "0")}` },
      runtime_observation: {
        kill_switch_active: index % 2 === 0,
        actual_gpu_count: gpuCount,
        actual_hours: hours,
        actual_total_cost_cents: gpuCount * hours * 500
      }
    }
  });
  const rawInput = rawJson(input as unknown as JsonValue);
  return {
    case_id: input.execution_request.request_id,
    scenario: "mixed_production_traffic",
    raw_input: rawInput,
    projected_cost_cents: projectedCostCents(rawInput),
    expected_enabled_decision: index % 2 === 0 ? "REFUSE" : "ALLOW",
    expected_disabled_decision: "ALLOW"
  };
}

function buildScenarios(): Record<ScenarioId, ScenarioCase[]> {
  const highCost = Array.from({ length: 80 }, (_, index) => buildHighCostAllowCase(index));
  const runaway = Array.from({ length: 80 }, (_, index) => buildRunawayCase(index));
  const mixed = Array.from({ length: 120 }, (_, index) => buildMixedCase(index));
  return {
    high_cost_allow_path: highCost,
    runaway_execution_path: runaway,
    mixed_production_traffic: mixed
  };
}

function executeEnabled(rawInput: string): EnabledOutcome {
  const result = executeDeterministicPipeline(rawInput);
  if ("parse_boundary" in result) {
    throw new Error(`Expected valid input, got ${result.reason_code}`);
  }
  return {
    receipt_bytes: result.receipt_bytes,
    receipt: result.receipt,
    decision: result.receipt.decision_output.decision,
    decision_hash: result.receipt.decision_output.decision_hash,
    reason_code: result.receipt.decision_output.reason_code,
    projected_cost_cents: projectedCostCents(rawInput)
  };
}

function executeDisabled(rawInput: string, scenario: ScenarioId): DisabledOutcome {
  const requestHash = sha256Hex(canonicalizeJson(JSON.parse(rawInput) as JsonValue));
  const projected = projectedCostCents(rawInput);
  const payload = {
    schema_version: "ecs.benchmark.disabled_receipt.v1" as const,
    mode: "mnde_disabled" as const,
    scenario,
    request_hash: requestHash,
    decision_output: {
      decision: "ALLOW" as const,
      decision_hash: sha256Hex(
        canonicalizeJson({
          mode: "mnde_disabled",
          scenario,
          request_hash: requestHash,
          decision: "ALLOW",
          reason_code: "CONTROL_BYPASSED",
          projected_cost_cents: projected,
          incurred_cost_cents: projected,
          prevented_cost_cents: 0
        } as unknown as JsonValue)
      ),
      reason_code: "CONTROL_BYPASSED",
      projected_cost_cents: projected,
      incurred_cost_cents: projected,
      prevented_cost_cents: 0
    }
  };
  const signature = {
    algorithm: "HMAC-SHA256" as const,
    key_id: DISABLED_KEY_ID,
    value: hmacHex(DISABLED_SIGNING_SECRET, canonicalizeJson(payload as unknown as JsonValue))
  };
  const receipt: DisabledReceipt = { ...payload, signature };
  return {
    receipt_bytes: canonicalizeJson(receipt as unknown as JsonValue),
    receipt,
    decision: "ALLOW",
    decision_hash: receipt.decision_output.decision_hash,
    reason_code: receipt.decision_output.reason_code,
    projected_cost_cents: projected
  };
}

function writeJsonl(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function buildScenarioReport(scenario: ScenarioId, cases: ScenarioCase[]) {
  const enabledLatencies: number[] = [];
  const disabledLatencies: number[] = [];
  const enabledDistribution = stableDecisionDistribution();
  const disabledDistribution = stableDecisionDistribution();
  let enabledCostIncurred = 0;
  let enabledCostPrevented = 0;
  let disabledCostIncurred = 0;
  const enabledReceiptLines: string[] = [];
  const disabledReceiptLines: string[] = [];
  const parityVectors: Array<{ case_id: string; raw_input: string }> = [];

  for (const testCase of cases) {
    const enabledStart = process.hrtime.bigint();
    const enabled = executeEnabled(testCase.raw_input);
    const enabledEnd = process.hrtime.bigint();
    enabledLatencies.push(Number(enabledEnd - enabledStart) / 1_000_000);

    const disabledStart = process.hrtime.bigint();
    const disabled = executeDisabled(testCase.raw_input, scenario);
    const disabledEnd = process.hrtime.bigint();
    disabledLatencies.push(Number(disabledEnd - disabledStart) / 1_000_000);

    enabledDistribution[enabled.decision] += 1;
    disabledDistribution[disabled.decision] += 1;
    if (enabled.decision === "ALLOW") {
      enabledCostIncurred += enabled.projected_cost_cents;
    } else {
      enabledCostPrevented += enabled.projected_cost_cents;
    }
    disabledCostIncurred += disabled.projected_cost_cents;

    enabledReceiptLines.push(enabled.receipt_bytes);
    disabledReceiptLines.push(disabled.receipt_bytes);
    parityVectors.push({ case_id: testCase.case_id, raw_input: testCase.raw_input });
  }

  const report: ScenarioReport = {
      scenario,
      total_executions: cases.length,
      enabled: {
        total_cost_incurred_cents: enabledCostIncurred,
        total_cost_prevented_cents: enabledCostPrevented,
        decision_distribution: enabledDistribution,
        latency_ms: {
          p50: percentile(enabledLatencies, 0.5),
          p95: percentile(enabledLatencies, 0.95),
          p99: percentile(enabledLatencies, 0.99)
        }
      },
      disabled: {
        total_cost_incurred_cents: disabledCostIncurred,
        total_cost_prevented_cents: 0,
        decision_distribution: disabledDistribution,
        latency_ms: {
          p50: percentile(disabledLatencies, 0.5),
          p95: percentile(disabledLatencies, 0.95),
          p99: percentile(disabledLatencies, 0.99)
        }
      },
      latency_impact_percent: {
        p50: percent(percentile(enabledLatencies, 0.5) - percentile(disabledLatencies, 0.5), percentile(disabledLatencies, 0.5)),
        p95: percent(percentile(enabledLatencies, 0.95) - percentile(disabledLatencies, 0.95), percentile(disabledLatencies, 0.95)),
        p99: percent(percentile(enabledLatencies, 0.99) - percentile(disabledLatencies, 0.99), percentile(disabledLatencies, 0.99))
      },
      before_cost_cents: disabledCostIncurred,
      after_cost_cents: enabledCostIncurred,
      percent_cost_reduction: percent(disabledCostIncurred - enabledCostIncurred, disabledCostIncurred)
    };
  return {
    report,
    enabledReceiptLines,
    disabledReceiptLines,
    parityVectors
  };
}

function verifyScenarioReplay(scenario: ScenarioId, cases: ScenarioCase[]) {
  let driftCount = 0;
  let totalReplays = 0;
  const failureLogs: Array<Record<string, string | number>> = [];
  for (const testCase of cases) {
    const baseline = executeEnabled(testCase.raw_input);
    for (let replayIndex = 0; replayIndex < REPLAYS_PER_SCENARIO; replayIndex += 1) {
      const next = executeEnabled(testCase.raw_input);
      totalReplays += 1;
      if (baseline.receipt_bytes !== next.receipt_bytes) {
        driftCount += 1;
        if (failureLogs.length < 25) {
          failureLogs.push({
            scenario,
            case_id: testCase.case_id,
            replay_index: replayIndex,
            expected: baseline.receipt_bytes,
            actual: next.receipt_bytes
          });
        }
      }
    }
  }
  return {
    scenario,
    total_replays: totalReplays,
    drift_count: driftCount,
    drift_rate: percent(driftCount, totalReplays),
    failures: failureLogs
  };
}

function buildFaultCases(): FaultCase[] {
  const base = makeBaseInput();
  const duplicateKeys = `{"execution_request":{"request_id":"dup-a","request_id":"dup-b"},"policy_document":${JSON.stringify(base.policy_document)},"pricing_data":${JSON.stringify(base.pricing_data)}}`;
  const unknownField = JSON.stringify({
    ...base,
    execution_request: {
      ...base.execution_request,
      rogue_field: true
    }
  });
  const gpuViolation = rawJson(
    makeBaseInput({
      execution_request: {
        request_id: "boundary-gpu",
        resources: { gpu_type: "a10g", gpu_count: 40, hours: 4 }
      }
    }) as unknown as JsonValue
  );
  const retryViolation = rawJson(
    makeBaseInput({
      execution_request: {
        request_id: "boundary-retry",
        execution: { auto_scale: false, max_scale_multiplier: 1, retry_on_fail: true, max_retries: 8 }
      }
    }) as unknown as JsonValue
  );
  return [
    { case_id: "fault-malformed", category: "malformed_json", expected_reason_code: "ERR_INVALID_JSON_SYNTAX", raw_input: "{\"execution_request\":" },
    { case_id: "fault-duplicate", category: "duplicate_keys", expected_reason_code: "ERR_DUPLICATE_JSON_KEYS", raw_input: duplicateKeys },
    { case_id: "fault-unknown", category: "unknown_fields", expected_reason_code: "ERR_SCHEMA_VALIDATION", raw_input: unknownField },
    { case_id: "fault-boundary-gpu", category: "boundary_limit_violation", expected_reason_code: "ERR_GPU_LIMIT", raw_input: gpuViolation },
    { case_id: "fault-boundary-retry", category: "boundary_limit_violation", expected_reason_code: "ERR_RETRY_LIMIT", raw_input: retryViolation }
  ];
}

function evaluateFaultClassification(cases: FaultCase[]) {
  const results = cases.map((testCase) => {
    const outcome = executeDeterministicPipeline(testCase.raw_input);
    const actualReason = "parse_boundary" in outcome ? outcome.reason_code : outcome.receipt.decision_output.reason_code;
    return {
      case_id: testCase.case_id,
      category: testCase.category,
      expected_reason_code: testCase.expected_reason_code,
      actual_reason_code: actualReason,
      correct: actualReason === testCase.expected_reason_code
    };
  });
  return {
    schema_version: "ecs.audit.fault_injection_report.v1",
    total_cases: results.length,
    correct_classifications: results.filter((item) => item.correct).length,
    classification_accuracy: percent(results.filter((item) => item.correct).length, results.length),
    refusal_reason_codes: results,
    target_full_accuracy: results.every((item) => item.correct)
  };
}

function runParity(vectors: Array<{ case_id: string; raw_input: string }>) {
  writeFileSync(PARITY_VECTORS_PATH, `${JSON.stringify(vectors, null, 2)}\n`, "utf8");
  const rustOutputPath = process.env.RUST_PARITY_OUTPUT_PATH ?? RUST_OUTPUT_PATH;
  if (!process.env.RUST_PARITY_OUTPUT_PATH) {
    throw new Error(`RUST_PARITY_OUTPUT_PATH not set. Parity vectors written to ${PARITY_VECTORS_PATH}`);
  }
  const rustOutput = readFileSync(rustOutputPath, "utf8");
  writeFileSync(RUST_OUTPUT_PATH, rustOutput, "utf8");
  const rustReceipts = JSON.parse(rustOutput) as Array<{ case_id: string; receipt_bytes: string; decision_hash: string; decision: string }>;
  const parityResults = vectors.map((vector, index) => {
    const enabled = executeEnabled(vector.raw_input);
    const rustReceipt = rustReceipts[index];
    const rustSignedReceipt = JSON.parse(rustReceipt.receipt_bytes) as SignedReceipt;
    return {
      case_id: vector.case_id,
      receipt_bytes_identical: enabled.receipt_bytes === rustReceipt.receipt_bytes,
      decision_hash_identical: enabled.decision_hash === rustReceipt.decision_hash,
      signature_identical: enabled.receipt.signature.value === rustSignedReceipt.signature.value
    };
  });
  return {
    schema_version: "ecs.audit.cross_runtime_parity_report.v1",
    total_comparisons: parityResults.length,
    mismatch_count: parityResults.filter((item) => !item.receipt_bytes_identical || !item.decision_hash_identical || !item.signature_identical).length,
    results: parityResults
  };
}

function runContinuousLoadSample(scenarios: Record<ScenarioId, ScenarioCase[]>) {
  const combined = [...scenarios.high_cost_allow_path, ...scenarios.runaway_execution_path, ...scenarios.mixed_production_traffic];
  const latencies: number[] = [];
  const throughputSamples: number[] = [];
  const start = Date.now();
  let executions = 0;
  let lastSampleTime = start;
  let lastSampleCount = 0;

  while (Date.now() - start < CONTINUOUS_LOAD_DURATION_MS) {
    const testCase = combined[executions % combined.length];
    const runStart = process.hrtime.bigint();
    executeEnabled(testCase.raw_input);
    const runEnd = process.hrtime.bigint();
    latencies.push(Number(runEnd - runStart) / 1_000_000);
    executions += 1;

    const now = Date.now();
    if (now - lastSampleTime >= 1000) {
      throughputSamples.push(((executions - lastSampleCount) * 1000) / (now - lastSampleTime));
      lastSampleTime = now;
      lastSampleCount = executions;
    }
  }

  const driftChecks = combined.slice(0, 30).map((testCase) => {
    const baseline = executeEnabled(testCase.raw_input);
    const replay = executeEnabled(testCase.raw_input);
    return baseline.receipt_bytes === replay.receipt_bytes ? 0 : 1;
  });

  return {
    schema_version: "ecs.audit.continuous_load_report.v1",
    requested_duration_hours: REQUESTED_CONTINUOUS_HOURS,
    executed_duration_seconds: CONTINUOUS_LOAD_DURATION_MS / 1000,
    completed_requested_duration: CONTINUOUS_LOAD_DURATION_MS >= REQUESTED_CONTINUOUS_HOURS * 60 * 60 * 1000,
    executions,
    drift_count: driftChecks.reduce((sum, item) => sum + item, 0),
    latency_distribution_ms: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99)
    },
    throughput_stability_rps: {
      min: Number((Math.min(...throughputSamples)).toFixed(6)),
      max: Number((Math.max(...throughputSamples)).toFixed(6)),
      mean: Number((throughputSamples.reduce((sum, value) => sum + value, 0) / throughputSamples.length).toFixed(6))
    }
  };
}

function main() {
  prepareDirs();

  const scenarios = buildScenarios();
  const scenarioReports: ScenarioReport[] = [];
  const enabledReceiptLines: string[] = [];
  const disabledReceiptLines: string[] = [];
  const parityVectors: Array<{ case_id: string; raw_input: string }> = [];
  const replayReports: Array<Record<string, unknown>> = [];

  for (const [scenario, cases] of Object.entries(scenarios) as Array<[ScenarioId, ScenarioCase[]]>) {
    const built = buildScenarioReport(scenario, cases);
    scenarioReports.push(built.report);
    enabledReceiptLines.push(...built.enabledReceiptLines);
    disabledReceiptLines.push(...built.disabledReceiptLines);
    parityVectors.push(...built.parityVectors);
    replayReports.push(verifyScenarioReplay(scenario, cases));
  }

  writeJsonl(ENABLED_RECEIPTS_PATH, enabledReceiptLines);
  writeJsonl(DISABLED_RECEIPTS_PATH, disabledReceiptLines);

  const parityReport = runParity(parityVectors);
  const faultReport = evaluateFaultClassification(buildFaultCases());
  const continuousLoadReport = runContinuousLoadSample(scenarios);

  const beforeCost = scenarioReports.reduce((sum, item) => sum + item.before_cost_cents, 0);
  const afterCost = scenarioReports.reduce((sum, item) => sum + item.after_cost_cents, 0);
  const finalReport = {
    schema_version: "ecs.audit.controlled_benchmark_report.v1",
    generated_at: BENCHMARK_TIMESTAMP,
    scenarios: scenarioReports,
    before_cost_cents: beforeCost,
    after_cost_cents: afterCost,
    total_cost_prevented_cents: beforeCost - afterCost,
    percent_cost_reduction: percent(beforeCost - afterCost, beforeCost),
    replay_verification: replayReports,
    parity: {
      total_comparisons: parityReport.total_comparisons,
      mismatch_count: parityReport.mismatch_count
    },
    fault_injection: {
      total_cases: faultReport.total_cases,
      classification_accuracy: faultReport.classification_accuracy
    },
    continuous_load: {
      requested_duration_hours: REQUESTED_CONTINUOUS_HOURS,
      executed_duration_seconds: continuousLoadReport.executed_duration_seconds,
      completed_requested_duration: continuousLoadReport.completed_requested_duration
    }
  };

  writeJsonArtifact(join(OUTPUT_DIR, "final_report.json"), finalReport as unknown as JsonValue);
  writeJsonArtifact(join(OUTPUT_DIR, "scenario_reports.json"), scenarioReports as unknown as JsonValue);
  writeJsonArtifact(join(OUTPUT_DIR, "replay_report.json"), replayReports as unknown as JsonValue);
  writeJsonArtifact(join(OUTPUT_DIR, "parity_report.json"), parityReport as unknown as JsonValue);
  writeJsonArtifact(join(OUTPUT_DIR, "fault_injection_report.json"), faultReport as unknown as JsonValue);
  writeJsonArtifact(join(OUTPUT_DIR, "continuous_load_report.json"), continuousLoadReport as unknown as JsonValue);

  writeFileSync(join(FULL_LOGS_DIR, "scenario_inputs.json"), `${JSON.stringify(scenarios, null, 2)}\n`, "utf8");
  writeFileSync(join(FULL_LOGS_DIR, "enabled_vs_disabled_receipt_index.json"), `${JSON.stringify({
    enabled_receipts: ENABLED_RECEIPTS_PATH,
    disabled_receipts: DISABLED_RECEIPTS_PATH
  }, null, 2)}\n`, "utf8");

  writeJsonArtifact(
    join(OUTPUT_DIR, "manifest.json"),
    {
      schema_version: "ecs.audit.controlled_manifest.v1",
      generated_at: BENCHMARK_TIMESTAMP,
      artifacts: [
        "final_report.json",
        "scenario_reports.json",
        "replay_report.json",
        "parity_report.json",
        "fault_injection_report.json",
        "continuous_load_report.json",
        "proof_bundle/enabled_signed_receipts.jsonl",
        "proof_bundle/disabled_signed_receipts.jsonl",
        "proof_bundle/parity_vectors.json",
        "proof_bundle/rust_parity_output.json",
        "full_logs/scenario_inputs.json",
        "full_logs/enabled_vs_disabled_receipt_index.json"
      ].map((file) => ({
        file,
        sha256: sha256Hex(readFileSync(join(OUTPUT_DIR, file), "utf8"))
      }))
    } as unknown as JsonValue
  );
}

main();
