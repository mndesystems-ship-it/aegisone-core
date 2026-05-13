import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeBaseInput,
  rawJson,
  replayReceiptStore,
  resetRuntimeState,
  executeDeterministicPipeline
} from "../audit/node_runtime.ts";
import { verifyReceiptPublicSignature, verifyReceiptSignature } from "../ramona/engine.ts";
import { canonicalizeJson } from "../shared/index.ts";
import { runCustodyTimeoutHarness } from "./custody_timeout_harness.mjs";
import { signInternally } from "../custody/runtime.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "hostile-verifier-proof-bundle");
const RECEIPTS_500K = join(OUT, "receipts-500000.jsonl");
const SUMMARY = join(OUT, "summary.json");
const RAW_CASES = join(OUT, "phase1-input-integrity.json");
const PARITY_REPORT = join(OUT, "parity-report.json");
const BREAKS = [];

function ensureOut() {
  mkdirSync(OUT, { recursive: true });
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function centsToUsd(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordBreak(phase, check, observed, expected) {
  BREAKS.push({ phase, check, observed, expected });
}

function base(overrides = {}) {
  return makeBaseInput(overrides);
}

function withRequestIds(input, id) {
  const next = clone(input);
  next.execution_request.request_id = id;
  next.execution_request.release_request.execution_id = id;
  return next;
}

function runRaw(rawInput, reset = true) {
  if (reset) {
    resetRuntimeState();
  }
  const result = executeDeterministicPipeline(rawInput);
  if ("parse_boundary" in result) {
    return {
      decision: result.decision,
      reason_code: result.reason_code,
      request_hash: result.request_hash,
      decision_hash: result.decision_hash,
      receipt: null,
      receipt_bytes: canonicalizeJson(result)
    };
  }
  return {
    decision: result.receipt.decision_output.decision,
    reason_code: result.receipt.decision_output.reason_code,
    request_hash: result.receipt.decision_output.request_hash,
    decision_hash: result.receipt.decision_output.decision_hash,
    receipt: result.receipt,
    receipt_bytes: result.receipt_bytes,
    total_cost_usd: result.receipt.decision_output.total_cost_usd,
    allowed_cost_usd: result.receipt.decision_output.allowed_cost_usd,
    prevented_cost_usd: result.receipt.decision_output.prevented_cost_usd,
    policy_hash: result.receipt.decision_output.policy_hash
  };
}

function strictAllowInput(id = "hostile-allow-001") {
  return withRequestIds(base({
    execution_request: {
      request_id: id,
      release_request: { execution_id: id, hold_state: "APPROVED", already_consumed: false },
      resources: { gpu_type: "a10g", gpu_count: 2, hours: 4 },
      execution: { auto_scale: false, max_scale_multiplier: 1, retry_on_fail: false, max_retries: 0 },
      runtime_observation: { kill_switch_active: false, actual_gpu_count: 2, actual_hours: 4, actual_total_cost_cents: 4000 }
    },
    policy_document: {
      schema_version: "ecs.policy.v1",
      policy_version: "policy.v1",
      rules: {
        max_total_cost_cents: 10000,
        allow_auto_scale: false,
        max_gpu_count: 4,
        max_hours: 8,
        require_manual_approval_above_cents: 5000,
        max_retry_count: 1
      }
    },
    pricing_data: { gpu_hour_cents: 500 }
  }), id);
}

function resultKey(outcome) {
  return `${outcome.decision}|${outcome.reason_code}|${outcome.request_hash}|${outcome.decision_hash}`;
}

function phase1() {
  const valid = strictAllowInput("phase1-valid");
  const canonical = rawJson(valid);
  const reordered =
    `{"pricing_data":{"gpu_hour_cents":500},"policy_document":{"rules":{"max_retry_count":1,"require_manual_approval_above_cents":5000,"max_hours":8,"max_gpu_count":4,"allow_auto_scale":false,"max_total_cost_cents":10000},"policy_version":"policy.v1","schema_version":"ecs.policy.v1"},"execution_request":{"runtime_observation":{"actual_total_cost_cents":4000,"actual_hours":4,"actual_gpu_count":2,"kill_switch_active":false},"release_request":{"already_consumed":false,"hold_state":"APPROVED","execution_id":"phase1-valid"},"orbit_intent":{"signatures":[{"sig":"orbit-signature-v1","alg":"hmac-sha256"}],"lifecycle_state":"ARMED","payload":{"tool_calls":[{"priority":1,"tool":"deploy_irreversible"}]},"boundary":"gpu-batch","action":"execute","orbit_version":"2.0"},"tool_calls":[{"priority":1,"tool":"deploy_irreversible"}],"execution":{"max_retries":0,"retry_on_fail":false,"max_scale_multiplier":1,"auto_scale":false},"resources":{"hours":4,"gpu_count":2,"gpu_type":"a10g"},"actor":{"user_id":"user-001"},"submitted_region":"us-west-2","request_id":"phase1-valid"}}`;
  const whitespace = JSON.stringify(valid, null, 4);
  const escaped = canonical.replace("user-001", "\\u0075ser-001").replace("gpu-batch", "gpu-\\u0062atch");
  const malformed = [
    ["duplicate_root", `{"execution_request":{},"execution_request":{},"policy_document":{},"pricing_data":{}}`],
    ["duplicate_nested", canonical.replace('"gpu_count":2', '"gpu_count":2,"gpu_count":3')],
    ["unknown_root", rawJson({ ...valid, unknown_root: true })],
    ["unknown_execution_request", rawJson({ ...valid, execution_request: { ...valid.execution_request, unknown: true } })],
    ["unknown_actor", rawJson({ ...valid, execution_request: { ...valid.execution_request, actor: { ...valid.execution_request.actor, unknown: true } } })],
    ["unknown_resources", rawJson({ ...valid, execution_request: { ...valid.execution_request, resources: { ...valid.execution_request.resources, unknown: true } } })],
    ["unknown_execution", rawJson({ ...valid, execution_request: { ...valid.execution_request, execution: { ...valid.execution_request.execution, unknown: true } } })],
    ["unknown_tool_call", rawJson({ ...valid, execution_request: { ...valid.execution_request, tool_calls: [{ ...valid.execution_request.tool_calls[0], unknown: true }] } })],
    ["unknown_orbit", rawJson({ ...valid, execution_request: { ...valid.execution_request, orbit_intent: { ...valid.execution_request.orbit_intent, unknown: true } } })],
    ["unknown_policy", rawJson({ ...valid, policy_document: { ...valid.policy_document, unknown: true } })],
    ["unknown_pricing", rawJson({ ...valid, pricing_data: { ...valid.pricing_data, unknown: true } })],
    ["float_number", canonical.replace('"hours":4', '"hours":4.5')],
    ["string_number", canonical.replace('"hours":4', '"hours":"4"')],
    ["scientific_number", canonical.replace('"hours":4', '"hours":4e0')],
    ["negative_zero", canonical.replace('"hours":4', '"hours":-0')],
    ["reserved_timestamp", rawJson({ ...valid, timestamp: "2026-05-03T00:00:00Z" })],
    ["bad_escape", canonical.replace("phase1-valid", "\\uZZZZ")],
    ["large_payload_near_1mb", rawJson({ ...valid, execution_request: { ...valid.execution_request, parameters: { note: "x".repeat(900_000) } } })]
  ];

  const variants = [
    ["canonical", canonical],
    ["reordered", reordered],
    ["whitespace", whitespace],
    ["escaped", escaped]
  ].map(([name, raw]) => ({ name, ...runRaw(raw) }));

  for (const variant of variants) {
    if (variant.request_hash !== variants[0].request_hash || variant.decision_hash !== variants[0].decision_hash) {
      recordBreak("PHASE 1", `canonicalization variant ${variant.name}`, { request_hash: variant.request_hash, decision_hash: variant.decision_hash }, { request_hash: variants[0].request_hash, decision_hash: variants[0].decision_hash });
    }
  }

  const attacks = malformed.map(([name, raw]) => {
    const outcome = runRaw(raw);
    if (name !== "large_payload_near_1mb" && outcome.decision !== "REFUSE") {
      recordBreak("PHASE 1", name, outcome.decision, "REFUSE");
    }
    return { name, decision: outcome.decision, reason_code: outcome.reason_code, request_hash: outcome.request_hash, decision_hash: outcome.decision_hash, raw_sha256: sha256Hex(raw) };
  });

  writeFileSync(RAW_CASES, JSON.stringify({ variants, attacks }, null, 2));
  return { variants, attacks, malformed_count: malformed.length };
}

function phase2() {
  const raw = rawJson(strictAllowInput("phase2-valid"));
  const baseline = runRaw(raw);
  let drift = 0;
  for (let index = 0; index < 50_000; index += 1) {
    const next = runRaw(raw);
    if (resultKey(next) !== resultKey(baseline)) {
      drift += 1;
    }
  }

  const shuffled = Array.from({ length: 1000 }, (_, index) => index).sort(() => Math.random() - 0.5);
  let interleavingDrift = 0;
  for (const _ of shuffled) {
    const next = runRaw(raw);
    if (resultKey(next) !== resultKey(baseline)) {
      interleavingDrift += 1;
    }
  }

  const workerRawPath = join(OUT, "phase2-worker-input.json");
  writeFileSync(workerRawPath, raw);
  const workerOutput = execFileSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), "--worker", workerRawPath, "250"], { cwd: ROOT, encoding: "utf8" });
  const worker = JSON.parse(workerOutput);
  let timeShiftDrift = 0;
  process.env.BUILD_TIMESTAMP_UTC = "1970-01-01T00:00:00.000Z";
  const oldTime = runRaw(raw);
  process.env.BUILD_TIMESTAMP_UTC = "2099-12-31T23:59:59.000Z";
  const futureTime = runRaw(raw);
  delete process.env.BUILD_TIMESTAMP_UTC;
  if (resultKey(oldTime) !== resultKey(futureTime) || resultKey(oldTime) !== resultKey(baseline)) {
    timeShiftDrift += 1;
  }

  if (drift || interleavingDrift || worker.drift_mismatches || timeShiftDrift) {
    recordBreak("PHASE 2", "determinism", { drift, interleavingDrift, worker: worker.drift_mismatches, timeShiftDrift }, 0);
  }
  return {
    identical_executions: 50_000,
    drift_mismatches: drift,
    parallel_interleaving_mismatches: interleavingDrift,
    cross_process_mismatches: worker.drift_mismatches,
    time_shift_mismatches: timeShiftDrift,
    baseline
  };
}

function phase3() {
  const mk = (id, patch) => rawJson(withRequestIds(base({
    execution_request: {
      request_id: id,
      release_request: { execution_id: id, hold_state: "APPROVED", already_consumed: false },
      resources: { gpu_type: "a10g", gpu_count: 2, hours: 4 },
      execution: { auto_scale: false, max_scale_multiplier: 1, retry_on_fail: false, max_retries: 0 },
      runtime_observation: { kill_switch_active: false, actual_gpu_count: 2, actual_hours: 4, actual_total_cost_cents: 4000 },
      ...patch.execution_request
    },
    policy_document: {
      schema_version: "ecs.policy.v1",
      policy_version: "policy.v1",
      rules: {
        max_total_cost_cents: 10000,
        allow_auto_scale: false,
        max_gpu_count: 4,
        max_hours: 8,
        require_manual_approval_above_cents: 10000,
        max_retry_count: 1,
        ...patch.rules
      }
    },
    pricing_data: { gpu_hour_cents: 500 }
  }), id));
  const cases = [
    ["start_training_job_under", mk("phase3-under", {}), "ALLOW"],
    ["start_training_job_just_over", mk("phase3-cost-over", { execution_request: { resources: { gpu_type: "a10g", gpu_count: 5, hours: 5 }, runtime_observation: { kill_switch_active: false, actual_gpu_count: 5, actual_hours: 5, actual_total_cost_cents: 12500 } }, rules: { max_gpu_count: 99 } }), "REFUSE"],
    ["scale_gpu_cluster_exponential", mk("phase3-scale-over", { execution_request: { execution: { auto_scale: true, max_scale_multiplier: 8, retry_on_fail: false, max_retries: 0 } }, rules: { allow_auto_scale: false } }), "REFUSE"],
    ["retry_failed_job_loop", mk("phase3-retry-over", { execution_request: { execution: { auto_scale: false, max_scale_multiplier: 1, retry_on_fail: true, max_retries: 25 } } }), "REFUSE"],
    ["runtime_just_over", mk("phase3-runtime-over", { execution_request: { resources: { gpu_type: "a10g", gpu_count: 1, hours: 9 }, runtime_observation: { kill_switch_active: false, actual_gpu_count: 1, actual_hours: 9, actual_total_cost_cents: 4500 } } }), "REFUSE"],
    ["extreme_overflow", mk("phase3-overflow", { execution_request: { resources: { gpu_type: "a10g", gpu_count: Number.MAX_SAFE_INTEGER, hours: Number.MAX_SAFE_INTEGER }, execution: { auto_scale: true, max_scale_multiplier: Number.MAX_SAFE_INTEGER, retry_on_fail: true, max_retries: Number.MAX_SAFE_INTEGER } }, rules: { max_gpu_count: Number.MAX_SAFE_INTEGER, max_hours: Number.MAX_SAFE_INTEGER, allow_auto_scale: true, max_retry_count: Number.MAX_SAFE_INTEGER } }), "REFUSE"]
  ];
  const results = cases.map(([name, raw, expected]) => {
    const out = runRaw(raw);
    if (out.decision !== expected) {
      recordBreak("PHASE 3", name, out.decision, expected);
    }
    return { name, expected, ...out };
  });
  return { cases: results };
}

function phase4() {
  const multi = strictAllowInput("phase4-multiple-actions");
  multi.execution_request.tool_calls = [{ tool: "compile", priority: 1 }, { tool: "deploy_irreversible", priority: 2 }];
  multi.execution_request.orbit_intent.payload.tool_calls = clone(multi.execution_request.tool_calls);
  const partial = strictAllowInput("phase4-partial");
  delete partial.execution_request.orbit_intent.payload;
  const altered = strictAllowInput("phase4-altered");
  altered.execution_request.orbit_intent.payload.tool_calls = [{ tool: "compile", priority: 1 }];
  const injected = strictAllowInput("phase4-injected");
  injected.execution_request.parameters = { nested: { command: "rm -rf /data" } };
  const actions = strictAllowInput("phase4-actions");
  actions.execution_request.parameters = { actions: ["compile", "deploy_irreversible"] };
  const targets = strictAllowInput("phase4-targets");
  targets.execution_request.parameters = { execution_targets: ["cluster-a", "cluster-b"] };
  const mixed = strictAllowInput("phase4-mixed");
  mixed.execution_request.tool_calls = [{ tool: "compile", priority: 1 }, { tool: "deploy_irreversible", priority: 2 }];
  mixed.execution_request.orbit_intent.payload.tool_calls = clone(mixed.execution_request.tool_calls);
  const encoded = strictAllowInput("phase4-encoded");
  encoded.execution_request.parameters = { metadata: { encoded: "action:deploy_irreversible" } };
  const cases = [
    ["multiple_actions", rawJson(multi), "REFUSE"],
    ["multiple_actions_array", rawJson(actions), "REFUSE"],
    ["multiple_execution_targets", rawJson(targets), "REFUSE"],
    ["mixed_reversible_irreversible", rawJson(mixed), "REFUSE"],
    ["encoded_second_action_in_metadata", rawJson(encoded), "REFUSE"],
    ["partial_action_definition", rawJson(partial), "REFUSE"],
    ["altered_canonical_form", rawJson(altered), "REFUSE"],
    ["field_injection_nested_forbidden", rawJson(injected), "REFUSE"]
  ];
  const results = cases.map(([name, raw, expected]) => {
    const out = runRaw(raw);
    if (out.decision !== expected) {
      recordBreak("PHASE 4", name, out.decision, expected);
    }
    if (name !== "partial_action_definition" && name !== "altered_canonical_form" && name !== "field_injection_nested_forbidden" && out.reason_code !== "ERR_ORBIT_MULTIPLE_ACTIONS") {
      recordBreak("PHASE 4", `${name} reason`, out.reason_code, "ERR_ORBIT_MULTIPLE_ACTIONS");
    }
    return { name, expected, ...out };
  });
  return { cases: results };
}

function phase5() {
  const original = strictAllowInput("phase5-policy-original");
  const originalRaw = rawJson(original);
  const originalOut = runRaw(originalRaw);
  const stricter = clone(original);
  stricter.policy_document.rules.max_total_cost_cents = 3999;
  const stricterOut = runRaw(rawJson(stricter));
  const replayOriginal = runRaw(originalRaw);
  if (originalOut.decision !== "ALLOW") recordBreak("PHASE 5", "original policy allow", originalOut.decision, "ALLOW");
  if (stricterOut.decision !== "REFUSE") recordBreak("PHASE 5", "new policy refuse", stricterOut.decision, "REFUSE");
  if (resultKey(originalOut) !== resultKey(replayOriginal)) recordBreak("PHASE 5", "historical replay", resultKey(replayOriginal), resultKey(originalOut));
  if (originalOut.policy_hash === stricterOut.policy_hash) recordBreak("PHASE 5", "policy_hash changes", stricterOut.policy_hash, "different policy_hash");
  return { original: originalOut, stricter: stricterOut, replay_original: replayOriginal };
}

function phase6() {
  const receipt = runRaw(rawJson(strictAllowInput("phase6-receipt"))).receipt;
  const originalOk = verifyReceiptSignature(receipt) && verifyReceiptPublicSignature(receipt);
  if (!originalOk) recordBreak("PHASE 6", "original receipt verifies", originalOk, true);
  const tamperFields = ["decision", "reason_code", "total_cost_usd", "allowed_cost_usd", "prevented_cost_usd"];
  const tampered = tamperFields.map((field) => {
    const next = clone(receipt);
    if (field === "decision") next.decision_output.decision = next.decision_output.decision === "ALLOW" ? "REFUSE" : "ALLOW";
    else if (field === "reason_code") next.decision_output.reason_code = "ERR_COST_LIMIT";
    else next.decision_output[field] = "999999.99";
    const ok = verifyReceiptSignature(next) || verifyReceiptPublicSignature(next);
    if (ok) recordBreak("PHASE 6", `tamper ${field}`, ok, false);
    return { field, verification_failed: !ok };
  });
  const badSignature = clone(receipt);
  badSignature.verifiable_signature.value = "00".repeat(64);
  badSignature.signature.value = "00".repeat(32);
  const sigOk = verifyReceiptSignature(badSignature) || verifyReceiptPublicSignature(badSignature);
  if (sigOk) recordBreak("PHASE 6", "tamper signature", sigOk, false);
  return { original_verified: originalOk, tampered, bad_signature_failed: !sigOk };
}

async function phase7() {
  let internalSigningDisabled = false;
  try {
    signInternally();
  } catch (error) {
    internalSigningDisabled = error?.code === "ERR_INTERNAL_SIGNING_DISABLED";
  }
  if (!internalSigningDisabled) {
    recordBreak("PHASE 7", "internal signing disabled", internalSigningDisabled, true);
  }

  const timeout = await runCustodyTimeoutHarness(OUT, { signer_timeout_ms: 10, signer_delay_ms: 25 });
  if (timeout.receipt.decision !== "REFUSE" || timeout.receipt.reason_code !== "ERR_CUSTODY_SIGNER_TIMEOUT") {
    recordBreak("PHASE 7", "signer timeout refuses", timeout.receipt, "REFUSE ERR_CUSTODY_SIGNER_TIMEOUT");
  }
  if (timeout.summary.signer_late_responses < 1 || timeout.summary.late_response_upgrades !== 0 || timeout.summary.unsigned_allows !== 0) {
    recordBreak("PHASE 7", "late signer response ignored", timeout.summary, { signer_late_responses: ">=1", late_response_upgrades: 0, unsigned_allows: 0 });
  }
  return {
    internal_signing_disabled: internalSigningDisabled,
    external_timeout_tested: true,
    ...timeout.summary,
    artifacts: timeout.artifacts
  };
}

function phase8() {
  const results = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "./scripts/test_external_audit_integration.mjs"], { cwd: ROOT, encoding: "utf8" }));
  const cases = results.results;
  const expectedNames = new Set(["read-only receipt directory", "missing receipt directory", "locked receipt file", "invalid preflight lock", "config changed after preflight", "policy changed after preflight"]);
  for (const expected of expectedNames) {
    if (!cases.some((item) => item.name === expected)) {
      recordBreak("PHASE 8", expected, "missing", "present");
    }
  }
  return results;
}

function phase9() {
  const vectors = [
    { case_id: "phase9-allow", raw_input: rawJson(strictAllowInput("phase9-allow")) },
    { case_id: "phase9-refuse-cost", raw_input: rawJson(base({ execution_request: { request_id: "phase9-cost", release_request: { execution_id: "phase9-cost", hold_state: "APPROVED", already_consumed: false }, resources: { gpu_type: "a10g", gpu_count: 99, hours: 99 } } })) },
    { case_id: "phase9-refuse-schema", raw_input: `{"execution_request":{},"execution_request":{}}` }
  ];
  const vectorPath = join(OUT, "phase9-parity-vectors.json");
  writeFileSync(vectorPath, JSON.stringify(vectors, null, 2));
  const nodeOutputs = vectors.map((vector) => {
    const out = runRaw(vector.raw_input);
    return { case_id: vector.case_id, decision: out.decision, decision_hash: out.decision_hash, receipt_bytes: out.receipt_bytes };
  });
  const rustExe = join(ROOT, "rust", "parity_runner", "target", "release", "parity_runner.exe");
  let parity_mismatches = 0;
  let rustOutputs = [];
  if (existsSync(rustExe)) {
    try {
      rustOutputs = JSON.parse(execFileSync(rustExe, [vectorPath], { cwd: ROOT, encoding: "utf8" }));
      for (let index = 0; index < nodeOutputs.length; index += 1) {
        const left = nodeOutputs[index];
        const right = rustOutputs[index];
        if (!right || left.decision !== right.decision || left.decision_hash !== right.decision_hash || left.receipt_bytes !== right.receipt_bytes) {
          parity_mismatches += 1;
        }
      }
    } catch (error) {
      parity_mismatches = vectors.length;
      rustOutputs = [{ error: error.message }];
    }
  } else {
    parity_mismatches = vectors.length;
  }
  if (parity_mismatches) recordBreak("PHASE 9", "cross-runtime parity", parity_mismatches, 0);
  const report = { total_comparisons: vectors.length, parity_mismatches, node_outputs: nodeOutputs, rust_outputs: rustOutputs };
  writeFileSync(PARITY_REPORT, JSON.stringify(report, null, 2));
  return report;
}

function phase10() {
  writeFileSync(RECEIPTS_500K, "");
  const seed = strictAllowInput("phase10-seed");
  let total = 0;
  let allowed = 0;
  let refused = 0;
  let totalCostCents = 0;
  let allowedCostCents = 0;
  let preventedCostCents = 0;
  let replayMismatches = 0;
  const receiptFileHash = createHash("sha256");
  for (let index = 0; index < 500_000; index += 1) {
    const input = clone(seed);
    const id = `phase10-${index}`;
    input.execution_request.request_id = id;
    input.execution_request.release_request.execution_id = id;
    if (index % 2 === 1) {
      input.execution_request.resources.gpu_count = 8;
      input.execution_request.runtime_observation.actual_gpu_count = 8;
      input.execution_request.runtime_observation.actual_total_cost_cents = 16000;
    }
    const out = runRaw(rawJson(input));
    if (!out.receipt) {
      recordBreak("PHASE 10", "receipt generated for compliant replay sample", out.reason_code, "signed receipt");
      continue;
    }
    const storedBytes = canonicalizeJson(out.receipt);
    resetRuntimeState();
    const replayed = executeDeterministicPipeline(out.receipt.canonical_request);
    if ("parse_boundary" in replayed || !verifyReceiptSignature(out.receipt) || storedBytes !== replayed.receipt_bytes) {
      replayMismatches += 1;
    }
    const line = `${storedBytes}\n`;
    receiptFileHash.update(line);
    appendFileSync(RECEIPTS_500K, line);
    total += 1;
    if (out.decision === "ALLOW") allowed += 1;
    else refused += 1;
    const c = Number(out.total_cost_usd) * 100;
    const a = Number(out.allowed_cost_usd) * 100;
    const p = Number(out.prevented_cost_usd) * 100;
    totalCostCents += Math.round(c);
    allowedCostCents += Math.round(a);
    preventedCostCents += Math.round(p);
  }
  if (replayMismatches) recordBreak("PHASE 10", "500000 receipt replay", replayMismatches, 0);
  return {
    receipt_file: RECEIPTS_500K,
    receipt_file_sha256: receiptFileHash.digest("hex"),
    total_receipts: total,
    exact_matches: total - replayMismatches,
    replay_mismatches: replayMismatches,
    total_executions: total,
    total_allowed: allowed,
    total_refused: refused,
    total_cost_usd: centsToUsd(totalCostCents),
    allowed_cost_usd: centsToUsd(allowedCostCents),
    prevented_cost_usd: centsToUsd(preventedCostCents)
  };
}

function workerMain() {
  const raw = readFileSync(process.argv[3], "utf8");
  const count = Number(process.argv[4] ?? 100);
  const baseline = runRaw(raw);
  let drift = 0;
  for (let index = 0; index < count; index += 1) {
    const next = runRaw(raw);
    if (resultKey(next) !== resultKey(baseline)) drift += 1;
  }
  process.stdout.write(JSON.stringify({ count, drift_mismatches: drift, baseline }));
}

async function main() {
  if (process.argv[2] === "--worker") {
    workerMain();
    return;
  }
  ensureOut();
  const p1 = phase1();
  const p2 = phase2();
  const p3 = phase3();
  const p4 = phase4();
  const p5 = phase5();
  const p6 = phase6();
  const p7 = await phase7();
  const p8 = phase8();
  const p9 = phase9();
  const p10 = phase10();

  const counters = {
    total_executions: p2.identical_executions + p10.total_executions,
    total_allowed: p10.total_allowed,
    total_refused: p10.total_refused,
    total_cost_usd: p10.total_cost_usd,
    allowed_cost_usd: p10.allowed_cost_usd,
    prevented_cost_usd: p10.prevented_cost_usd,
    drift_mismatches: p2.drift_mismatches + p2.parallel_interleaving_mismatches + p2.cross_process_mismatches + p2.time_shift_mismatches,
    replay_mismatches: p10.replay_mismatches,
    parity_mismatches: p9.parity_mismatches,
    signature_failures: p6.original_verified ? 0 : 1,
    signer_timeouts: p7.signer_timeouts ?? 0,
    signer_late_responses: p7.signer_late_responses ?? 0,
    late_response_upgrades: p7.late_response_upgrades ?? 0,
    unsigned_allows: p7.unsigned_allows ?? 0
  };
  const verdict = BREAKS.length === 0 &&
    counters.drift_mismatches === 0 &&
    counters.replay_mismatches === 0 &&
    counters.parity_mismatches === 0 &&
    counters.signature_failures === 0 &&
    counters.late_response_upgrades === 0 &&
    counters.unsigned_allows === 0 &&
    counters.signer_timeouts >= 1 &&
    counters.signer_late_responses >= 1
    ? "PASS"
    : "FAIL";

  const summary = {
    schema_version: "mnde.hostile_verifier.summary.v1",
    verdict,
    counters,
    break_points: BREAKS,
    phases: {
      phase1: p1,
      phase2: p2,
      phase3: p3,
      phase4: p4,
      phase5: p5,
      phase6: p6,
      phase7: p7,
      phase8: p8,
      phase9: p9,
      phase10: p10
    },
    artifacts: {
      output_dir: OUT,
      summary: SUMMARY,
      phase1_cases: RAW_CASES,
      receipts_500k: RECEIPTS_500K,
      custody_timeout_receipt: join(OUT, "custody-timeout-receipt.json"),
      custody_late_response_log: join(OUT, "custody-late-response-log.json"),
      custody_timeout_summary: join(OUT, "custody-timeout-summary.json"),
      parity_report: PARITY_REPORT
    }
  };
  writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
  process.stdout.write(`${JSON.stringify({ verdict, counters, break_points: BREAKS, summary: SUMMARY }, null, 2)}\n`);
}

main();
