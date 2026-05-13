import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalize,
  createDecisionRequest,
  decide,
  hashCanonical,
  loadPolicy,
  signReceipt
} from "../codex-mnde/lib/decision_engine.mjs";
import {
  appendReceipt,
  readReceipts,
  verifyReceiptLog
} from "../codex-mnde/lib/receipts.mjs";
import { generateProofBundle } from "../codex-mnde/lib/proof_bundle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(repoRoot, "codex-mnde-test-output");
const receiptLog = path.join(testRoot, "receipts.jsonl");
const policyPath = path.join(repoRoot, "codex_mnde_policy.json");
const wrapperPath = path.join(repoRoot, "mnde-run.mjs");

rmSync(testRoot, { recursive: true, force: true });
mkdirSync(testRoot, { recursive: true });

function runNode(args, extraEnv = {}) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MNDE_CODEX_POLICY: policyPath,
      MNDE_RECEIPT_LOG: receiptLog,
      MNDE_DECISION_MODE: "local",
      MNDE_WORKSPACE_ROOT: repoRoot,
      ...extraEnv
    }
  });
}

function runNodeAsync(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        MNDE_CODEX_POLICY: policyPath,
        MNDE_RECEIPT_LOG: receiptLog,
        MNDE_DECISION_MODE: "local",
        MNDE_WORKSPACE_ROOT: repoRoot,
        ...extraEnv
      },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function parseLastJsonLine(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0, "expected JSON output");
  return JSON.parse(lines.at(-1));
}

function testCanonicalHashDeterminism() {
  const a = { b: 1, a: "x", nested: { z: 3, y: 2 } };
  const b = { nested: { y: 2, z: 3 }, a: "x", b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(hashCanonical(a), hashCanonical(b));
}

function testPolicyDecisions() {
  const policy = loadPolicy(policyPath);
  const safe = createDecisionRequest({
    argv: ["npm", "test"],
    cwd: repoRoot,
    actor: "codex",
    tool: "shell"
  });
  const safeDecision = decide(safe, policy);
  assert.equal(safeDecision.decision, "ALLOW");
  assert.equal(safeDecision.reason, "OK_POLICY_ALLOWLIST");

  const malicious = createDecisionRequest({
    argv: ["powershell", "-NoProfile", "-Command", "rm -rf C:\\"],
    cwd: repoRoot,
    actor: "codex",
    tool: "shell"
  });
  const maliciousDecision = decide(malicious, policy);
  assert.equal(maliciousDecision.decision, "REFUSE");
  assert.equal(maliciousDecision.reason, "ERR_DESTRUCTIVE_DELETE");

  const prompt = createDecisionRequest({
    argv: ["npm", "install"],
    cwd: repoRoot,
    actor: "codex",
    tool: "shell"
  });
  const promptDecision = decide(prompt, policy);
  assert.equal(promptDecision.decision, "PROMPT_REQUIRED");
  assert.equal(promptDecision.reason, "PROMPT_PACKAGE_INSTALL");
}

function testWrapperExecutionAndRefusalPersistence() {
  const safe = runNode([wrapperPath, "node", "-e", "process.stdout.write('mnde-safe')"]);
  assert.equal(safe.status, 0, safe.stderr);
  assert.match(safe.stdout, /mnde-safe/);

  const refused = runNode([wrapperPath, "rm", "-rf", "."]);
  assert.notEqual(refused.status, 0);
  const body = parseLastJsonLine(refused.stderr || refused.stdout);
  assert.equal(body.decision, "REFUSE");
  assert.equal(body.reason, "ERR_DESTRUCTIVE_DELETE");

  const receipts = readReceipts(receiptLog);
  assert.equal(receipts.some((receipt) => receipt.decision === "ALLOW"), true);
  assert.equal(receipts.some((receipt) => receipt.decision === "REFUSE"), true);
}

async function testWrapperRemoteDecisionPath() {
  const policy = loadPolicy(policyPath);
  const server = http.createServer((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/decisions");
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const request = JSON.parse(raw);
      const decision = decide(request, policy);
      const receipt = signReceipt({ request, decision, execution_status: "PENDING_REMOTE" });
      const body = canonicalize({ ...decision, receipt, schema_version: "mnde.codex.decision_response.v1" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`${body}\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await runNodeAsync([wrapperPath, "node", "-e", "process.stdout.write('remote-ok')"], {
      MNDE_DECISION_MODE: "remote",
      MNDE_DECISION_URL: `http://127.0.0.1:${port}/v1/decisions`
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /remote-ok/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function testReceiptReplayAndTamperDetection() {
  const policy = loadPolicy(policyPath);
  const request = createDecisionRequest({
    argv: ["git", "status"],
    cwd: repoRoot,
    actor: "codex",
    tool: "git"
  });
  const decision = decide(request, policy);
  const receipt = signReceipt({ request, decision, execution_status: "SKIPPED_TEST" });
  appendReceipt(receiptLog, receipt);

  const verification = verifyReceiptLog(receiptLog, policy);
  assert.equal(verification.valid_receipts >= 1, true);
  assert.equal(verification.invalid_receipts, 0);
  assert.equal(verification.drift_count, 0);

  const tamperedPath = path.join(testRoot, "tampered.jsonl");
  const tampered = { ...receipt, decision: "ALLOW", reason: "OK_TAMPERED" };
  writeFileSync(tamperedPath, `${canonicalize(tampered)}\n`, "utf8");
  const tamperedVerification = verifyReceiptLog(tamperedPath, policy);
  assert.equal(tamperedVerification.invalid_receipts, 1);
}

async function testConcurrentRequestsAndProofBundle() {
  const commands = Array.from({ length: 20 }, (_, index) =>
    runNode([wrapperPath, "node", "-e", `process.stdout.write(String(${index}))`])
  );
  assert.equal(commands.every((result) => result.status === 0), true);

  const policy = loadPolicy(policyPath);
  const identical = createDecisionRequest({
    argv: ["npm", "test"],
    cwd: repoRoot,
    actor: "codex",
    tool: "shell"
  });
  const hashes = new Set(Array.from({ length: 1000 }, () => decide(identical, policy).decision_hash));
  assert.equal(hashes.size, 1);

  const bundle = generateProofBundle({
    outDir: path.join(repoRoot, "codex-mnde-proof-bundle"),
    receiptLog,
    policyPath,
    identicalReplayCount: 1000
  });
  assert.equal(bundle.summary.zero_dropped_decisions, true);
  assert.equal(bundle.determinism_report.identical_decision_hashes, true);
  assert.equal(existsSync(path.join(repoRoot, "codex-mnde-proof-bundle", "summary.json")), true);
}

function testMalformedAndPolicyTamper() {
  const malformed = spawnSync(process.execPath, [wrapperPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, MNDE_DECISION_MODE: "local", MNDE_RECEIPT_LOG: receiptLog }
  });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /ERR_EMPTY_COMMAND/);

  const policy = loadPolicy(policyPath);
  const request = createDecisionRequest({
    argv: ["node", "scripts/test_codex_mnde_integration.mjs"],
    cwd: repoRoot,
    actor: "codex",
    tool: "shell"
  });
  const decision = decide(request, policy);
  assert.equal(decision.decision, "ALLOW");
  const tamperedPolicy = { ...policy, policy_version: "evil" };
  assert.throws(() => decide(request, tamperedPolicy), /ERR_POLICY_HASH_MISMATCH/);
}

testCanonicalHashDeterminism();
testPolicyDecisions();
testWrapperExecutionAndRefusalPersistence();
await testWrapperRemoteDecisionPath();
testReceiptReplayAndTamperDetection();
await testConcurrentRequestsAndProofBundle();
testMalformedAndPolicyTamper();

process.stdout.write("PASS codex MNDe integration tests\n");
