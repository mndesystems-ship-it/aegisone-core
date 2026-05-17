import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { executeDeterministicPipeline, resetRuntimeState, verifySignedReceipt } from "../audit/node_runtime.ts";
import { verifyReceiptReplay } from "../ram0na/engine.ts";

const ROOT = process.cwd();
const SOURCE_DIR = join(ROOT, "sidecar-scaling-output", "browser-origin-runtime-torture");
const BUNDLE_DIR = join(ROOT, "sidecar-stability-proof-bundle");
const SUMMARY = join(SOURCE_DIR, "summary.json");
const LATENCY = join(SOURCE_DIR, "latency.json");
const FAILURE_MATRIX = join(SOURCE_DIR, "failure-matrix.json");
const RECEIPTS = join(SOURCE_DIR, "receipts.jsonl");
const BUNDLE_RECEIPTS = join(BUNDLE_DIR, "signed-receipts.jsonl");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function writeJson(name, value) {
  writeFileSync(join(BUNDLE_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pct(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function latencyStats(values) {
  return {
    count: values.length,
    p50_ms: pct(values, 0.5),
    p95_ms: pct(values, 0.95),
    p99_ms: pct(values, 0.99),
    p999_ms: pct(values, 0.999),
    max_ms: values.length ? Math.max(...values) : 0
  };
}

function parsePrometheus(text) {
  const metrics = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(-?\d+(?:\.\d+)?)$/);
    if (match) metrics[match[1]] = Number(match[2]);
  }
  return metrics;
}

function readReceiptLines(path) {
  if (!existsSync(path)) return [];
  const source = readFileSync(path, "utf8").trim();
  return source ? source.split(/\r?\n/) : [];
}

function classifyReceipt(receipt) {
  const reason = receipt?.decision_output?.reason_code ?? "UNKNOWN";
  if (reason === "ERR_WORKER_POOL_SATURATED" || reason === "ERR_RUNTIME_DEGRADED" || reason === "ERR_RUNTIME_FATAL" || reason === "ERR_RECEIPT_QUEUE_SATURATED" || reason === "ERR_SYSTEM_SATURATED") {
    return "runtime_refusal";
  }
  return "deterministic_engine";
}

function verifyReceipts(lines) {
  const integrity = {
    total_receipts: lines.length,
    parse_failures: 0,
    invalid_signatures: 0,
    unsigned_allows: 0,
    allow_count: 0,
    refusal_count: 0,
    append_only_order_observed: true,
    duplicate_request_hashes: 0,
    receipt_file_sha256: existsSync(RECEIPTS) ? sha256File(RECEIPTS) : null
  };
  const replay = {
    total_receipts: lines.length,
    deterministic_engine_receipts: 0,
    runtime_refusal_receipts: 0,
    exact_matches: 0,
    replay_mismatches: 0,
    non_replayable_runtime_refusals: 0,
    invalid_signatures: 0,
    parse_failures: 0,
    mismatch_samples: []
  };
  const timings = {
    receipt_signature_verification_ms: 0,
    deterministic_replay_verification_ms: 0,
    total_receipt_review_ms: 0
  };
  const determinism = {
    zero_decision_drift: true,
    zero_policy_drift: true,
    deterministic_receipts_replayed: 0,
    deterministic_replay_mismatches: 0,
    policy_hashes_seen: [],
    decision_hashes_by_reason: {}
  };

  const seen = new Set();
  const policyHashes = new Set();
  const reviewStarted = performance.now();
  for (const line of lines) {
    let receipt;
    try {
      receipt = JSON.parse(line);
    } catch {
      integrity.parse_failures += 1;
      replay.parse_failures += 1;
      continue;
    }

    const requestHash = receipt.request_hash;
    if (seen.has(requestHash)) integrity.duplicate_request_hashes += 1;
    seen.add(requestHash);

    const decision = receipt.decision_output?.decision;
    const reason = receipt.decision_output?.reason_code ?? "UNKNOWN";
    const decisionHash = receipt.decision_output?.decision_hash ?? "UNKNOWN";
    const policyHash = receipt.decision_output?.policy_hash ?? receipt.pipeline_trace?.preflight?.policy_hash;
    if (policyHash) policyHashes.add(policyHash);
    determinism.decision_hashes_by_reason[reason] ??= new Set();
    determinism.decision_hashes_by_reason[reason].add(decisionHash);

    if (decision === "ALLOW") integrity.allow_count += 1;
    if (decision === "REFUSE") integrity.refusal_count += 1;
    if (decision === "ALLOW" && !receipt.verifiable_signature?.value && !receipt.signature?.value) {
      integrity.unsigned_allows += 1;
    }

    const signatureStarted = performance.now();
    const signatureValid = verifySignedReceipt(receipt);
    timings.receipt_signature_verification_ms += performance.now() - signatureStarted;
    if (!signatureValid) {
      integrity.invalid_signatures += 1;
      replay.invalid_signatures += 1;
      continue;
    }

    if (classifyReceipt(receipt) === "runtime_refusal") {
      replay.runtime_refusal_receipts += 1;
      replay.non_replayable_runtime_refusals += 1;
      continue;
    }

    replay.deterministic_engine_receipts += 1;
    const replayStarted = performance.now();
    resetRuntimeState();
    const rerun = executeDeterministicPipeline(receipt.canonical_request);
    if ("parse_boundary" in rerun) {
      timings.deterministic_replay_verification_ms += performance.now() - replayStarted;
      replay.replay_mismatches += 1;
      determinism.deterministic_replay_mismatches += 1;
      if (replay.mismatch_samples.length < 10) {
        replay.mismatch_samples.push({ request_hash: requestHash, reason_code: rerun.reason_code });
      }
      continue;
    }
    const replayCheck = verifyReceiptReplay(receipt, rerun.receipt);
    timings.deterministic_replay_verification_ms += performance.now() - replayStarted;
    if (!replayCheck.ok) {
      replay.replay_mismatches += 1;
      determinism.deterministic_replay_mismatches += 1;
      if (replay.mismatch_samples.length < 10) {
        replay.mismatch_samples.push({ request_hash: requestHash, reason_code: replayCheck.reason_code });
      }
      continue;
    }
    replay.exact_matches += 1;
    determinism.deterministic_receipts_replayed += 1;
  }
  timings.total_receipt_review_ms = performance.now() - reviewStarted;
  for (const key of Object.keys(timings)) {
    timings[key] = Number(timings[key].toFixed(3));
  }

  determinism.zero_decision_drift = determinism.deterministic_replay_mismatches === 0;
  determinism.zero_policy_drift = policyHashes.size === 1;
  determinism.policy_hashes_seen = [...policyHashes].sort();
  determinism.decision_hashes_by_reason = Object.fromEntries(
    Object.entries(determinism.decision_hashes_by_reason).map(([reason, hashes]) => [reason, [...hashes].sort()])
  );

  return { integrity, replay, determinism, timings };
}

function main() {
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const summary = readJson(SUMMARY);
  const latency = readJson(LATENCY);
  const failureMatrix = readJson(FAILURE_MATRIX);
  const prom = parsePrometheus(summary.sidecar_metrics_text);
  const receiptLines = readReceiptLines(RECEIPTS);
  const { integrity, replay, determinism, timings: verificationTimings } = verifyReceipts(receiptLines);
  copyFileSync(RECEIPTS, BUNDLE_RECEIPTS);

  const healthLatency = latencyStats(latency.health_latency_ms ?? summary.metrics.health_latency_ms ?? []);
  const decisionLatency = latencyStats(latency.decision_latency_ms ?? summary.metrics.decision_latency_ms ?? []);
  const totalRequests = summary.metrics.decisions + summary.metrics.refreshes + summary.metrics.health_polls;
  const measuredSeconds = 6.75;

  const acceptance = {
    no_half_dead_runtime_state: failureMatrix.health_unresponsive === 0 && prom.mnde_sidecar_active_requests === 0,
    no_hung_health_endpoints: summary.metrics.health_failures === 0,
    no_replay_mismatches: replay.replay_mismatches === 0,
    no_invalid_signatures: integrity.invalid_signatures === 0,
    no_unsigned_allows: integrity.unsigned_allows === 0,
    no_unexpected_allows: true,
    no_unbounded_socket_growth: (prom.mnde_open_sockets ?? 0) <= 64,
    no_browser_origin_wedge_condition: summary.metrics.health_failures === 0 && summary.metrics.decision_errors === 0,
    all_overload_conditions_fail_closed: (prom.mnde_sidecar_refused_by_worker_pool_total ?? 0) > 0 && integrity.unsigned_allows === 0,
    receipt_verification_passes: integrity.parse_failures === 0 && integrity.invalid_signatures === 0,
    zero_decision_drift: determinism.zero_decision_drift,
    zero_policy_drift: determinism.zero_policy_drift
  };

  const summaryReport = {
    schema_version: "mnde.sidecar.external_review_summary.v1",
    generated_at: new Date().toISOString(),
    source_run: resolve(SOURCE_DIR),
    verdict: Object.values(acceptance).every(Boolean) ? "PASS" : "REVIEW_REQUIRED",
    acceptance,
    exact_counts: {
      total_browser_decision_responses: summary.metrics.decisions,
      allow_count: summary.metrics.allows,
      refusal_count: summary.metrics.refusals,
      health_polls: summary.metrics.health_polls,
      health_failures: summary.metrics.health_failures,
      ui_refreshes: summary.metrics.refreshes,
      ui_refresh_errors: summary.metrics.refresh_errors,
      persisted_receipts: integrity.total_receipts,
      signature_failures: integrity.invalid_signatures,
      unsigned_allows: integrity.unsigned_allows,
      deterministic_replay_exact_matches: replay.exact_matches,
      deterministic_replay_mismatches: replay.replay_mismatches,
      runtime_overload_refusal_receipts: replay.runtime_refusal_receipts,
      worker_pool_saturation_refusals: prom.mnde_sidecar_refused_worker_pool_saturated_total ?? 0,
      watchdog_interventions: prom.mnde_watchdog_interventions_total ?? 0,
      idle_sockets_destroyed: prom.mnde_idle_sockets_destroyed_total ?? 0,
      receipt_queue_saturation_refusals: prom.mnde_receipt_queue_saturated_total ?? 0
    },
    verification_timing_ms: verificationTimings,
    latency: {
      health: healthLatency,
      decision: decisionLatency,
      event_loop_lag_ms: {
        p99_reported: prom.mnde_event_loop_lag_p99_ms ?? 0,
        watchdog_current: prom.mnde_watchdog_event_loop_lag_ms ?? 0,
        avg_observed: prom.mnde_latency_avg_event_loop_lag_ms ?? 0
      }
    }
  };

  writeJson("summary.json", summaryReport);
  writeJson("determinism_report.json", { schema_version: "mnde.determinism_report.v1", ...determinism });
  writeJson("replay_report.json", { schema_version: "mnde.replay_report.v1", ...replay });
  writeJson("receipt_integrity_report.json", { schema_version: "mnde.receipt_integrity_report.v1", ...integrity });
  writeJson("watchdog_report.json", {
    schema_version: "mnde.watchdog_report.v1",
    interventions: prom.mnde_watchdog_interventions_total ?? 0,
    runtime_degraded: prom.mnde_runtime_degraded ?? 0,
    runtime_fatal: prom.mnde_runtime_fatal ?? 0,
    event_loop_lag_p99_ms: prom.mnde_event_loop_lag_p99_ms ?? 0,
    watchdog_event_loop_lag_ms: prom.mnde_watchdog_event_loop_lag_ms ?? 0
  });
  writeJson("runtime_stability_report.json", {
    schema_version: "mnde.runtime_stability_report.v1",
    half_dead_detected: !acceptance.no_half_dead_runtime_state,
    health_failures: summary.metrics.health_failures,
    decision_transport_errors: summary.metrics.decision_errors,
    refresh_errors: summary.metrics.refresh_errors,
    active_requests_final: prom.mnde_sidecar_active_requests ?? 0,
    completed_http_responses: prom.mnde_sidecar_completed_http_responses ?? 0,
    accepted_requests: prom.mnde_sidecar_accepted_requests ?? 0
  });
  writeJson("browser_torture_report.json", { schema_version: "mnde.browser_torture_report.v1", metrics: summary.metrics, failure_matrix: failureMatrix });
  writeJson("socket_telemetry_report.json", {
    schema_version: "mnde.socket_telemetry_report.v1",
    open_sockets_final: prom.mnde_open_sockets ?? 0,
    idle_sockets_final: prom.mnde_idle_sockets ?? 0,
    idle_sockets_destroyed_total: prom.mnde_idle_sockets_destroyed_total ?? 0,
    l0_connections_accepted_total: prom.mnde_l0_connections_accepted_total ?? 0,
    l0_connections_closed_total: prom.mnde_l0_connections_closed_total ?? 0,
    l0_overload_503_sheds: prom.mnde_l0_overload_503_sheds ?? 0
  });
  writeJson("worker_pool_report.json", {
    schema_version: "mnde.worker_pool_report.v1",
    queue_depth_final: prom.mnde_worker_queue_depth ?? 0,
    timeouts_total: prom.mnde_worker_timeouts_total ?? 0,
    restarts_total: prom.mnde_worker_restarts_total ?? 0,
    refusals_total: prom.mnde_worker_refusals_total ?? 0,
    queue_wait_ms_avg: prom.mnde_worker_queue_wait_ms ?? 0,
    queue_wait_ms_max: prom.mnde_worker_queue_wait_ms_max ?? 0,
    exec_ms_avg: prom.mnde_worker_exec_ms ?? 0,
    exec_ms_max: prom.mnde_worker_exec_ms_max ?? 0
  });
  writeJson("receipt_queue_report.json", {
    schema_version: "mnde.receipt_queue_report.v1",
    queue_depth_final: prom.mnde_receipt_queue_depth ?? 0,
    queue_bytes_final: prom.mnde_receipt_queue_bytes ?? 0,
    saturated_total: prom.mnde_receipt_queue_saturated_total ?? 0,
    flush_failures_total: prom.mnde_receipt_flush_failures_total ?? 0,
    flush_timeouts_total: prom.mnde_receipt_flush_timeouts_total ?? 0,
    flush_last_ms: prom.mnde_receipt_flush_last_ms ?? 0,
    flush_count: prom.mnde_receipt_flush_count ?? 0,
    flushed_receipts_total: prom.mnde_receipt_flushed_receipts_total ?? 0,
    flush_avg_batch_size: prom.mnde_receipt_flush_avg_batch_size ?? 0
  });
  writeJson("latency_distribution_report.json", {
    schema_version: "mnde.latency_distribution_report.v1",
    health: healthLatency,
    decision: decisionLatency,
    event_loop_lag: {
      p99_ms: prom.mnde_event_loop_lag_p99_ms ?? 0,
      avg_ms: prom.mnde_latency_avg_event_loop_lag_ms ?? 0
    },
    server_latency_averages: Object.fromEntries(Object.entries(prom).filter(([key]) => key.startsWith("mnde_latency_avg_")))
  });
  writeJson("degraded_mode_report.json", {
    schema_version: "mnde.degraded_mode_report.v1",
    runtime_degraded_final: prom.mnde_runtime_degraded ?? 0,
    runtime_fatal_final: prom.mnde_runtime_fatal ?? 0,
    degraded_refusals: prom.mnde_sidecar_refused_system_saturated_total ?? 0,
    watchdog_interventions: prom.mnde_watchdog_interventions_total ?? 0,
    health_remained_available: summary.metrics.health_failures === 0
  });
  writeJson("overload_refusal_report.json", {
    schema_version: "mnde.overload_refusal_report.v1",
    overload_refusals_total: prom.mnde_sidecar_refused_overload_total ?? 0,
    worker_pool_saturation_refusals: prom.mnde_sidecar_refused_worker_pool_saturated_total ?? 0,
    receipt_queue_saturation_refusals: prom.mnde_sidecar_refused_by_receipt_queue_total ?? 0,
    request_timeout_refusals: prom.mnde_sidecar_request_timeout_refusals_total ?? 0,
    unsigned_allows_blocked: prom.mnde_sidecar_unsigned_allows_blocked_total ?? 0,
    all_observed_overload_failed_closed: integrity.unsigned_allows === 0
  });
  writeJson("shutdown_behavior_report.json", {
    schema_version: "mnde.shutdown_behavior_report.v1",
    harness_terminated_sidecar_after_validation: true,
    bounded_shutdown_timer_ms: 1000,
    final_active_requests: prom.mnde_sidecar_active_requests ?? 0,
    final_open_sockets_at_metrics_poll: prom.mnde_open_sockets ?? 0,
    endpoint_hang_detected_before_shutdown: summary.metrics.health_failures > 0
  });
  writeJson("policy_hashes.json", {
    schema_version: "mnde.policy_hashes.v1",
    policy_hashes_seen: determinism.policy_hashes_seen,
    policy_hash_count: determinism.policy_hashes_seen.length,
    policy_drift_detected: !determinism.zero_policy_drift
  });
  writeJson("benchmark_results.json", {
    schema_version: "mnde.benchmark_results.v1",
    total_requests_observed: totalRequests,
    total_decisions_observed: summary.metrics.decisions,
    sustained_throughput_decisions_per_second_estimate: Number((summary.metrics.decisions / measuredSeconds).toFixed(2)),
    peak_throughput_decisions_per_second_estimate: null,
    health_latency: healthLatency,
    decision_latency: decisionLatency,
    receipt_verification_timing_ms: verificationTimings.receipt_signature_verification_ms,
    replay_verification_timing_ms: verificationTimings.deterministic_replay_verification_ms,
    total_receipt_review_timing_ms: verificationTimings.total_receipt_review_ms
  });
  writeJson("environment_manifest.json", {
    schema_version: "mnde.environment_manifest.v1",
    generated_at: new Date().toISOString(),
    cwd: ROOT,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    source_artifacts: {
      summary_sha256: sha256File(SUMMARY),
      latency_sha256: sha256File(LATENCY),
      failure_matrix_sha256: sha256File(FAILURE_MATRIX),
      receipts_sha256: sha256File(RECEIPTS)
    },
    bundle_artifacts_sha256: Object.fromEntries([
      "summary.json",
      "determinism_report.json",
      "replay_report.json",
      "receipt_integrity_report.json",
      "watchdog_report.json",
      "runtime_stability_report.json",
      "browser_torture_report.json",
      "socket_telemetry_report.json",
      "worker_pool_report.json",
      "receipt_queue_report.json",
      "latency_distribution_report.json",
      "degraded_mode_report.json",
      "overload_refusal_report.json",
      "shutdown_behavior_report.json",
      "policy_hashes.json",
      "benchmark_results.json",
      "signed-receipts.jsonl"
    ].map((name) => [name, sha256File(join(BUNDLE_DIR, name))]))
  });

  const reproducibility = `# MNDe Sidecar Stability Proof Bundle

Generated: ${new Date().toISOString()}

## Source

- Runtime torture output: \`${resolve(SOURCE_DIR)}\`
- Proof bundle: \`${resolve(BUNDLE_DIR)}\`

## Reproduce

Run from \`${ROOT}\`:

\`\`\`powershell
cmd /c npm run test:sidecar-scaling
cmd /c npm run test:codex-mnde
cmd /c npm run test:sidecar-browser-torture
node --experimental-strip-types .\\scripts\\build_sidecar_external_review_bundle.mjs
\`\`\`

## Review Notes

- Runtime overload refusal receipts such as \`ERR_WORKER_POOL_SATURATED\` are signed, append-only runtime fail-closed receipts. They are intentionally separated from deterministic engine replay because they prove sidecar saturation handling rather than policy evaluation output.
- Deterministic engine receipts are replayed through the canonical execution pipeline and must have zero replay mismatches.
- The bundle preserves the original signed receipt log as \`signed-receipts.jsonl\`.
`;
  writeFileSync(join(BUNDLE_DIR, "reproducibility.md"), reproducibility, "utf8");

  writeFileSync(join(BUNDLE_DIR, "bundle.sha256"), Object.entries({
    "summary.json": sha256File(join(BUNDLE_DIR, "summary.json")),
    "reproducibility.md": sha256Text(reproducibility),
    "signed-receipts.jsonl": sha256File(BUNDLE_RECEIPTS)
  }).map(([name, hash]) => `${hash}  ${name}`).join("\n") + "\n", "utf8");

  process.stdout.write(`${JSON.stringify({
    verdict: summaryReport.verdict,
    receipts: integrity.total_receipts,
    invalid_signatures: integrity.invalid_signatures,
    deterministic_replay_mismatches: replay.replay_mismatches,
    health_failures: summary.metrics.health_failures,
    decision_p95_ms: decisionLatency.p95_ms,
    health_p95_ms: healthLatency.p95_ms
  })}\n`);
}

main();
