import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { checkCustodyStartup, readCustodyConfig, runPreflightCheck } from "../custody/runtime.ts";
import { canonicalPolicyPayload, deriveKeyId, policyHash } from "../shared/policy-trust.ts";

const repoRoot = process.cwd();
const outputRoot = path.join(repoRoot, "external-audit-integration-output");

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function publicKeyRawHex(publicKey) {
  return Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32).toString("hex");
}

function makePolicy(version, rules = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signing_public_key = publicKeyRawHex(publicKey);
  const policy = {
    schema_version: "mnde.policy.v1",
    policy_version: version,
    rules: {
      max_total_cost_usd: 100,
      allow_auto_scale: false,
      max_gpu_count: 4,
      max_hours: 8,
      require_manual_approval_above_usd: 50,
      ...rules
    },
    trust: {
      key_version: "ed25519.v1",
      key_id: deriveKeyId(signing_public_key),
      signing_public_key,
      signature: ""
    }
  };
  policy.trust.signature = sign(null, Buffer.from(canonicalPolicyPayload(policy), "utf8"), privateKey).toString("hex");
  return policy;
}

function createPackage(packageRoot) {
  writeJson(path.join(packageRoot, "provenance.json"), {
    schema_version: "mnde.custody.provenance.v1",
    release_version: "1.0.0",
    release_tag: "v1.0.0",
    package_type: "custody-only",
    git_commit_hash: "a".repeat(40),
    build_timestamp_utc: "2026-01-01T00:00:00.000Z",
    build_command: "npm run release:build",
    target_platform: "win32",
    target_arch: "x64",
    builder_identity: { user: "external-audit", host: "local" },
    toolchain: { node_version: process.version, rust_version: "not-bundled", cargo_version: "not-bundled" },
    provenance_status: "complete",
    provenance_notes: [],
    artifacts: {}
  });
  const bytes = readFileSync(path.join(packageRoot, "provenance.json"));
  writeJson(path.join(packageRoot, "manifest.json"), {
    schema_version: "mnde.custody.manifest.v1",
    generated_at: "2026-01-01T00:00:00.000Z",
    release_version: "1.0.0",
    package_type: "custody-only",
    immutable_after_publish: true,
    artifacts: [{ file: "provenance.json", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength }]
  });
}

function createConfig(caseRoot, policyPath, expectedHash) {
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
      path: path.join(caseRoot, "logs", "runtime.log"),
      runtime_log: path.join(caseRoot, "logs", "runtime.log"),
      install_log: path.join(caseRoot, "logs", "install.log"),
      verification_log: path.join(caseRoot, "logs", "verification.log"),
      max_bytes: 1048576,
      max_files: 5,
      required_for_audit_integrity: false
    },
    receipts: {
      path: path.join(caseRoot, "receipts", "receipts.jsonl"),
      archive_path: path.join(caseRoot, "receipts", "archive"),
      rotation_mode: "size",
      max_bytes: 10485760,
      max_count: 100000
    },
    disk: { min_free_bytes: 1024 },
    signer: { timeout_ms: 5000 },
    policy: {
      mode: "required",
      path: policyPath,
      expected_hash: expectedHash
    }
  };
}

function setupCase(name) {
  const caseRoot = path.join(outputRoot, name);
  const packageRoot = path.join(caseRoot, "package");
  const policyPath = path.join(caseRoot, "policy.json");
  const configPath = path.join(caseRoot, "config.json");
  const policy = makePolicy("policy.v1");

  createPackage(packageRoot);
  writeJson(policyPath, policy);
  writeJson(configPath, createConfig(caseRoot, policyPath, policyHash(policy)));
  const preflight = runPreflightCheck({ configPath, packageRoot });
  assert.equal(preflight.ok, true, `${name} preflight must pass before mutation`);

  return { caseRoot, packageRoot, policyPath, configPath, policy };
}

function runStartup(configPath, packageRoot) {
  return checkCustodyStartup(packageRoot, readCustodyConfig(configPath), { configPath });
}

function result(name, startup, expectedCode) {
  const code = startup.reason ?? startup.code;
  assert.equal(code, expectedCode, `${name} expected ${expectedCode}, got ${code}`);
  return { name, ok: startup.ok, code };
}

function runReadOnlyReceiptDirectory() {
  const fixture = setupCase("read-only-receipt-directory");
  const receiptDir = path.dirname(readCustodyConfig(fixture.configPath).receipts.path);
  const user = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  assert.ok(user, "Windows user identity must be available for ACL test");
  execFileSync("icacls", [receiptDir, "/deny", `${user}:(OI)(CI)(W)`], { encoding: "utf8" });
  try {
    return result("read-only receipt directory", runStartup(fixture.configPath, fixture.packageRoot), "ERR_RECEIPT_WRITE_FAILED");
  } finally {
    execFileSync("icacls", [receiptDir, "/remove:d", user], { encoding: "utf8" });
  }
}

function runMissingReceiptDirectory() {
  const fixture = setupCase("missing-receipt-directory");
  const config = readCustodyConfig(fixture.configPath);
  rmSync(path.dirname(config.receipts.path), { recursive: true, force: true });
  const startup = runStartup(fixture.configPath, fixture.packageRoot);
  assert.equal(startup.ok, true, "missing receipt directory should be created and verified");
  assert.equal(existsSync(config.receipts.path), true, "probe receipt should be written after recreating missing directory");
  return { name: "missing receipt directory", ok: startup.ok, code: startup.code };
}

function runLockedReceiptFile() {
  const fixture = setupCase("locked-receipt-file");
  const receiptPath = readCustodyConfig(fixture.configPath).receipts.path;
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, "", "utf8");
  const ps = [
    "$stream = [System.IO.File]::Open($env:MNDE_LOCK_PATH, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)",
    "try {",
    "  & node --experimental-strip-types .\\scripts\\external_audit_startup_case.mjs",
    "  exit $LASTEXITCODE",
    "} finally {",
    "  $stream.Dispose()",
    "}"
  ].join("\n");
  const child = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MNDE_LOCK_PATH: receiptPath,
      MNDE_TEST_CONFIG_PATH: fixture.configPath,
      MNDE_TEST_PACKAGE_ROOT: fixture.packageRoot
    }
  });
  const stdoutLines = child.stdout.trim().split(/\r?\n/).filter(Boolean);
  const startup = JSON.parse(stdoutLines.at(-1));
  return result("locked receipt file", startup, "ERR_RECEIPT_WRITE_FAILED");
}

function runInvalidPreflightLock() {
  const fixture = setupCase("invalid-preflight-lock");
  writeFileSync(`${fixture.configPath}.preflight-lock.json`, "{", "utf8");
  return result("invalid preflight lock", runStartup(fixture.configPath, fixture.packageRoot), "ERR_PREFLIGHT_LOCK_MISSING");
}

function runConfigChangedAfterPreflight() {
  const fixture = setupCase("config-changed-after-preflight");
  const config = readCustodyConfig(fixture.configPath);
  config.runtime.bind = "127.0.0.1:9898";
  writeJson(fixture.configPath, config);
  return result("config changed after preflight", runStartup(fixture.configPath, fixture.packageRoot), "ERR_PREFLIGHT_CONFIG_MISMATCH");
}

function runPolicyChangedAfterPreflight() {
  const fixture = setupCase("policy-changed-after-preflight");
  writeJson(fixture.policyPath, makePolicy("policy.v2", { max_gpu_count: 8 }));
  return result("policy changed after preflight", runStartup(fixture.configPath, fixture.packageRoot), "ERR_PREFLIGHT_POLICY_MISMATCH");
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

const results = [
  runReadOnlyReceiptDirectory(),
  runMissingReceiptDirectory(),
  runLockedReceiptFile(),
  runInvalidPreflightLock(),
  runConfigChangedAfterPreflight(),
  runPolicyChangedAfterPreflight()
];

writeJson(path.join(outputRoot, "external-audit-integration-report.json"), { ok: true, results });
process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
