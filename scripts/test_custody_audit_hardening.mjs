import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkCustodyStartup,
  logStartupResult,
  readCustodyConfig,
  replayStartupReceipt,
  runPreflightCheck,
  validateConfiguredPolicy
} from "../custody/runtime.ts";
import { canonicalPolicyPayload, deriveKeyId, policyHash } from "../shared/policy-trust.ts";

function withTempDir(prefix, run) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function publicKeyRawHex(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(der).subarray(-32).toString("hex");
}

function signPayload(payload, privateKey) {
  return sign(null, Buffer.from(payload, "utf8"), privateKey).toString("hex");
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createPackage(root) {
  writeJson(path.join(root, "provenance.json"), {
    schema_version: "mnde.custody.provenance.v1",
    release_version: "1.0.0",
    release_tag: "v1.0.0",
    package_type: "custody-only",
    git_commit_hash: "a".repeat(40),
    build_timestamp_utc: "2026-01-01T00:00:00.000Z",
    build_command: "npm run release:build",
    target_platform: "win32",
    target_arch: "x64",
    builder_identity: { user: "test", host: "host" },
    toolchain: { node_version: "v22.0.0", rust_version: "not-bundled", cargo_version: "not-bundled" },
    provenance_status: "complete",
    provenance_notes: [],
    artifacts: {}
  });
  const provenanceBytes = readFileSync(path.join(root, "provenance.json"));
  writeJson(path.join(root, "manifest.json"), {
    schema_version: "mnde.custody.manifest.v1",
    generated_at: "2026-01-01T00:00:00.000Z",
    release_version: "1.0.0",
    package_type: "custody-only",
    immutable_after_publish: true,
    artifacts: [
      {
        file: "provenance.json",
        sha256: createHash("sha256").update(provenanceBytes).digest("hex"),
        bytes: provenanceBytes.byteLength
      }
    ]
  });
}

function makeSignedPolicy(version, overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signing_public_key = publicKeyRawHex(publicKey);
  const base = {
    schema_version: "mnde.policy.v1",
    policy_version: version,
    rules: {
      max_total_cost_usd: 100,
      allow_auto_scale: false,
      max_gpu_count: 4,
      max_hours: 8,
      require_manual_approval_above_usd: 50
    },
    trust: {
      key_version: "ed25519.v1",
      key_id: deriveKeyId(signing_public_key),
      signing_public_key,
      signature: ""
    }
  };
  const policy = {
    ...base,
    ...overrides,
    rules: { ...base.rules, ...(overrides.rules ?? {}) },
    trust: { ...base.trust, ...(overrides.trust ?? {}) }
  };
  policy.trust.signature = signPayload(canonicalPolicyPayload(policy), privateKey);
  return policy;
}

function createConfig(root, policyPath, policyOverrides = {}) {
  return {
    schema_version: "mnde.custody.config.v1",
    mode: "custody-only",
    strict: true,
    service_name: "MNDeCustody",
    runtime: {
      bind: "127.0.0.1:8787",
      deny_internal_signing: true,
      fail_on_forbidden_artifacts: true,
      health_path: "/healthz",
      ready_path: "/readyz"
    },
    logging: {
      path: path.join(root, "logs", "runtime.log"),
      runtime_log: path.join(root, "logs", "runtime.log"),
      install_log: path.join(root, "logs", "install.log"),
      verification_log: path.join(root, "logs", "verification.log"),
      max_bytes: 1048576,
      max_files: 5,
      required_for_audit_integrity: false
    },
    receipts: {
      path: path.join(root, "receipts", "receipts.jsonl"),
      archive_path: path.join(root, "receipts", "archive"),
      rotation_mode: "size",
      max_bytes: 10485760,
      max_count: 100000
    },
    disk: {
      min_free_bytes: 1024
    },
    signer: {
      timeout_ms: 5000
    },
    policy: {
      mode: "required",
      path: policyPath,
      expected_hash: null,
      ...policyOverrides
    }
  };
}

function readLastReceipt(filePath) {
  const lines = readFileSync(filePath, "utf8").trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1));
}

function testPreflightOutputsHashesAndWritesLock() {
  withTempDir("mnde-audit-", (root) => {
    const packageRoot = path.join(root, "package");
    createPackage(packageRoot);
    const policy = makeSignedPolicy("policy.v1");
    const policyPath = path.join(root, "policy.json");
    writeJson(policyPath, policy);
    const configPath = path.join(root, "config.json");
    writeJson(configPath, createConfig(path.join(root, "config-root"), policyPath, { expected_hash: policyHash(policy) }));

    const result = runPreflightCheck({ configPath, packageRoot });
    assert.equal(typeof result.config_hash, "string");
    assert.equal(result.policy_hash, policyHash(policy));
    assert.equal(result.lock_path, `${configPath}.preflight-lock.json`);
    assert.equal(JSON.parse(readFileSync(result.lock_path, "utf8")).config_hash, result.config_hash);
  });
}

function testStartupRefusesIfConfigChangesAfterPreflight() {
  withTempDir("mnde-audit-", (root) => {
    const packageRoot = path.join(root, "package");
    createPackage(packageRoot);
    const policy = makeSignedPolicy("policy.v1");
    const policyPath = path.join(root, "policy.json");
    writeJson(policyPath, policy);
    const configPath = path.join(root, "config.json");
    const config = createConfig(path.join(root, "config-root"), policyPath, { expected_hash: policyHash(policy) });
    writeJson(configPath, config);
    runPreflightCheck({ configPath, packageRoot });

    config.runtime.bind = "127.0.0.1:9898";
    writeJson(configPath, config);
    const startup = checkCustodyStartup(packageRoot, readCustodyConfig(configPath), { configPath });
    assert.equal(startup.ok, false);
    assert.equal(startup.reason, "ERR_PREFLIGHT_CONFIG_MISMATCH");
  });
}

function testStartupRefusesIfPolicyChangesAfterPreflight() {
  withTempDir("mnde-audit-", (root) => {
    const packageRoot = path.join(root, "package");
    createPackage(packageRoot);
    const policy = makeSignedPolicy("policy.v1");
    const policyPath = path.join(root, "policy.json");
    writeJson(policyPath, policy);
    const configPath = path.join(root, "config.json");
    writeJson(configPath, createConfig(path.join(root, "config-root"), policyPath, { expected_hash: policyHash(policy) }));
    runPreflightCheck({ configPath, packageRoot });

    const swappedPolicy = makeSignedPolicy("policy.v2", { rules: { max_gpu_count: 8 } });
    writeJson(policyPath, swappedPolicy);
    const startup = checkCustodyStartup(packageRoot, readCustodyConfig(configPath), { configPath });
    assert.equal(startup.ok, false);
    assert.equal(startup.reason, "ERR_PREFLIGHT_POLICY_MISMATCH");
  });
}

function testReceiptDecisionHashBindsPolicy() {
  withTempDir("mnde-audit-", (root) => {
    const policyA = { ok: true, code: "OK_POLICY_READY", policy_hash: "a".repeat(64), path: "policy-a.json", details: null };
    const policyB = { ok: true, code: "OK_POLICY_READY", policy_hash: "b".repeat(64), path: "policy-b.json", details: null };
    const receiptAStore = { receipts: { path: path.join(root, "a", "receipts.jsonl"), archive_path: path.join(root, "a", "archive"), rotation_mode: "size", max_bytes: 1024, max_count: 10 } };
    const receiptBStore = { receipts: { path: path.join(root, "b", "receipts.jsonl"), archive_path: path.join(root, "b", "archive"), rotation_mode: "size", max_bytes: 1024, max_count: 10 } };
    logStartupResult({ ok: false, code: "ERR_POLICY_HASH_MISMATCH", reason: "ERR_POLICY_HASH_MISMATCH", forbidden_artifacts: [], policy: policyA }, receiptAStore);
    logStartupResult({ ok: false, code: "ERR_POLICY_HASH_MISMATCH", reason: "ERR_POLICY_HASH_MISMATCH", forbidden_artifacts: [], policy: policyB }, receiptBStore);
    const receiptA = readLastReceipt(receiptAStore.receipts.path);
    const receiptB = readLastReceipt(receiptBStore.receipts.path);
    assert.notEqual(receiptA.decision_hash, receiptB.decision_hash);
    assert.equal(receiptA.policy_hash, "a".repeat(64));
    assert.equal(receiptB.policy_hash, "b".repeat(64));
  });
}

function testReplayFailsOnPolicyMismatch() {
  withTempDir("mnde-audit-", (root) => {
    const policy = makeSignedPolicy("policy.v1");
    const policyPath = path.join(root, "policy.json");
    writeJson(policyPath, policy);
    const configPath = path.join(root, "config.json");
    writeJson(configPath, createConfig(path.join(root, "config-root"), policyPath, { expected_hash: policyHash(policy) }));
    const store = { receipts: { path: path.join(root, "receipts", "receipts.jsonl"), archive_path: path.join(root, "receipts", "archive"), rotation_mode: "size", max_bytes: 1024, max_count: 10 } };
    logStartupResult({ ok: false, code: "ERR_POLICY_HASH_MISMATCH", reason: "ERR_POLICY_HASH_MISMATCH", forbidden_artifacts: [], policy: { ok: true, code: "OK_POLICY_READY", policy_hash: policyHash(policy), path: policyPath, details: null } }, store);
    const receipt = readLastReceipt(store.receipts.path);
    const replay = replayStartupReceipt(receipt, readCustodyConfig(configPath), { policy_hash: "0".repeat(64), path: policyPath });
    assert.equal(replay.ok, false);
    assert.equal(replay.code, "ERR_RECEIPT_POLICY_MISMATCH");
  });
}

function testPolicyValidationIsDeterministic() {
  withTempDir("mnde-audit-", (root) => {
    const policy = makeSignedPolicy("policy.v1");
    const policyPath = path.join(root, "policy.json");
    writeJson(policyPath, policy);
    const configPath = path.join(root, "config.json");
    writeJson(configPath, createConfig(path.join(root, "config-root"), policyPath, { expected_hash: policyHash(policy) }));
    const config = readCustodyConfig(configPath);
    const first = validateConfiguredPolicy(config);
    const second = validateConfiguredPolicy(config);
    assert.deepEqual(first, second);
    assert.equal(first.validation_hash, second.validation_hash);
  });
}

function testDisabledPolicyModeRequiresExplicitOverride() {
  withTempDir("mnde-audit-", (root) => {
    const configPath = path.join(root, "config.json");
    writeJson(configPath, createConfig(path.join(root, "config-root"), "", { mode: "disabled", path: "" }));
    const prior = process.env.MNDE_CUSTODY_ALLOW_DISABLED_POLICY_MODE;
    delete process.env.MNDE_CUSTODY_ALLOW_DISABLED_POLICY_MODE;
    try {
      assert.throws(() => readCustodyConfig(configPath), (error) => error?.code === "ERR_INVALID_CONFIG");
    } finally {
      if (prior === undefined) {
        delete process.env.MNDE_CUSTODY_ALLOW_DISABLED_POLICY_MODE;
      } else {
        process.env.MNDE_CUSTODY_ALLOW_DISABLED_POLICY_MODE = prior;
      }
    }
  });
}

function testStartupRefusesWhenProbeReceiptWriteFails() {
  withTempDir("mnde-audit-", (root) => {
    const packageRoot = path.join(root, "package");
    createPackage(packageRoot);
    const policy = makeSignedPolicy("policy.v1");
    const policyPath = path.join(root, "policy.json");
    writeJson(policyPath, policy);
    const configPath = path.join(root, "config.json");
    const config = createConfig(path.join(root, "config-root"), policyPath, { expected_hash: policyHash(policy) });
    config.receipts.simulate_write_failure = true;
    writeJson(configPath, config);
    runPreflightCheck({ configPath, packageRoot });
    const startup = checkCustodyStartup(packageRoot, readCustodyConfig(configPath), { configPath });
    assert.equal(startup.ok, false);
    assert.equal(startup.reason, "ERR_RECEIPT_WRITE_FAILED");
  });
}

function testStartupRefusesWhenProbeReceiptReadFails() {
  withTempDir("mnde-audit-", (root) => {
    const packageRoot = path.join(root, "package");
    createPackage(packageRoot);
    const policy = makeSignedPolicy("policy.v1");
    const policyPath = path.join(root, "policy.json");
    writeJson(policyPath, policy);
    const configPath = path.join(root, "config.json");
    const config = createConfig(path.join(root, "config-root"), policyPath, { expected_hash: policyHash(policy) });
    config.receipts.simulate_read_failure = true;
    writeJson(configPath, config);
    runPreflightCheck({ configPath, packageRoot });
    const startup = checkCustodyStartup(packageRoot, readCustodyConfig(configPath), { configPath });
    assert.equal(startup.ok, false);
    assert.equal(startup.reason, "ERR_RECEIPT_READ_FAILED");
  });
}

testPreflightOutputsHashesAndWritesLock();
testStartupRefusesIfConfigChangesAfterPreflight();
testStartupRefusesIfPolicyChangesAfterPreflight();
testReceiptDecisionHashBindsPolicy();
testReplayFailsOnPolicyMismatch();
testPolicyValidationIsDeterministic();
testDisabledPolicyModeRequiresExplicitOverride();
testStartupRefusesWhenProbeReceiptWriteFails();
testStartupRefusesWhenProbeReceiptReadFails();
process.stdout.write("PASS custody audit hardening tests\n");
