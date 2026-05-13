import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkCustodyStartup, logStartupResult, readCustodyConfig, runPreflightCheck } from "../custody/runtime.ts";
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

function makeSignedPolicy(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signing_public_key = publicKeyRawHex(publicKey);
  const base = {
    schema_version: "mnde.policy.v1",
    policy_version: "policy.v1",
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
  const payload = canonicalPolicyPayload(policy);
  policy.trust.signature = overrides.trust?.signature ?? signPayload(payload, privateKey);
  return policy;
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

function testMissingPolicyPathFailsConfigValidation() {
  withTempDir("mnde-policy-", (root) => {
    const configRoot = path.join(root, "config");
    const configPath = path.join(root, "config.json");
    writeJson(configPath, createConfig(configRoot, path.join(root, "policy.json"), { path: "" }));
    assert.throws(() => readCustodyConfig(configPath), (error) => error?.code === "ERR_INVALID_CONFIG");
  });
}

function testPreflightFailsOnMissingPolicyFile() {
  withTempDir("mnde-policy-", (root) => {
    const packageRoot = path.join(root, "package");
    const configRoot = path.join(root, "config");
    createPackage(packageRoot);
    const configPath = path.join(root, "config.json");
    writeJson(configPath, createConfig(configRoot, path.join(root, "policy.json")));
    const result = runPreflightCheck({ configPath, packageRoot });
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "policy").code, "ERR_POLICY_FILE_MISSING");
  });
}

function testPreflightFailsOnUnreadablePolicyFile() {
  withTempDir("mnde-policy-", (root) => {
    const packageRoot = path.join(root, "package");
    const configRoot = path.join(root, "config");
    createPackage(packageRoot);
    const policyDir = path.join(root, "policy.json");
    mkdirSync(policyDir, { recursive: true });
    const configPath = path.join(root, "config.json");
    writeJson(configPath, createConfig(configRoot, policyDir));
    const result = runPreflightCheck({ configPath, packageRoot });
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "policy").code, "ERR_POLICY_FILE_UNREADABLE");
  });
}

function testPreflightFailsOnMalformedPolicyJson() {
  withTempDir("mnde-policy-", (root) => {
    const packageRoot = path.join(root, "package");
    const configRoot = path.join(root, "config");
    createPackage(packageRoot);
    writeFileSync(path.join(root, "policy.json"), "{", "utf8");
    const configPath = path.join(root, "config.json");
    writeJson(configPath, createConfig(configRoot, path.join(root, "policy.json")));
    const result = runPreflightCheck({ configPath, packageRoot });
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "policy").code, "ERR_POLICY_JSON_PARSE_FAILED");
  });
}

function testPreflightFailsOnInvalidPolicySchema() {
  withTempDir("mnde-policy-", (root) => {
    const packageRoot = path.join(root, "package");
    const configRoot = path.join(root, "config");
    createPackage(packageRoot);
    const policy = makeSignedPolicy({ schema_version: "wrong.policy.v1" });
    writeJson(path.join(root, "policy.json"), policy);
    const configPath = path.join(root, "config.json");
    writeJson(configPath, createConfig(configRoot, path.join(root, "policy.json")));
    const result = runPreflightCheck({ configPath, packageRoot });
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "policy").code, "ERR_POLICY_SCHEMA_INVALID");
  });
}

function testPreflightFailsOnInvalidPolicySignature() {
  withTempDir("mnde-policy-", (root) => {
    const packageRoot = path.join(root, "package");
    const configRoot = path.join(root, "config");
    createPackage(packageRoot);
    const policy = makeSignedPolicy({ trust: { signature: "00".repeat(64) } });
    writeJson(path.join(root, "policy.json"), policy);
    const configPath = path.join(root, "config.json");
    writeJson(configPath, createConfig(configRoot, path.join(root, "policy.json")));
    const result = runPreflightCheck({ configPath, packageRoot });
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "policy").code, "ERR_POLICY_SIGNATURE_INVALID");
  });
}

function testPreflightFailsOnPolicyHashMismatch() {
  withTempDir("mnde-policy-", (root) => {
    const packageRoot = path.join(root, "package");
    const configRoot = path.join(root, "config");
    createPackage(packageRoot);
    const policy = makeSignedPolicy();
    writeJson(path.join(root, "policy.json"), policy);
    const configPath = path.join(root, "config.json");
    writeJson(configPath, createConfig(configRoot, path.join(root, "policy.json"), { expected_hash: "f".repeat(64) }));
    const result = runPreflightCheck({ configPath, packageRoot });
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "policy").code, "ERR_POLICY_HASH_MISMATCH");
  });
}

function testValidPolicyPassesAndStartupReceiptIsDeterministic() {
  withTempDir("mnde-policy-", (root) => {
    const packageRoot = path.join(root, "package");
    const configRoot = path.join(root, "config");
    createPackage(packageRoot);
    const policy = makeSignedPolicy();
    writeJson(path.join(root, "policy.json"), policy);
    const config = createConfig(configRoot, path.join(root, "policy.json"), { expected_hash: policyHash(policy) });
    const configPath = path.join(root, "config.json");
    writeJson(configPath, config);

    const preflight = runPreflightCheck({ configPath, packageRoot });
    assert.equal(preflight.ok, true);
    assert.equal(preflight.checks.find((check) => check.name === "policy").code, "OK_POLICY_READY");

    const startup = checkCustodyStartup(packageRoot, readCustodyConfig(configPath));
    assert.equal(startup.ok, true);

    const badConfig = createConfig(configRoot, path.join(root, "policy.json"), { expected_hash: "0".repeat(64) });
    const badConfigPath = path.join(root, "bad-config.json");
    writeJson(badConfigPath, badConfig);
    const refusal = checkCustodyStartup(packageRoot, readCustodyConfig(badConfigPath));
    assert.equal(refusal.ok, false);
    assert.equal(refusal.reason, "ERR_POLICY_HASH_MISMATCH");

    const receiptA = {
      receipts: {
        path: path.join(root, "receipts-a", "receipts.jsonl"),
        archive_path: path.join(root, "receipts-a", "archive"),
        rotation_mode: "size",
        max_bytes: 1024,
        max_count: 10
      }
    };
    const receiptB = {
      receipts: {
        path: path.join(root, "receipts-b", "receipts.jsonl"),
        archive_path: path.join(root, "receipts-b", "archive"),
        rotation_mode: "size",
        max_bytes: 1024,
        max_count: 10
      }
    };
    logStartupResult(refusal, receiptA);
    logStartupResult(refusal, receiptB);
    assert.equal(readFileSync(receiptA.receipts.path, "utf8").trim(), readFileSync(receiptB.receipts.path, "utf8").trim());
  });
}

function testExplicitNoPolicyModePassesWithoutPath() {
  withTempDir("mnde-policy-", (root) => {
    const packageRoot = path.join(root, "package");
    const configRoot = path.join(root, "config");
    createPackage(packageRoot);
    const configPath = path.join(root, "disabled-config.json");
    writeJson(configPath, createConfig(configRoot, "", { mode: "disabled", path: "" }));
    const prior = process.env.MNDE_CUSTODY_ALLOW_DISABLED_POLICY_MODE;
    process.env.MNDE_CUSTODY_ALLOW_DISABLED_POLICY_MODE = "true";
    try {
      const preflight = runPreflightCheck({ configPath, packageRoot });
      assert.equal(preflight.ok, true);
      assert.equal(preflight.checks.find((check) => check.name === "policy").code, "OK_POLICY_DISABLED");
      const startup = checkCustodyStartup(packageRoot, readCustodyConfig(configPath));
      assert.equal(startup.ok, true);
    } finally {
      if (prior === undefined) {
        delete process.env.MNDE_CUSTODY_ALLOW_DISABLED_POLICY_MODE;
      } else {
        process.env.MNDE_CUSTODY_ALLOW_DISABLED_POLICY_MODE = prior;
      }
    }
  });
}

testMissingPolicyPathFailsConfigValidation();
testPreflightFailsOnMissingPolicyFile();
testPreflightFailsOnUnreadablePolicyFile();
testPreflightFailsOnMalformedPolicyJson();
testPreflightFailsOnInvalidPolicySchema();
testPreflightFailsOnInvalidPolicySignature();
testPreflightFailsOnPolicyHashMismatch();
testValidPolicyPassesAndStartupReceiptIsDeterministic();
testExplicitNoPolicyModePassesWithoutPath();
process.stdout.write("PASS policy contract tests\n");
