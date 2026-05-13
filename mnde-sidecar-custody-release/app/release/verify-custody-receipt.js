import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertReleaseIntegrity } from "../release/verify-release.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function parseFlag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 || index === argv.length - 1 ? null : argv[index + 1];
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return "null";
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");
}

function publicKeyObjectFromRawHex(publicKeyHex) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
    format: "der",
    type: "spki"
  });
}

function readJson(filePath) {
  const text = readFileSync(path.resolve(filePath), "utf8");
  if (text.charCodeAt(0) === 0xfeff) throw Object.assign(new Error("BOM is not allowed"), { code: "ERR_MALFORMED_JSON" });
  return JSON.parse(text);
}

function unsignedReceipt(receipt) {
  const { signature: _signature, ...payload } = receipt;
  return payload;
}

function verifyReceipt(config, receipt, allowHistoricalConfigHash) {
  if (!receipt || typeof receipt !== "object") throw Object.assign(new Error("receipt must be object"), { code: "ERR_MALFORMED_RECEIPT" });
  if (receipt.receipt_schema_version !== "mnde.sidecar_custody.receipt.v1") throw Object.assign(new Error("unknown receipt schema"), { code: "ERR_MALFORMED_RECEIPT" });
  if (receipt.key_set_version !== config.key_set_version) throw Object.assign(new Error("unknown key set version"), { code: "ERR_UNKNOWN_KEY_SET_VERSION" });
  const configHash = sha256(config);
  if (receipt.custody_config_hash !== configHash && !allowHistoricalConfigHash) {
    throw Object.assign(new Error("custody config hash changed"), { code: "ERR_CUSTODY_CONFIG_HASH_MISMATCH" });
  }
  const signer = (config.signers ?? []).find((candidate) => candidate.id === receipt.signer_id);
  if (!signer) throw Object.assign(new Error("unknown signer id"), { code: "ERR_UNKNOWN_SIGNER" });
  if (receipt.signer_mode !== signer.mode) throw Object.assign(new Error("signer mode mismatch"), { code: "ERR_UNKNOWN_SIGNER_MODE" });
  if (receipt.signature_algorithm !== "ED25519") throw Object.assign(new Error("unsupported signature algorithm"), { code: "ERR_CUSTODY_SIGNATURE_INVALID" });
  if (typeof receipt.signature !== "string" || !/^[0-9a-fA-F]+$/.test(receipt.signature)) {
    throw Object.assign(new Error("missing signature"), { code: "ERR_CUSTODY_SIGNATURE_INVALID" });
  }
  const expectedDecisionHash = sha256({
    request_hash: receipt.request_hash,
    decision: receipt.decision,
    reason: receipt.reason,
    policy_version: receipt.policy_version
  });
  if (receipt.decision_hash !== expectedDecisionHash) throw Object.assign(new Error("decision_hash mismatch"), { code: "ERR_DECISION_HASH_MISMATCH" });
  const ok = verify(
    null,
    Buffer.from(canonicalize(unsignedReceipt(receipt)), "utf8"),
    publicKeyObjectFromRawHex(signer.public_key),
    Buffer.from(receipt.signature, "hex")
  );
  if (!ok) throw Object.assign(new Error("signature verification failed"), { code: "ERR_CUSTODY_SIGNATURE_VERIFY_FAILED" });
  return {
    ok: true,
    key_set_version: receipt.key_set_version,
    signer_id: receipt.signer_id,
    signer_mode: receipt.signer_mode,
    custody_config_hash: receipt.custody_config_hash,
    decision_hash: receipt.decision_hash
  };
}

try {
  assertReleaseIntegrity();
  const configPath = parseFlag(process.argv, "--config") ?? parseFlag(process.argv, "--signer-config");
  const receiptPath = parseFlag(process.argv, "--receipt");
  if (!configPath || !receiptPath) throw new Error("--config and --receipt are required");
  const result = verifyReceipt(readJson(configPath), readJson(receiptPath), hasFlag(process.argv, "--allow-historical-config-hash"));
  process.stdout.write(`PASS\n${JSON.stringify({ verdict: "PASS", ...result }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ verdict: "REFUSE", code: error.code ?? "ERR_RECEIPT_VERIFY_FAILED", error: error.message })}\n`);
  process.exitCode = 1;
}
