import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  executeDeterministicPipeline,
  makeBaseInput,
  rawJson,
  resetRuntimeState,
  verifySignedReceipt
} from "../audit/node_runtime.ts";
import { canonicalizeJson } from "../shared/index.ts";
import {
  decisionCoreFromReceipt,
  encodeDecisionCore,
  hashBinary,
  observeBinaryExperiment
} from "../app/encoding/binary_experiment.js";

const TOTAL_DECISIONS = Number.parseInt(process.env.MNDE_BINARY_SCALE_DECISIONS ?? "100000", 10);
const DETERMINISM_RUNS = Number.parseInt(process.env.MNDE_BINARY_DETERMINISM_RUNS ?? "50000", 10);
const RESULTS_PATH = join(process.cwd(), "results", "binary_experiment.jsonl");
const MB = 1024 * 1024;

if (!Number.isSafeInteger(TOTAL_DECISIONS) || TOTAL_DECISIONS < 100000) {
  throw new Error("MNDE_BINARY_SCALE_DECISIONS must be at least 100000");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest();
}

function digestInto(target, index, value) {
  target.set(sha256Bytes(value), index * 32);
}

function digestEquals(target, index, value) {
  const actual = sha256Bytes(value);
  const offset = index * 32;
  for (let inner = 0; inner < 32; inner += 1) {
    if (target[offset + inner] !== actual[inner]) {
      return false;
    }
  }
  return true;
}

function jsonCoreBytes(core) {
  return Buffer.byteLength(canonicalizeJson(core));
}

function memoryMb() {
  return Number((process.memoryUsage().heapUsed / MB).toFixed(2));
}

function percentile(sorted, pct) {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(6));
}

function removeExperimentOutput() {
  if (existsSync(RESULTS_PATH)) {
    rmSync(RESULTS_PATH);
  }
}

function baseCase(caseId, overrides = {}) {
  return rawJson(
    makeBaseInput({
      ...overrides,
      execution_request: {
        request_id: `scale-${caseId}`,
        release_request: {
          execution_id: `scale-${caseId}`,
          hold_state: "APPROVED",
          already_consumed: false
        },
        ...overrides.execution_request
      }
    })
  );
}

function buildWorkloadItem(index) {
  const bucket = index % 20;
  if (bucket === 0) {
    return {
      name: "repeated_identical_allow",
      raw: baseCase("fixed-repeat")
    };
  }
  if (bucket === 1) {
    return { name: "max_cost_boundary", raw: baseCase(`max-cost-${index}`, { policy_document: { rules: { max_total_cost_cents: 4000 } } }) };
  }
  if (bucket === 2) {
    return {
      name: "cost_limit",
      raw: baseCase(`cost-${index}`, {
        execution_request: { resources: { gpu_count: 32, hours: 72 } },
        policy_document: { rules: { max_total_cost_cents: 1_000 } }
      })
    };
  }
  if (bucket === 3) {
    return {
      name: "autoscale_denied",
      raw: baseCase(`autoscale-${index}`, {
        execution_request: { execution: { auto_scale: true, max_scale_multiplier: 2 } },
        policy_document: { rules: { allow_auto_scale: false } }
      })
    };
  }
  if (bucket === 4) {
    return {
      name: "gpu_limit",
      raw: baseCase(`gpu-${index}`, {
        execution_request: { resources: { gpu_count: 5 } },
        policy_document: { rules: { max_gpu_count: 4 } }
      })
    };
  }
  if (bucket === 5) {
    return {
      name: "hours_limit",
      raw: baseCase(`hours-${index}`, {
        execution_request: { resources: { hours: 9 } },
        policy_document: { rules: { max_hours: 8 } }
      })
    };
  }
  if (bucket === 6) {
    return {
      name: "retry_limit",
      raw: baseCase(`retry-${index}`, {
        execution_request: { execution: { retry_on_fail: true, max_retries: 6 } },
        policy_document: { rules: { max_retry_count: 5 } }
      })
    };
  }
  if (bucket === 7) {
    return { name: "kill_switch", raw: baseCase(`kill-${index}`, { execution_request: { runtime_observation: { kill_switch_active: true } } }) };
  }
  if (bucket === 8) {
    return {
      name: "runtime_gpu_drift",
      raw: baseCase(`runtime-gpu-${index}`, { execution_request: { runtime_observation: { actual_gpu_count: 3 } } })
    };
  }
  if (bucket === 9) {
    return {
      name: "runtime_hours_drift",
      raw: baseCase(`runtime-hours-${index}`, { execution_request: { runtime_observation: { actual_hours: 5 } } })
    };
  }
  if (bucket === 10) {
    return {
      name: "runtime_cost_drift",
      raw: baseCase(`runtime-cost-${index}`, { execution_request: { runtime_observation: { actual_total_cost_cents: 4_001 } } })
    };
  }
  if (bucket === 11) {
    return {
      name: "orbit_multiple_actions",
      raw: baseCase(`multi-${index}`, {
        execution_request: {
          parameters: { nested: { action: "deploy_irreversible" } }
        }
      })
    };
  }
  if (bucket === 12) {
    return {
      name: "tool_call_sequence",
      raw: baseCase(`tool-${index}`, {
        execution_request: {
          orbit_intent: { payload: { tool_calls: [{ tool: "compile", priority: 1 }] } }
        }
      })
    };
  }
  if (bucket === 13) {
    return {
      name: "policy_version_mismatch",
      raw: baseCase(`policy-version-${index}`, { policy_document: { policy_version: "policy.v2" } })
    };
  }
  if (bucket === 14) {
    return {
      name: "randomized_valid",
      raw: baseCase(`random-${index}`, {
        execution_request: {
          resources: { gpu_count: (index % 4) + 1, hours: (index % 8) + 1 },
          runtime_observation: { actual_gpu_count: (index % 4) + 1, actual_hours: (index % 8) + 1 }
        },
        pricing_data: { gpu_hour_cents: 100 + (index % 900) }
      })
    };
  }
  return { name: "allow", raw: baseCase(`allow-${index}`) };
}

function extractOutcome(result) {
  if ("parse_boundary" in result) {
    return {
      receipt: null,
      receiptBytes: canonicalizeJson(result),
      decision: result.decision,
      reason: result.reason_code,
      requestHash: result.request_hash,
      decisionHash: result.decision_hash,
      signature: "",
      publicSignature: "",
      signed: true
    };
  }
  return {
    receipt: result.receipt,
    receiptBytes: result.receipt_bytes,
    decision: result.receipt.decision_output.decision,
    reason: result.receipt.decision_output.reason_code,
    requestHash: result.receipt.decision_output.request_hash,
    decisionHash: result.receipt.decision_output.decision_hash,
    signature: result.receipt.signature.value,
    publicSignature: result.receipt.verifiable_signature?.value ?? "",
    signed: verifySignedReceipt(result.receipt)
  };
}

function runPass(flagValue, expected = null) {
  process.env.MNDE_BINARY_EXPERIMENT = flagValue;
  resetRuntimeState();
  if (flagValue === "1") {
    removeExperimentOutput();
  }

  let jsonCoreBytesTotal = 0;
  let binaryCoreBytesTotal = 0;
  let encoderErrors = 0;
  let observerErrors = 0;
  let binaryCalls = 0;
  let decisionMismatches = 0;
  let hashMismatches = 0;
  let signatureMismatches = 0;
  let peakMemoryMb = memoryMb();
  const encodeTimes = [];
  const compact = expected
    ? null
    : {
        decision: new Uint8Array(TOTAL_DECISIONS * 32),
        hashes: new Uint8Array(TOTAL_DECISIONS * 32),
        signatures: new Uint8Array(TOTAL_DECISIONS * 32),
        receipts: new Uint8Array(TOTAL_DECISIONS * 32)
      };

  for (let index = 0; index < TOTAL_DECISIONS; index += 1) {
    const { raw } = buildWorkloadItem(index);
    const result = executeDeterministicPipeline(raw);
    const outcome = extractOutcome(result);
    if (flagValue === "1" && outcome.receipt) {
      binaryCalls += 1;
      const observed = observeBinaryExperiment(outcome.receipt);
      if (!observed.ok) {
        observerErrors += 1;
      }
      const core = decisionCoreFromReceipt(outcome.receipt);
      const start = performance.now();
      try {
        binaryCalls += 1;
        const binary = encodeDecisionCore(core);
        encodeTimes.push(performance.now() - start);
        jsonCoreBytesTotal += jsonCoreBytes(core);
        binaryCoreBytesTotal += binary.length;
      } catch {
        encodeTimes.push(performance.now() - start);
        encoderErrors += 1;
      }
    }

    const item = {
      decision: outcome.decision,
      reason: outcome.reason,
      requestHash: outcome.requestHash,
      decisionHash: outcome.decisionHash,
      signature: outcome.signature,
      publicSignature: outcome.publicSignature,
      receiptHash: sha256(outcome.receiptBytes),
      signed: outcome.signed
    };

    if (!item.signed) {
      signatureMismatches += 1;
    }

    if (expected) {
      if (!digestEquals(expected.decision, index, `${item.decision}|${item.reason}`)) {
        decisionMismatches += 1;
      }
      if (!digestEquals(expected.hashes, index, `${item.requestHash}|${item.decisionHash}`)) {
        hashMismatches += 1;
      }
      if (!digestEquals(expected.signatures, index, `${item.signature}|${item.publicSignature}`) || !item.signed) {
        signatureMismatches += 1;
      }
      if (!digestEquals(expected.receipts, index, item.receiptHash)) {
        decisionMismatches += 1;
      }
    } else {
      digestInto(compact.decision, index, `${item.decision}|${item.reason}`);
      digestInto(compact.hashes, index, `${item.requestHash}|${item.decisionHash}`);
      digestInto(compact.signatures, index, `${item.signature}|${item.publicSignature}`);
      digestInto(compact.receipts, index, item.receiptHash);
    }

    if (index % 1000 === 0) {
      peakMemoryMb = Math.max(peakMemoryMb, memoryMb());
    }
  }

  peakMemoryMb = Math.max(peakMemoryMb, memoryMb());
  encodeTimes.sort((left, right) => left - right);
  return {
    compact,
    jsonCoreBytesTotal,
    binaryCoreBytesTotal,
    encoderErrors,
    observerErrors,
    binaryCalls,
    decisionMismatches,
    hashMismatches,
    signatureMismatches,
    p50: percentile(encodeTimes, 50),
    p95: percentile(encodeTimes, 95),
    p99: percentile(encodeTimes, 99),
    peakMemoryMb
  };
}

function determinismUniqueHashes() {
  process.env.MNDE_BINARY_EXPERIMENT = "1";
  resetRuntimeState();
  const fixedRaw = baseCase("determinism-fixed");
  const first = executeDeterministicPipeline(fixedRaw);
  const core = decisionCoreFromReceipt(extractOutcome(first).receipt);
  const hashes = new Set();
  for (let index = 0; index < DETERMINISM_RUNS; index += 1) {
    hashes.add(hashBinary(encodeDecisionCore(core)));
  }
  return hashes.size;
}

function tamperDetected(sample) {
  const original = hashBinary(encodeDecisionCore(sample));
  const tampered = hashBinary(encodeDecisionCore({ ...sample, key_set_version: `${sample.key_set_version}-tampered` }));
  return original !== tampered;
}

function failureInjectionHandled(sampleRaw) {
  process.env.MNDE_BINARY_EXPERIMENT = "1";
  resetRuntimeState();
  const normal = executeDeterministicPipeline(sampleRaw);
  if ("parse_boundary" in normal || !verifySignedReceipt(normal.receipt)) {
    return false;
  }

  const sample = decisionCoreFromReceipt(normal.receipt);
  const invalids = [
    { ...sample, request_hash: "abc" },
    { ...sample, decision: "UNKNOWN" },
    { ...sample, cost_usd_micro: 1.25 }
  ];
  const rejected = invalids.every((item) => {
    try {
      encodeDecisionCore(item);
      return false;
    } catch {
      return true;
    }
  });

  const observed = observeBinaryExperiment(normal.receipt, { MNDE_BINARY_EXPERIMENT: "1" });
  const observeContinued = observed.ok === true;

  resetRuntimeState();
  const afterInjection = executeDeterministicPipeline(sampleRaw);
  return rejected && observeContinued && !("parse_boundary" in afterInjection) && verifySignedReceipt(afterInjection.receipt);
}

const memoryStartMb = memoryMb();
const onPass = runPass("1");
const sampleCore = decisionCoreFromReceipt(extractOutcome(executeDeterministicPipeline(baseCase("tamper-sample"))).receipt);
const determinism = determinismUniqueHashes();
const tamper = tamperDetected(sampleCore);
const failureInjection = failureInjectionHandled(baseCase("failure-injection"));
const offPass = runPass("0", onPass.compact);
onPass.compact = null;
if (typeof global.gc === "function") {
  global.gc();
}
const memoryEndMb = memoryMb();
const memoryPeakMb = Math.max(onPass.peakMemoryMb, offPass.peakMemoryMb, memoryEndMb);

const jsonTotal = onPass.jsonCoreBytesTotal;
const binaryTotal = onPass.binaryCoreBytesTotal;
const bytesSaved = jsonTotal - binaryTotal;
const percentReduction = Number(((bytesSaved / jsonTotal) * 100).toFixed(2));
const memoryLeakPattern = memoryEndMb - memoryStartMb > 128 && memoryEndMb > memoryPeakMb * 0.75;
const reversibilityConfirmed =
  offPass.decisionMismatches === 0 &&
  offPass.hashMismatches === 0 &&
  offPass.signatureMismatches === 0 &&
  offPass.encoderErrors === 0 &&
  offPass.observerErrors === 0 &&
  offPass.binaryCalls === 0;

const report = {
  total_decisions: TOTAL_DECISIONS,
  json_core_bytes_total: jsonTotal,
  binary_core_bytes_total: binaryTotal,
  bytes_saved_total: bytesSaved,
  percent_reduction: percentReduction,
  p50_encode_ms: onPass.p50,
  p95_encode_ms: onPass.p95,
  p99_encode_ms: onPass.p99,
  encoder_errors: onPass.encoderErrors,
  observer_errors: onPass.observerErrors,
  decision_mismatches: offPass.decisionMismatches,
  hash_mismatches: offPass.hashMismatches,
  signature_mismatches: offPass.signatureMismatches,
  off_pass_binary_calls: offPass.binaryCalls,
  determinism_unique_hashes: determinism,
  memory_start_mb: memoryStartMb,
  memory_peak_mb: memoryPeakMb,
  memory_end_mb: memoryEndMb,
  reversibility_confirmed: reversibilityConfirmed,
  tamper_detected: tamper,
  failure_injection_handled: failureInjection,
  verdict: "FAIL"
};

const pass =
  report.decision_mismatches === 0 &&
  report.hash_mismatches === 0 &&
  report.signature_mismatches === 0 &&
  report.determinism_unique_hashes === 1 &&
  report.encoder_errors === 0 &&
  report.observer_errors === 0 &&
  report.off_pass_binary_calls === 0 &&
  report.reversibility_confirmed &&
  report.percent_reduction > 40 &&
  !memoryLeakPattern &&
  report.failure_injection_handled &&
  report.tamper_detected;

report.verdict = pass ? "PASS" : "FAIL";

process.stdout.write("BINARY_EXPERIMENT_SCALE_REPORT\n");
for (const [key, value] of Object.entries(report)) {
  process.stdout.write(`${key}: ${value}\n`);
}

if (!pass) {
  process.exitCode = 1;
}
