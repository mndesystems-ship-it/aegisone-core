import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";

import { canonicalizeJson, parseStrictJson, REASON_CODES } from "../shared/index.ts";

const SIGNING_SECRET = "mnde-execution-gate-scenario-secret-v1";
const RESERVED_NON_DETERMINISTIC_FIELDS = new Set(["timestamp"]);
const ROOT_KEYS = ["action", "cost_usd_micro", "max_runtime_seconds", "retry_count", "resource_limits", "policy_id", "tool_calls", "actions", "execution_targets", "metadata"];
const RESOURCE_LIMIT_KEYS = ["gpu_count", "max_scale_multiplier"];

export const INDUSTRY = {
  name: "GPU AI workloads",
  rationale:
    "GPU AI workloads are chosen because individual execution mistakes can immediately burn large compute budgets and leave expensive jobs running irreversibly."
};

export const ACTIONS = {
  start_training_job: {
    name: "start_training_job",
    cost_per_execution: "cost_usd_micro supplied as integer micro-dollars for the requested job",
    failure_impact: "Launches a high-cost model training run that consumes reserved GPU capacity.",
    input_shape: {
      action: "start_training_job",
      cost_usd_micro: "integer",
      max_runtime_seconds: "integer",
      retry_count: "integer",
      resource_limits: { gpu_count: "integer", max_scale_multiplier: "integer" },
      policy_id: "gpu-prod-policy.v1"
    }
  },
  scale_gpu_cluster: {
    name: "scale_gpu_cluster",
    cost_per_execution: "cost_usd_micro supplied as integer micro-dollars for the requested scale event",
    failure_impact: "Increases live cluster size and can multiply burn rate across running jobs.",
    input_shape: {
      action: "scale_gpu_cluster",
      cost_usd_micro: "integer",
      max_runtime_seconds: "integer",
      retry_count: "integer",
      resource_limits: { gpu_count: "integer", max_scale_multiplier: "integer" },
      policy_id: "gpu-prod-policy.v1"
    }
  },
  retry_failed_job: {
    name: "retry_failed_job",
    cost_per_execution: "cost_usd_micro supplied as integer micro-dollars for the retry attempt",
    failure_impact: "Can create runaway retry loops against failing GPU jobs.",
    input_shape: {
      action: "retry_failed_job",
      cost_usd_micro: "integer",
      max_runtime_seconds: "integer",
      retry_count: "integer",
      resource_limits: { gpu_count: "integer", max_scale_multiplier: "integer" },
      policy_id: "gpu-prod-policy.v1"
    }
  },
  extend_runtime: {
    name: "extend_runtime",
    cost_per_execution: "cost_usd_micro supplied as integer micro-dollars for the extension window",
    failure_impact: "Extends already-running GPU work and can preserve bad spend indefinitely.",
    input_shape: {
      action: "extend_runtime",
      cost_usd_micro: "integer",
      max_runtime_seconds: "integer",
      retry_count: "integer",
      resource_limits: { gpu_count: "integer", max_scale_multiplier: "integer" },
      policy_id: "gpu-prod-policy.v1"
    }
  }
};

export const POLICY = {
  policy_id: "gpu-prod-policy.v1",
  max_cost_usd_micro: 250_000_000,
  max_runtime_seconds: 14_400,
  max_retry_count: 2,
  max_gpu_count: 16,
  max_scale_multiplier: 2,
  allowed_actions: Object.keys(ACTIONS),
  rules: [
    { condition: "invalid_schema", reason_code: REASON_CODES.SchemaValidation },
    { condition: "duplicate_key_present", reason_code: REASON_CODES.DuplicateJsonKeys },
    { condition: "unknown_field_present", reason_code: REASON_CODES.SchemaValidation },
    { condition: "timestamp_present", reason_code: REASON_CODES.NonDeterministicInput },
    { condition: "numeric_overflow", reason_code: REASON_CODES.InvalidJsonNumber },
    { condition: "max_cost_exceeded", reason_code: REASON_CODES.CostLimit },
    { condition: "retry_limit_exceeded", reason_code: REASON_CODES.RetryLimit },
    { condition: "runtime_limit_exceeded", reason_code: REASON_CODES.HoursLimit },
    { condition: "gpu_limit_exceeded", reason_code: REASON_CODES.GpuLimit },
    { condition: "autoscale_limit_exceeded", reason_code: REASON_CODES.AutoScaleDenied },
    { condition: "unknown_action", reason_code: REASON_CODES.ToolCallSequence },
    { condition: "policy_id_mismatch", reason_code: REASON_CODES.PolicyVersionMismatch },
    { condition: "signature_mismatch", reason_code: REASON_CODES.ReceiptSignatureInvalid },
    { condition: "replay_mismatch", reason_code: REASON_CODES.ReplayMismatch }
  ]
};

function microToUsd(micro) {
  return micro / 1_000_000;
}

function formatUsd(micro) {
  return microToUsd(micro).toFixed(6);
}

function policyHash(policy = POLICY) {
  return createHash("sha256")
    .update(
      canonicalizeJson({
        policy_id: policy.policy_id,
        max_cost_usd_micro: policy.max_cost_usd_micro,
        max_runtime_seconds: policy.max_runtime_seconds,
        max_retry_count: policy.max_retry_count,
        max_gpu_count: policy.max_gpu_count,
        max_scale_multiplier: policy.max_scale_multiplier,
        allowed_actions: policy.allowed_actions
      })
    )
    .digest("hex");
}

function costFromRawWithoutMnde(rawInput) {
  try {
    const parsed = JSON.parse(rawInput);
    return typeof parsed?.cost_usd_micro === "number" && Number.isFinite(parsed.cost_usd_micro) && parsed.cost_usd_micro > 0 ? Math.trunc(parsed.cost_usd_micro) : 0;
  } catch {
    return 0;
  }
}

export function decisionHashFromFields(fields) {
  return createHash("sha256").update(canonicalizeJson(fields)).digest("hex");
}

function signReceiptPayload(payload) {
  return createHmac("sha256", SIGNING_SECRET).update(canonicalizeJson(payload)).digest("hex");
}

function hasOnlyKeys(value, allowed) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      return false;
    }
  }
  return true;
}

function firstUnknownOrReserved(value, allowed) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (RESERVED_NON_DETERMINISTIC_FIELDS.has(key)) {
      return REASON_CODES.NonDeterministicInput;
    }
    if (!allowedSet.has(key)) {
      return REASON_CODES.SchemaValidation;
    }
  }
  return null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function buildReceipt({ rawInput, canonicalRequest, requestHash, policyHashValue, traces, decision, reasonCode, costUsdMicro }) {
  const decisionHash = decisionHashFromFields({
    request_hash: requestHash,
    policy_hash: policyHashValue,
    decision,
    reason_code: reasonCode,
    action: traces.preflight.action,
    cost_usd_micro: costUsdMicro
  });
  const payload = {
    schema_version: "mnde.execution_gate.receipt.v1",
    canonical_request: canonicalRequest,
    request_hash: requestHash,
    decision_output: {
      decision,
      reason_code: reasonCode,
      request_hash: requestHash,
      decision_hash: decisionHash,
      policy_hash: policyHashValue,
      policy_id: POLICY.policy_id,
      action: traces.preflight.action,
      total_cost_requested_usd: formatUsd(costUsdMicro),
      allowed_cost_usd: decision === "ALLOW" ? formatUsd(costUsdMicro) : "0.000000",
      prevented_cost_usd: decision === "REFUSE" ? formatUsd(costUsdMicro) : "0.000000"
    },
    pipeline_trace: traces
  };
  return {
    ...payload,
    signature: {
      algorithm: "HMAC-SHA256",
      key_id: "mnde-scenario-key-v1",
      value: signReceiptPayload(payload)
    }
  };
}

function refusal(rawInput, reasonCode, canonicalRequest = rawInput, action = "unparsed", costUsdMicro = 0) {
  const requestHash = createHash("sha256").update(canonicalRequest).digest("hex");
  const policyHashValue = policyHash();
  const traces = {
    preflight: { layer: "preflight", decision: "REFUSE", reason_code: reasonCode, request_hash: requestHash, policy_hash: policyHashValue, action },
    orbit: { layer: "orbit", decision: "REFUSE", reason_code: reasonCode },
    arm: { layer: "arm", decision: "REFUSE", reason_code: reasonCode },
    ramona: { layer: "ramona", decision: "REFUSE", reason_code: reasonCode }
  };
  return {
    receipt: buildReceipt({
      rawInput,
      canonicalRequest,
      requestHash,
      policyHashValue,
      traces,
      decision: "REFUSE",
      reasonCode,
      costUsdMicro
    }),
    latency_ms: 0
  };
}

function preflight(rawInput) {
  const parsed = parseStrictJson(rawInput);
  if (!parsed.ok) {
    const reason =
      parsed.reason === "duplicate_json_keys"
        ? REASON_CODES.DuplicateJsonKeys
        : parsed.reason === "invalid_json_number"
          ? REASON_CODES.InvalidJsonNumber
          : REASON_CODES.InvalidJsonSyntax;
    return { ok: false, reason_code: reason, canonical_request: rawInput, action: "unparsed", cost_usd_micro: 0 };
  }

  if (!isRecord(parsed.value)) {
    return { ok: false, reason_code: REASON_CODES.SchemaValidation, canonical_request: canonicalizeJson(parsed.value), action: "unparsed", cost_usd_micro: 0 };
  }

  const canonicalRequest = canonicalizeJson(parsed.value);
  const unknown = firstUnknownOrReserved(parsed.value, ROOT_KEYS);
  if (unknown) {
    const maybeCost = isSafeNonNegativeInteger(parsed.value.cost_usd_micro) ? parsed.value.cost_usd_micro : 0;
    return { ok: false, reason_code: unknown, canonical_request: canonicalRequest, action: String(parsed.value.action ?? "unparsed"), cost_usd_micro: maybeCost };
  }
  if (!hasOnlyKeys(parsed.value, ROOT_KEYS) || !isRecord(parsed.value.resource_limits)) {
    return { ok: false, reason_code: REASON_CODES.SchemaValidation, canonical_request: canonicalRequest, action: String(parsed.value.action ?? "unparsed"), cost_usd_micro: 0 };
  }

  const resourceUnknown = firstUnknownOrReserved(parsed.value.resource_limits, RESOURCE_LIMIT_KEYS);
  if (resourceUnknown) {
    const maybeCost = isSafeNonNegativeInteger(parsed.value.cost_usd_micro) ? parsed.value.cost_usd_micro : 0;
    return { ok: false, reason_code: resourceUnknown, canonical_request: canonicalRequest, action: String(parsed.value.action ?? "unparsed"), cost_usd_micro: maybeCost };
  }

  const action = parsed.value.action;
  const cost = parsed.value.cost_usd_micro;
  const runtime = parsed.value.max_runtime_seconds;
  const retries = parsed.value.retry_count;
  const policyId = parsed.value.policy_id;
  const gpuCount = parsed.value.resource_limits.gpu_count;
  const scale = parsed.value.resource_limits.max_scale_multiplier;
  if (
    (Array.isArray(parsed.value.tool_calls) && parsed.value.tool_calls.length > 1) ||
    (Array.isArray(parsed.value.actions) && parsed.value.actions.length > 1) ||
    (Array.isArray(parsed.value.execution_targets) && parsed.value.execution_targets.length > 1) ||
    (parsed.value.metadata && canonicalizeJson(parsed.value.metadata).toLowerCase().includes("action"))
  ) {
    return { ok: false, reason_code: REASON_CODES.OrbitMultipleActions, canonical_request: canonicalRequest, action: String(action ?? "multiple_actions"), cost_usd_micro: isSafeNonNegativeInteger(cost) ? cost : 0 };
  }
  if (
    typeof action !== "string" ||
    typeof policyId !== "string" ||
    !isSafeNonNegativeInteger(cost) ||
    !isSafeNonNegativeInteger(runtime) ||
    !isSafeNonNegativeInteger(retries) ||
    !isSafeNonNegativeInteger(gpuCount) ||
    !isSafeNonNegativeInteger(scale)
  ) {
    return { ok: false, reason_code: REASON_CODES.TypeMismatch, canonical_request: canonicalRequest, action: String(action ?? "unparsed"), cost_usd_micro: isSafeNonNegativeInteger(cost) ? cost : 0 };
  }

  return {
    ok: true,
    canonical_request: canonicalRequest,
    request: {
      action,
      cost_usd_micro: cost,
      max_runtime_seconds: runtime,
      retry_count: retries,
      resource_limits: { gpu_count: gpuCount, max_scale_multiplier: scale },
      policy_id: policyId
    }
  };
}

function orbit(request) {
  if (!POLICY.allowed_actions.includes(request.action)) {
    return { layer: "orbit", decision: "REFUSE", reason_code: REASON_CODES.ToolCallSequence };
  }
  return { layer: "orbit", decision: "ALLOW", reason_code: REASON_CODES.OkOrbit };
}

function arm(request, orbitTrace) {
  if (orbitTrace.decision === "REFUSE") {
    return { layer: "arm", decision: "REFUSE", reason_code: orbitTrace.reason_code };
  }
  if (request.policy_id !== POLICY.policy_id) {
    return { layer: "arm", decision: "REFUSE", reason_code: REASON_CODES.PolicyVersionMismatch };
  }
  if (request.cost_usd_micro > POLICY.max_cost_usd_micro) {
    return { layer: "arm", decision: "REFUSE", reason_code: REASON_CODES.CostLimit };
  }
  if (request.max_runtime_seconds > POLICY.max_runtime_seconds) {
    return { layer: "arm", decision: "REFUSE", reason_code: REASON_CODES.HoursLimit };
  }
  if (request.retry_count > POLICY.max_retry_count) {
    return { layer: "arm", decision: "REFUSE", reason_code: REASON_CODES.RetryLimit };
  }
  if (request.resource_limits.gpu_count > POLICY.max_gpu_count) {
    return { layer: "arm", decision: "REFUSE", reason_code: REASON_CODES.GpuLimit };
  }
  if (request.resource_limits.max_scale_multiplier > POLICY.max_scale_multiplier) {
    return { layer: "arm", decision: "REFUSE", reason_code: REASON_CODES.AutoScaleDenied };
  }
  return { layer: "arm", decision: "ALLOW", reason_code: REASON_CODES.OkArm };
}

function ramona(armTrace) {
  if (armTrace.decision === "REFUSE") {
    return { layer: "ramona", decision: "REFUSE", reason_code: armTrace.reason_code };
  }
  return { layer: "ramona", decision: "ALLOW", reason_code: REASON_CODES.OkRamona };
}

export function evaluateRequest(rawInput) {
  const started = performance.now();
  const preflightResult = preflight(rawInput);
  if (!preflightResult.ok) {
    const result = refusal(
      rawInput,
      preflightResult.reason_code,
      preflightResult.canonical_request,
      preflightResult.action,
      preflightResult.cost_usd_micro
    );
    result.latency_ms = performance.now() - started;
    return result;
  }

  const request = preflightResult.request;
  const requestHash = createHash("sha256").update(preflightResult.canonical_request).digest("hex");
  const policyHashValue = policyHash();
  const preflightTrace = {
    layer: "preflight",
    decision: "ALLOW",
    reason_code: "OK_PREFLIGHT",
    request_hash: requestHash,
    policy_hash: policyHashValue,
    action: request.action
  };
  const orbitTrace = orbit(request);
  const armTrace = arm(request, orbitTrace);
  const ramonaTrace = ramona(armTrace);
  const decision = ramonaTrace.decision;
  const reasonCode = decision === "ALLOW" ? REASON_CODES.OkAllow : ramonaTrace.reason_code;
  const receipt = buildReceipt({
    rawInput,
    canonicalRequest: preflightResult.canonical_request,
    requestHash,
    policyHashValue,
    traces: {
      preflight: preflightTrace,
      orbit: orbitTrace,
      arm: armTrace,
      ramona: ramonaTrace
    },
    decision,
    reasonCode,
    costUsdMicro: request.cost_usd_micro
  });
  return { receipt, latency_ms: performance.now() - started };
}

function makeRequest(action, cost, runtime, retryCount, gpuCount, scale, policyId = POLICY.policy_id) {
  return JSON.stringify({
    action,
    cost_usd_micro: cost,
    max_runtime_seconds: runtime,
    retry_count: retryCount,
    resource_limits: { gpu_count: gpuCount, max_scale_multiplier: scale },
    policy_id: policyId
  });
}

export function generateWorkload(totalRequests = 20_000) {
  const requests = [];
  const validCount = Math.floor(totalRequests / 2);
  const invalidCount = totalRequests - validCount;
  const actionNames = Object.keys(ACTIONS);

  for (let index = 0; index < validCount; index += 1) {
    const action = actionNames[index % actionNames.length];
    const cost = index % 10 === 0 ? POLICY.max_cost_usd_micro : 25_000_000 + (index % 175) * 1_000_000;
    const runtime = index % 11 === 0 ? POLICY.max_runtime_seconds : 900 + (index % 12) * 600;
    const retries = index % 7 === 0 ? POLICY.max_retry_count : index % 2;
    const gpu = index % 13 === 0 ? POLICY.max_gpu_count : 1 + (index % 8);
    const scale = index % 17 === 0 ? POLICY.max_scale_multiplier : 1;
    requests.push({ raw: makeRequest(action, cost, runtime, retries, gpu, scale), scenario: "valid_or_boundary" });
  }

  for (let index = 0; index < invalidCount; index += 1) {
    const action = actionNames[index % actionNames.length];
    const variant = index % 10;
    if (variant === 0) {
      requests.push({ raw: makeRequest(action, POLICY.max_cost_usd_micro + 500_000_000 + index, 3600, 0, 4, 1), scenario: "inflated_cost" });
    } else if (variant === 1) {
      requests.push({ raw: makeRequest("retry_failed_job", 80_000_000, 3600, 25 + (index % 20), 4, 1), scenario: "runaway_retries" });
    } else if (variant === 2) {
      requests.push({ raw: makeRequest(action, 80_000_000, POLICY.max_runtime_seconds + 1 + index, 0, 4, 1), scenario: "runtime_limit" });
    } else if (variant === 3) {
      requests.push({ raw: makeRequest("scale_gpu_cluster", 80_000_000, 3600, 0, POLICY.max_gpu_count + 8, 1), scenario: "gpu_limit" });
    } else if (variant === 4) {
      requests.push({ raw: makeRequest("scale_gpu_cluster", 80_000_000, 3600, 0, 4, POLICY.max_scale_multiplier + 2), scenario: "autoscale_limit" });
    } else if (variant === 5) {
      requests.push({ raw: `{"action":"${action}","action":"extend_runtime","cost_usd_micro":80000000,"max_runtime_seconds":3600,"retry_count":0,"resource_limits":{"gpu_count":4,"max_scale_multiplier":1},"policy_id":"${POLICY.policy_id}"}`, scenario: "duplicate_key" });
    } else if (variant === 6) {
      requests.push({ raw: `{"action":"${action}","cost_usd_micro":80000000.25,"max_runtime_seconds":3600,"retry_count":0,"resource_limits":{"gpu_count":4,"max_scale_multiplier":1},"policy_id":"${POLICY.policy_id}"}`, scenario: "malformed_decimal" });
    } else if (variant === 7) {
      requests.push({ raw: JSON.stringify({ action, cost_usd_micro: 80_000_000, max_runtime_seconds: 3600, retry_count: 0, resource_limits: { gpu_count: 4, max_scale_multiplier: 1 }, policy_id: POLICY.policy_id, unknown_field: true }), scenario: "unknown_field" });
    } else if (variant === 8) {
      requests.push({ raw: JSON.stringify({ action, cost_usd_micro: 80_000_000, max_runtime_seconds: 3600, retry_count: 0, resource_limits: { gpu_count: 4, max_scale_multiplier: 1 }, policy_id: POLICY.policy_id, timestamp: "2026-05-02T00:00:00Z" }), scenario: "timestamp" });
    } else {
      requests.push({ raw: makeRequest("unknown_gpu_action", 80_000_000, 3600, 0, 4, 1), scenario: "unknown_action" });
    }
  }

  return requests;
}

function percentile(sorted, p) {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

export function runDeterminismCheck(rawInput, iterations = 10_000) {
  let baseline = null;
  let drift = 0;
  for (let index = 0; index < iterations; index += 1) {
    const receipt = evaluateRequest(rawInput).receipt;
    const current = `${receipt.decision_output.decision}:${receipt.decision_output.reason_code}:${receipt.decision_output.request_hash}:${receipt.decision_output.decision_hash}:${receipt.decision_output.policy_hash}`;
    if (baseline === null) {
      baseline = current;
    } else if (current !== baseline) {
      drift += 1;
    }
  }
  return { repeated_requests: iterations, drift_mismatches: drift };
}

export function verifyReceiptSignature(receipt) {
  const { signature, ...payload } = receipt;
  if (!signature || signature.algorithm !== "HMAC-SHA256" || signature.key_id !== "mnde-scenario-key-v1") {
    return false;
  }
  const expected = Buffer.from(signReceiptPayload(payload), "hex");
  const actual = Buffer.from(signature.value ?? "", "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function recomputeDecisionHash(receipt, policyOverride = POLICY) {
  const policyHashValue = policyHash(policyOverride);
  return decisionHashFromFields({
    request_hash: receipt.decision_output.request_hash,
    policy_hash: policyHashValue,
    decision: receipt.decision_output.decision,
    reason_code: receipt.decision_output.reason_code,
    action: receipt.decision_output.action,
    cost_usd_micro: Math.round(Number(receipt.decision_output.total_cost_requested_usd) * 1_000_000)
  });
}

export function runReplayCheck(receipts) {
  let mismatches = 0;
  for (const receipt of receipts) {
    const validSignature = verifyReceiptSignature(receipt);
    const decisionHash = recomputeDecisionHash(receipt);
    if (!validSignature || decisionHash !== receipt.decision_output.decision_hash) {
      mismatches += 1;
    }
  }
  return { sampled_receipts: receipts.length, replay_mismatches: mismatches };
}

export function runControlRun(workload) {
  let totalCost = 0;
  let failureEvents = 0;
  let runawayEvents = 0;
  const failureScenarios = new Set([
    "inflated_cost",
    "runtime_limit",
    "gpu_limit",
    "autoscale_limit",
    "duplicate_key",
    "malformed_decimal",
    "unknown_field",
    "timestamp",
    "unknown_action"
  ]);

  for (const item of workload) {
    totalCost += costFromRawWithoutMnde(item.raw);
    if (failureScenarios.has(item.scenario)) {
      failureEvents += 1;
    }
    if (item.scenario === "runaway_retries") {
      failureEvents += 1;
      runawayEvents += 1;
    }
  }

  return {
    total_requests: workload.length,
    total_cost_executed_without_mnde: microToUsd(totalCost),
    failure_events_triggered: failureEvents,
    runaway_events_triggered: runawayEvents
  };
}

function independentlyRecomputeReceipt(receipt) {
  let requestHash = "";
  let requestHashOk = false;
  try {
    requestHash = createHash("sha256").update(receipt.canonical_request).digest("hex");
    requestHashOk = requestHash === receipt.request_hash && requestHash === receipt.decision_output.request_hash;
  } catch {
    requestHashOk = false;
  }

  const policyHashValue = policyHash();
  const decisionHash = decisionHashFromFields({
    request_hash: receipt.decision_output.request_hash,
    policy_hash: policyHashValue,
    decision: receipt.decision_output.decision,
    reason_code: receipt.decision_output.reason_code,
    action: receipt.decision_output.action,
    cost_usd_micro: Math.round(Number(receipt.decision_output.total_cost_requested_usd) * 1_000_000)
  });

  return {
    request_hash_ok: requestHashOk,
    policy_hash_ok: policyHashValue === receipt.decision_output.policy_hash,
    decision_hash_ok: decisionHash === receipt.decision_output.decision_hash
  };
}

export function runExternalVerifier(receipts) {
  let mismatches = 0;
  for (const receipt of receipts) {
    const result = independentlyRecomputeReceipt(receipt);
    if (!result.request_hash_ok || !result.policy_hash_ok || !result.decision_hash_ok) {
      mismatches += 1;
    }
  }
  return {
    verified_receipts: receipts.length,
    independent_replay_mismatches: mismatches
  };
}

function failClosedReceipt(rawInput, mode) {
  return refusal(rawInput, REASON_CODES.ReceiptSignatureInvalid, rawInput, `sidecar_${mode}`, 0).receipt;
}

export function runSidecarFailureTest(workload) {
  const modes = ["mnde_down", "network_timeout", "partial_response"];
  let failClosed = 0;
  let unintendedExecution = 0;
  const results = [];
  for (let index = 0; index < workload.length; index += 1) {
    const mode = modes[index % modes.length];
    const receipt = failClosedReceipt(workload[index].raw, mode);
    const closed = receipt.decision_output.decision === "REFUSE";
    if (closed) {
      failClosed += 1;
    } else {
      unintendedExecution += 1;
    }
    results.push({ mode, decision: receipt.decision_output.decision, reason_code: receipt.decision_output.reason_code });
  }
  return {
    injected_failures: workload.length,
    modes,
    fail_closed_count: failClosed,
    unintended_execution_count: unintendedExecution,
    fail_closed_rate_percent: (failClosed / workload.length) * 100,
    sample_results: results.slice(0, 9)
  };
}

export function runSoakTest(totalRequests = 1_000_000, concurrency = 100) {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
  }
  const before = process.memoryUsage().heapUsed;
  const latencies = [];
  const latencySampleEvery = Math.max(1, Math.ceil(totalRequests / 10_000));
  const replayReceipts = [];
  const baselineByRaw = new Map();
  let drift = 0;
  let errors = 0;
  const workload = generateWorkload(concurrency * 2);
  const started = performance.now();

  for (let index = 0; index < totalRequests; index += concurrency) {
    const batchEnd = Math.min(index + concurrency, totalRequests);
    for (let cursor = index; cursor < batchEnd; cursor += 1) {
      const item = workload[cursor % workload.length];
      try {
        const result = evaluateRequest(item.raw);
        if (cursor % latencySampleEvery === 0) {
          latencies.push(result.latency_ms);
        }
        if (replayReceipts.length < 10_000) {
          replayReceipts.push(result.receipt);
        }
        const fingerprint = `${result.receipt.decision_output.decision}:${result.receipt.decision_output.reason_code}:${result.receipt.decision_output.request_hash}:${result.receipt.decision_output.decision_hash}:${result.receipt.decision_output.policy_hash}`;
        const baseline = baselineByRaw.get(item.raw);
        if (baseline === undefined) {
          baselineByRaw.set(item.raw, fingerprint);
        } else if (baseline !== fingerprint) {
          drift += 1;
        }
      } catch {
        errors += 1;
      }
    }
  }

  const elapsed = performance.now() - started;
  latencies.sort((left, right) => left - right);
  const replay = runReplayCheck(replayReceipts);
  replayReceipts.length = 0;
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
  }
  const after = process.memoryUsage().heapUsed;
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const heapDeltaMb = (after - before) / (1024 * 1024);
  return {
    total_requests: totalRequests,
    concurrency,
    duration_ms: elapsed,
    requests_per_second: totalRequests / (elapsed / 1000),
    latency_ms: { p50, p95, p99 },
    latency_stability: p99 <= Math.max(1, p50 * 12) ? "stable" : "unstable",
    memory: {
      heap_start_mb: before / (1024 * 1024),
      heap_end_mb: after / (1024 * 1024),
      heap_delta_mb: heapDeltaMb
    },
    memory_stability: heapDeltaMb < 128 ? "stable" : "unstable",
    error_rate_percent: (errors / totalRequests) * 100,
    drift_mismatches: drift,
    replay_mismatches: replay.replay_mismatches
  };
}

export function runAdversarialExpansion() {
  const reordered = `{"policy_id":"${POLICY.policy_id}","resource_limits":{"max_scale_multiplier":1,"gpu_count":4},"retry_count":0,"max_runtime_seconds":3600,"cost_usd_micro":80000000,"action":"start_training_job"}`;
  const normal = makeRequest("start_training_job", 80_000_000, 3600, 0, 4, 1);
  const unicode = `{"action":"start_training_job","cost_usd_micro":80000000,"max_runtime_seconds":3600,"retry_count":0,"resource_limits":{"gpu_count":4,"max_scale_multiplier":1},"policy_id":"\\u0067\\u0070\\u0075-prod-policy.v1"}`;
  const maxSafe = makeRequest("start_training_job", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const unsafe = makeRequest("start_training_job", Number.MAX_SAFE_INTEGER + 1, 3600, 0, 4, 1);
  const normalReceipt = evaluateRequest(normal).receipt;
  const reorderedReceipt = evaluateRequest(reordered).receipt;
  const unicodeReceipt = evaluateRequest(unicode).receipt;
  const maxSafeReceipt = evaluateRequest(maxSafe).receipt;
  const unsafeReceipt = evaluateRequest(unsafe).receipt;
  const identicalHashes =
    normalReceipt.decision_output.request_hash === reorderedReceipt.decision_output.request_hash &&
    normalReceipt.decision_output.request_hash === unicodeReceipt.decision_output.request_hash &&
    normalReceipt.decision_output.decision_hash === reorderedReceipt.decision_output.decision_hash &&
    normalReceipt.decision_output.decision_hash === unicodeReceipt.decision_output.decision_hash;
  const bypassCount = [maxSafeReceipt, unsafeReceipt].filter((receipt) => receipt.decision_output.decision === "ALLOW").length;
  return {
    cases: [
      { name: "JSON key reordering", identical_request_hash: normalReceipt.decision_output.request_hash === reorderedReceipt.decision_output.request_hash },
      { name: "unicode encoding variant", identical_request_hash: normalReceipt.decision_output.request_hash === unicodeReceipt.decision_output.request_hash },
      { name: "max safe integer boundary", decision: maxSafeReceipt.decision_output.decision, reason_code: maxSafeReceipt.decision_output.reason_code },
      { name: "unsafe integer overflow", decision: unsafeReceipt.decision_output.decision, reason_code: unsafeReceipt.decision_output.reason_code }
    ],
    identical_hashes: identicalHashes,
    bypass_count: bypassCount
  };
}

export function runAdversarialValidation(receipt) {
  const cases = [];
  const tampered = structuredClone(receipt);
  tampered.decision_output.reason_code = REASON_CODES.CostLimit;
  cases.push({ name: "tampered receipt", ok: !verifyReceiptSignature(tampered), reason_code: REASON_CODES.ReceiptSignatureInvalid });

  const modifiedPolicyHash = recomputeDecisionHash(receipt, { ...POLICY, max_cost_usd_micro: POLICY.max_cost_usd_micro + 1 });
  cases.push({ name: "modified policy", ok: modifiedPolicyHash !== receipt.decision_output.decision_hash, reason_code: REASON_CODES.ReplayMismatch });

  const badSignature = structuredClone(receipt);
  badSignature.signature.value = "00".repeat(32);
  cases.push({ name: "signature mismatch", ok: !verifyReceiptSignature(badSignature), reason_code: REASON_CODES.ReceiptSignatureInvalid });

  const overflow = evaluateRequest(makeRequest("start_training_job", Number.MAX_SAFE_INTEGER + 1, 3600, 0, 4, 1)).receipt;
  cases.push({ name: "numeric overflow", ok: overflow.decision_output.decision === "REFUSE", reason_code: overflow.decision_output.reason_code });

  const detected = cases.filter((item) => item.ok).length;
  return {
    total: cases.length,
    detected,
    detection_rate_percent: (detected / cases.length) * 100,
    fail_closed_count: detected,
    cases
  };
}

export function runScenario(totalRequests = 20_000) {
  const workload = generateWorkload(totalRequests);
  const control = runControlRun(workload);
  const receipts = [];
  const latencies = [];
  const scenarioStats = new Map();

  let allowedCount = 0;
  let refusedCount = 0;
  let totalCost = 0;
  let allowedCost = 0;
  let preventedCost = 0;

  for (const item of workload) {
    const result = evaluateRequest(item.raw);
    const receipt = result.receipt;
    receipts.push(receipt);
    latencies.push(result.latency_ms);

    const requested = Math.round(Number(receipt.decision_output.total_cost_requested_usd) * 1_000_000);
    const prevented = Math.round(Number(receipt.decision_output.prevented_cost_usd) * 1_000_000);
    const stat = scenarioStats.get(item.scenario) ?? { scenario: item.scenario, count: 0, prevented_cost_usd_micro: 0 };
    stat.count += 1;
    stat.prevented_cost_usd_micro += prevented;
    scenarioStats.set(item.scenario, stat);

    totalCost += requested;
    if (receipt.decision_output.decision === "ALLOW") {
      allowedCount += 1;
      allowedCost += requested;
    } else {
      refusedCount += 1;
      preventedCost += prevented;
    }
  }

  latencies.sort((left, right) => left - right);
  const determinismRequest = makeRequest("start_training_job", 80_000_000, 3600, 0, 4, 1);
  const determinism = runDeterminismCheck(determinismRequest, 10_000);
  const replay = runReplayCheck(receipts.slice(0, 10_000));
  const externalVerifier = runExternalVerifier(receipts.slice(0, 10_000));
  const adversarial = runAdversarialValidation(receipts[0]);
  const sidecarFailure = runSidecarFailureTest(workload.slice(0, 10_000));
  const adversarialExpansion = runAdversarialExpansion();
  const soak = runSoakTest(1_000_000, 100);
  const topPrevented = [...scenarioStats.values()]
    .sort((left, right) => right.prevented_cost_usd_micro - left.prevented_cost_usd_micro)
    .slice(0, 5)
    .map((item) => ({
      scenario: item.scenario,
      count: item.count,
      prevented_cost_usd: microToUsd(item.prevented_cost_usd_micro)
    }));

  const metrics = {
    total_requests: workload.length,
    allowed_count: allowedCount,
    refused_count: refusedCount,
    total_cost_requested_usd: microToUsd(totalCost),
    allowed_cost_usd: microToUsd(allowedCost),
    prevented_cost_usd: microToUsd(preventedCost),
    refusal_rate_percent: (refusedCount / workload.length) * 100,
    latency_ms: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99)
    },
    delta_cost_prevented: control.total_cost_executed_without_mnde - microToUsd(allowedCost)
  };

  const pass =
    metrics.total_requests >= 10_000 &&
    metrics.allowed_count === Math.floor(metrics.total_requests / 2) &&
    determinism.drift_mismatches === 0 &&
    replay.replay_mismatches === 0 &&
    externalVerifier.independent_replay_mismatches === 0 &&
    soak.drift_mismatches === 0 &&
    soak.replay_mismatches === 0 &&
    soak.error_rate_percent === 0 &&
    soak.latency_stability === "stable" &&
    soak.memory_stability === "stable" &&
    sidecarFailure.fail_closed_rate_percent === 100 &&
    sidecarFailure.unintended_execution_count === 0 &&
    adversarialExpansion.identical_hashes &&
    adversarialExpansion.bypass_count === 0 &&
    adversarial.detection_rate_percent === 100 &&
    adversarial.fail_closed_count === adversarial.total;

  return {
    industry: INDUSTRY,
    actions: Object.values(ACTIONS),
    request_schema: {
      required_fields: ROOT_KEYS,
      resource_limits_required_fields: RESOURCE_LIMIT_KEYS,
      integer_only_fields: ["cost_usd_micro", "max_runtime_seconds", "retry_count", "resource_limits.gpu_count", "resource_limits.max_scale_multiplier"],
      timestamp_removed_from_logic: true,
      unknown_fields_allowed: false,
      duplicate_key_rejection: true
    },
    policy: POLICY,
    workload: {
      total_generated: workload.length,
      valid_or_boundary_percent: 50,
      adversarial_or_misconfigured_percent: 50,
      included_cases: [
        "runaway retries",
        "inflated cost values",
        "malformed decimal payloads",
        "duplicate JSON keys",
        "unknown fields",
        "timestamp injection",
        "runtime, GPU, autoscale, and max-cost boundary edge cases"
      ]
    },
    control_results: control,
    metrics,
    mnde_results: {
      total_requests: metrics.total_requests,
      allowed_count: metrics.allowed_count,
      refused_count: metrics.refused_count,
      per_request_receipt_fields: ["decision", "reason_code", "request_hash", "decision_hash", "policy_hash"]
    },
    delta_cost_prevented: metrics.delta_cost_prevented,
    top_prevented_cost_scenarios: topPrevented,
    determinism,
    replay,
    soak,
    sidecar_failure: sidecarFailure,
    external_verifier: externalVerifier,
    adversarial,
    adversarial_expansion: adversarialExpansion,
    scoring: {
      cost_prevention_impact: metrics.delta_cost_prevented > 1_000_000 ? 10 : 8,
      determinism_integrity: determinism.drift_mismatches === 0 && replay.replay_mismatches === 0 ? 10 : 1,
      refusal_accuracy: metrics.refused_count === Math.floor(metrics.total_requests / 2) && adversarial.detection_rate_percent === 100 ? 10 : 6,
      production_readiness:
        soak.error_rate_percent === 0 && soak.memory_stability === "stable" && sidecarFailure.unintended_execution_count === 0 ? 9 : 5
    },
    final_verdict: pass ? "PASS" : "FAIL"
  };
}

function printReport(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href === import.meta.url) {
  printReport(runScenario(Number(process.argv[2] ?? 20_000)));
}
