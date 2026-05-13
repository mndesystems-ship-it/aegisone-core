import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  executeDeterministicPipeline,
  makeBaseInput,
  rawJson,
  resetRuntimeState,
  verifySignedReceipt
} from "../audit/node_runtime.ts";
import { canonicalizeJson } from "../shared/index.ts";
import {
  binaryExperimentEnabled,
  decisionCoreFromReceipt,
  encodeDecisionCore,
  hashBinary,
  observeBinaryExperiment
} from "../app/encoding/binary_experiment.js";

const RESULTS_PATH = join(process.cwd(), "results", "binary_experiment_test.jsonl");
process.env.MNDE_BINARY_EXPERIMENT_RESULTS = RESULTS_PATH;

function freshInput(caseId, overrides = {}) {
  return rawJson(
    makeBaseInput({
      ...overrides,
      execution_request: {
        request_id: `binary-${caseId}`,
        release_request: {
          execution_id: `binary-${caseId}`,
          hold_state: "APPROVED",
          already_consumed: false
        },
        ...overrides.execution_request
      }
    })
  );
}

const DECISION_SET = [
  freshInput("allow"),
  freshInput("cost", {
    execution_request: {
      resources: { gpu_count: 32, hours: 72 }
    },
    policy_document: {
      rules: { max_total_cost_cents: 1_000 }
    }
  }),
  freshInput("autoscale", {
    execution_request: {
      execution: { auto_scale: true, max_scale_multiplier: 2 }
    },
    policy_document: {
      rules: { allow_auto_scale: false }
    }
  }),
  freshInput("gpu", {
    execution_request: {
      resources: { gpu_count: 4 }
    },
    policy_document: {
      rules: { max_gpu_count: 2 }
    }
  }),
  freshInput("kill", {
    execution_request: {
      runtime_observation: { kill_switch_active: true }
    }
  })
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function unlinkResults() {
  if (existsSync(RESULTS_PATH)) {
    rmSync(RESULTS_PATH);
  }
}

function runSet(flagValue) {
  process.env.MNDE_BINARY_EXPERIMENT = flagValue;
  unlinkResults();
  resetRuntimeState();
  return DECISION_SET.map((raw) => {
    const out = executeDeterministicPipeline(raw);
    assert.ok(!("parse_boundary" in out), "decision set must reach signed receipts");
    assert.equal(verifySignedReceipt(out.receipt), true);
    const observed = observeBinaryExperiment(out.receipt);
    assert.equal(observed.ok, true);
    return {
      receipt: out.receipt,
      receipt_bytes: out.receipt_bytes,
      line_hash: sha256(out.receipt_bytes),
      decision: out.receipt.decision_output.decision,
      reason_code: out.receipt.decision_output.reason_code,
      request_hash: out.receipt.decision_output.request_hash,
      decision_hash: out.receipt.decision_output.decision_hash,
      signature: out.receipt.signature.value,
      public_signature: out.receipt.verifiable_signature?.value ?? null
    };
  });
}

function compareStableFields(left, right) {
  return left.every((item, index) => {
    const other = right[index];
    return (
      item.decision === other.decision &&
      item.reason_code === other.reason_code &&
      item.request_hash === other.request_hash &&
      item.decision_hash === other.decision_hash
    );
  });
}

function compareSignatures(left, right) {
  return left.every((item, index) => item.signature === right[index].signature && item.public_signature === right[index].public_signature);
}

function compareReceiptBytes(left, right) {
  return left.every((item, index) => item.receipt_bytes === right[index].receipt_bytes && item.line_hash === right[index].line_hash);
}

function byteSizeMetrics(receipts) {
  let jsonCoreBytes = 0;
  let binaryCoreBytes = 0;
  for (const item of receipts) {
    const core = decisionCoreFromReceipt(item.receipt);
    const jsonCore = canonicalizeJson(core);
    const binaryCore = encodeDecisionCore(core);
    jsonCoreBytes += Buffer.byteLength(jsonCore);
    binaryCoreBytes += binaryCore.length;
  }
  return {
    json_core_bytes_total: jsonCoreBytes,
    binary_core_bytes_total: binaryCoreBytes,
    percent_reduction: Number((((jsonCoreBytes - binaryCoreBytes) / jsonCoreBytes) * 100).toFixed(2))
  };
}

function determinismUniqueHashes(core) {
  const hashes = new Set();
  for (let index = 0; index < 10_000; index += 1) {
    hashes.add(hashBinary(encodeDecisionCore(core)));
  }
  return hashes.size;
}

function tamperDetected(core) {
  const original = hashBinary(encodeDecisionCore(core));
  const tampered = hashBinary(encodeDecisionCore({ ...core, key_set_version: `${core.key_set_version}-tampered` }));
  return original !== tampered;
}

function badInputsRejected(validCore) {
  const cases = [
    { ...validCore, request_hash: "abc" },
    { ...validCore, decision: "HOLD" },
    { ...validCore, reason: "ERR_UNKNOWN_REASON" },
    { ...validCore, cost_usd_micro: 1.5 },
    { ...validCore, timestamp_ms: -1 }
  ];
  return cases.every((item) => {
    try {
      encodeDecisionCore(item);
      return false;
    } catch {
      return true;
    }
  });
}

function readExperimentLines() {
  if (!existsSync(RESULTS_PATH)) {
    return [];
  }
  return readFileSync(RESULTS_PATH, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

assert.equal(binaryExperimentEnabled({ MNDE_BINARY_EXPERIMENT: undefined }), false);
assert.equal(binaryExperimentEnabled({ MNDE_BINARY_EXPERIMENT: "0" }), false);
assert.equal(binaryExperimentEnabled({ MNDE_BINARY_EXPERIMENT: "1" }), true);

const baselineOff = runSet("0");
const flagOn = runSet("1");
const experimentLines = readExperimentLines();
let experimentErrorDidNotThrow = true;
try {
  const observed = observeBinaryExperiment(
    { decision_output: { decision: "ALLOW" } },
    { MNDE_BINARY_EXPERIMENT: "1", MNDE_BINARY_EXPERIMENT_RESULTS: RESULTS_PATH }
  );
  experimentErrorDidNotThrow = observed.ok === false;
} catch {
  experimentErrorDidNotThrow = false;
}
const reversibleOff = runSet("0");
const core = decisionCoreFromReceipt(baselineOff[0].receipt);
const metrics = byteSizeMetrics(baselineOff);

const report = {
  BINARY_EXPERIMENT_REPORT: true,
  baseline_off_identical: compareReceiptBytes(baselineOff, reversibleOff),
  flag_on_decisions_match: compareStableFields(baselineOff, flagOn),
  hashes_match: flagOn.every((item, index) => item.request_hash === baselineOff[index].request_hash && item.decision_hash === baselineOff[index].decision_hash),
  signatures_unchanged: compareSignatures(baselineOff, flagOn),
  reversible_to_baseline: compareReceiptBytes(baselineOff, reversibleOff),
  determinism_unique_hashes: determinismUniqueHashes(core),
  json_core_bytes_total: metrics.json_core_bytes_total,
  binary_core_bytes_total: metrics.binary_core_bytes_total,
  percent_reduction: metrics.percent_reduction,
  tamper_detected: tamperDetected(core),
  bad_inputs_rejected: badInputsRejected(core),
  experiment_file_lines: experimentLines.length,
  experiment_errors_blocked_flow: experimentErrorDidNotThrow && flagOn.length === DECISION_SET.length,
  verdict: "FAIL"
};

const acceptance =
  report.baseline_off_identical &&
  report.flag_on_decisions_match &&
  report.hashes_match &&
  report.signatures_unchanged &&
  report.reversible_to_baseline &&
  report.determinism_unique_hashes === 1 &&
  report.binary_core_bytes_total < report.json_core_bytes_total &&
  report.tamper_detected &&
  report.bad_inputs_rejected &&
  report.experiment_file_lines === DECISION_SET.length &&
  report.experiment_errors_blocked_flow;

report.verdict = acceptance ? "PASS" : "FAIL";

process.stdout.write("BINARY_EXPERIMENT_REPORT\n");
for (const [key, value] of Object.entries(report)) {
  if (key !== "BINARY_EXPERIMENT_REPORT" && key !== "experiment_file_lines" && key !== "experiment_errors_blocked_flow") {
    process.stdout.write(`${key}: ${value}\n`);
  }
}

if (!acceptance) {
  process.exitCode = 1;
}
