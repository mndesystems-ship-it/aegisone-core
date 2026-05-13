import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const MAGIC = Buffer.from("MNDEB1", "ascii");
const VERSION = 1;
const DEFAULT_RESULT_PATH = join(process.cwd(), "results", "binary_experiment.jsonl");

const DECISION_IDS = Object.freeze({
  REFUSE: 0,
  ALLOW: 1
});

export const REASON_ID_TABLE = Object.freeze({
  ERR_SCHEMA_VALIDATION: 1,
  ERR_DUPLICATE_JSON_KEYS: 2,
  ERR_INVALID_JSON_SYNTAX: 3,
  ERR_INVALID_JSON_NUMBER: 4,
  ERR_TYPE_MISMATCH: 5,
  ERR_NON_DETERMINISTIC_INPUT: 6,
  ERR_POLICY_VERSION_MISMATCH: 7,
  ERR_POLICY_KEY_ID_MISMATCH: 8,
  ERR_INVALID_POLICY_SIGNATURE: 9,
  ERR_TOOL_CALL_SEQUENCE: 10,
  ERR_ORBIT_MULTIPLE_ACTIONS: 11,
  ERR_FORBIDDEN_ACTION_IN_PARAMETERS: 12,
  ERR_EXECUTION_ID_ALREADY_CONSUMED: 13,
  ERR_EXECUTION_ID_REPLAYED: 14,
  ERR_BUDGET_TOKEN_EXHAUSTED: 15,
  ERR_INTEGER_OVERFLOW: 16,
  ERR_COST_LIMIT: 17,
  ERR_AUTO_SCALE_DENIED: 18,
  ERR_GPU_LIMIT: 19,
  ERR_HOURS_LIMIT: 20,
  ERR_RETRY_LIMIT: 21,
  ERR_MANUAL_APPROVAL_REQUIRED: 22,
  ERR_KILL_SWITCH: 23,
  ERR_RUNTIME_GPU_DRIFT: 24,
  ERR_RUNTIME_HOURS_DRIFT: 25,
  ERR_RUNTIME_COST_DRIFT: 26,
  ERR_RECEIPT_SIGNATURE_INVALID: 27,
  ERR_REPLAY_MISMATCH: 28,
  OK_ALLOW: 29,
  OK_ORBIT: 30,
  OK_ARM: 31,
  OK_RAM0NA: 32
});

const CORE_FIELDS = Object.freeze([
  "request_hash",
  "decision",
  "reason",
  "policy_hash",
  "decision_hash",
  "key_set_version",
  "cost_usd_micro",
  "timestamp_ms"
]);

export function binaryExperimentEnabled(env = process.env) {
  return env.MNDE_BINARY_EXPERIMENT === "1";
}

function resultPath(env = process.env) {
  return env.MNDE_BINARY_EXPERIMENT_RESULTS ?? DEFAULT_RESULT_PATH;
}

function assertNoUnknownFields(core) {
  if (typeof core !== "object" || core === null || Array.isArray(core)) {
    throw new Error("decision core must be an object");
  }
  const allowed = new Set(CORE_FIELDS);
  for (const key of Object.keys(core)) {
    if (!allowed.has(key)) {
      throw new Error(`unknown field: ${key}`);
    }
  }
}

function rawHash(value, field) {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${field} must be a 32-byte hex string`);
  }
  return Buffer.from(value, "hex");
}

function uint8(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${field} must fit uint8`);
  }
  const buffer = Buffer.allocUnsafe(1);
  buffer.writeUInt8(value);
  return buffer;
}

function uint16(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${field} must fit uint16`);
  }
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function uint64(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be an unsigned safe integer`);
  }
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function encodedKeySetVersion(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("key_set_version must be a non-empty string");
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 0xffff) {
    throw new Error("key_set_version is too long");
  }
  return Buffer.concat([uint16(bytes.length, "key_set_version length"), bytes]);
}

function canonicalCoreJson(core) {
  const fields = ["request_hash", "decision", "reason", "policy_hash", "decision_hash", "key_set_version"];
  if (core.cost_usd_micro !== undefined) {
    fields.push("cost_usd_micro");
  }
  if (core.timestamp_ms !== undefined) {
    fields.push("timestamp_ms");
  }
  return `{${fields.map((field) => `${JSON.stringify(field)}:${JSON.stringify(core[field])}`).join(",")}}`;
}

export function encodeDecisionCore(core) {
  assertNoUnknownFields(core);

  const decision = DECISION_IDS[core.decision];
  if (decision === undefined) {
    throw new Error("unknown decision");
  }
  const reason = REASON_ID_TABLE[core.reason];
  if (reason === undefined) {
    throw new Error("unknown reason");
  }
  if (core.cost_usd_micro !== undefined && (!Number.isSafeInteger(core.cost_usd_micro) || core.cost_usd_micro < 0)) {
    throw new Error("cost_usd_micro must be an unsigned integer");
  }
  if (core.timestamp_ms !== undefined && (!Number.isSafeInteger(core.timestamp_ms) || core.timestamp_ms < 0)) {
    throw new Error("timestamp_ms must be an unsigned integer");
  }

  const flags = (core.cost_usd_micro === undefined ? 0 : 1) | (core.timestamp_ms === undefined ? 0 : 2);
  const parts = [
    MAGIC,
    uint8(VERSION, "version"),
    uint8(flags, "flags"),
    rawHash(core.request_hash, "request_hash"),
    uint8(decision, "decision"),
    uint16(reason, "reason"),
    rawHash(core.policy_hash, "policy_hash"),
    rawHash(core.decision_hash, "decision_hash"),
    encodedKeySetVersion(core.key_set_version)
  ];
  if (core.cost_usd_micro !== undefined) {
    parts.push(uint64(core.cost_usd_micro, "cost_usd_micro"));
  }
  if (core.timestamp_ms !== undefined) {
    parts.push(uint64(core.timestamp_ms, "timestamp_ms"));
  }
  return Buffer.concat(parts);
}

export function hashBinary(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("binary output must be a Buffer");
  }
  return createHash("sha256").update(buffer).digest("hex");
}

export function decisionCoreFromReceipt(receipt) {
  const output = receipt?.decision_output;
  return {
    request_hash: output?.request_hash,
    decision: output?.decision,
    reason: output?.reason_code,
    policy_hash: output?.policy_hash,
    decision_hash: output?.decision_hash,
    key_set_version: output?.key_set_version
  };
}

export function observeBinaryExperiment(receipt, env = process.env) {
  if (!binaryExperimentEnabled(env)) {
    return { ok: true, skipped: true };
  }

  try {
    const outputPath = resultPath(env);
    const core = decisionCoreFromReceipt(receipt);
    const binary = encodeDecisionCore(core);
    const jsonCoreBytes = Buffer.byteLength(canonicalCoreJson(core));
    mkdirSync(dirname(outputPath), { recursive: true });
    appendFileSync(
      outputPath,
      `${JSON.stringify({
        experiment: "mnde_binary_experiment",
        request_hash: core.request_hash,
        decision_hash: core.decision_hash,
        json_core_bytes: jsonCoreBytes,
        binary_core_bytes: binary.length,
        binary_sha256: hashBinary(binary)
      })}\n`,
      "utf8"
    );
    return { ok: true, skipped: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const outputPath = resultPath(env);
      mkdirSync(dirname(outputPath), { recursive: true });
      appendFileSync(outputPath, `${JSON.stringify({ experiment: "mnde_binary_experiment", experiment_error: message })}\n`, "utf8");
    } catch {
      process.stderr.write(`experiment_error: ${message}\n`);
    }
    return { ok: false, skipped: false, error: message };
  }
}
