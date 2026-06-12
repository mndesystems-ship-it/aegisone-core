#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";

import {
  canonicalize,
  createDecisionRequest,
  decide,
  loadPolicy,
  signReceipt,
  sha256Text
} from "./codex-mnde/lib/decision_engine.mjs";
import { appendReceipt, refusalReceipt } from "./codex-mnde/lib/receipts.mjs";

const DEFAULT_DECISION_URL = "http://127.0.0.1:8787/v1/decisions";

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) throw new Error("ERR_EMPTY_COMMAND");
  if (argv[0] === "demo") {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", path.resolve("scripts", "mnde_live_demo.mjs"), ...argv.slice(1)], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: false,
      stdio: "inherit",
      windowsHide: true
    });
    process.exit(result.status ?? 1);
  }
  const cwd = process.cwd();
  const policyPath = process.env.MNDE_CODEX_POLICY ?? path.resolve("codex_mnde_policy.json");
  const receiptLog = process.env.MNDE_RECEIPT_LOG ?? path.resolve("receipts.jsonl");
  const policy = loadPolicy(policyPath);
  const request = createDecisionRequest({
    argv,
    cwd,
    actor: process.env.MNDE_ACTOR ?? "codex",
    tool: process.env.MNDE_TOOL ?? "shell",
    policyVersion: policy.policy_version,
    workspaceRoot: process.env.MNDE_WORKSPACE_ROOT ?? path.resolve(".")
  });
  const decisionMode = process.env.MNDE_DECISION_MODE ?? "remote";
  const decision = decisionMode === "local"
    ? decide(request, policy)
    : await remoteDecision(request);

  if (decision.decision !== "ALLOW") {
    const receipt = refusalReceipt({ request, decision });
    appendReceipt(receiptLog, receipt);
    process.stderr.write(`${canonicalize({
      decision: decision.decision,
      decision_hash: decision.decision_hash,
      reason: decision.reason,
      request_hash: decision.request_hash,
      schema_version: "mnde.codex.refusal.v1"
    })}\n`);
    process.exit(decision.decision === "PROMPT_REQUIRED" ? 3 : 2);
  }

  const executable = argv[0].toLowerCase() === "node" ? process.execPath : argv[0];
  const result = spawnSync(executable, argv.slice(1), {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    const failedReceipt = signReceipt({
      request,
      decision,
      execution_status: "EXECUTION_SPAWN_FAILED",
      exit_code: 127,
      stdout_hash: sha256Text(""),
      stderr_hash: sha256Text(result.error.message)
    });
    appendReceipt(receiptLog, failedReceipt);
    process.stderr.write(`${canonicalize({ decision: "REFUSE", reason: "ERR_EXECUTION_SPAWN_FAILED", detail: result.error.message })}\n`);
    process.exit(127);
  }

  const receipt = signReceipt({
    request,
    decision,
    execution_status: result.status === 0 ? "EXECUTED_EXIT_0" : "EXECUTED_NONZERO",
    exit_code: result.status ?? 1,
    stdout_hash: sha256Text(result.stdout ?? ""),
    stderr_hash: sha256Text(result.stderr ?? "")
  });
  appendReceipt(receiptLog, receipt);
  process.exit(result.status ?? 1);
}

function remoteDecision(requestPayload) {
  const target = new URL(process.env.MNDE_DECISION_URL ?? DEFAULT_DECISION_URL);
  const body = canonicalize(requestPayload);
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = transport({
      hostname: target.hostname,
      method: "POST",
      path: `${target.pathname}${target.search}`,
      port: target.port,
      timeout: Number.parseInt(process.env.MNDE_DECISION_TIMEOUT_MS ?? "2000", 10),
      headers: {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json; charset=utf-8"
      }
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`ERR_MNDE_DECISION_HTTP_${res.statusCode}`));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          resolve(normalizeRemoteDecision(parsed));
        } catch {
          reject(new Error("ERR_MNDE_DECISION_MALFORMED"));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("ERR_MNDE_DECISION_TIMEOUT"));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function normalizeRemoteDecision(parsed) {
  const decision = parsed.decision;
  if (!["ALLOW", "REFUSE", "PROMPT_REQUIRED"].includes(decision)) {
    throw new Error("ERR_MNDE_DECISION_UNKNOWN");
  }
  return {
    canonical_payload_hash: parsed.canonical_payload_hash ?? parsed.request_hash,
    decision,
    decision_hash: parsed.decision_hash,
    policy_hash: parsed.policy_hash ?? null,
    policy_version: parsed.policy_version ?? "v1",
    reason: parsed.reason ?? parsed.reason_code ?? "ERR_REASON_MISSING",
    request_hash: parsed.request_hash
  };
}

void main().catch((error) => {
  process.stderr.write(`${canonicalize({
    decision: "REFUSE",
    reason: error.message?.startsWith("ERR_") ? error.message : "ERR_MNDE_RUN_FAILED",
    schema_version: "mnde.codex.fail_closed.v1"
  })}\n`);
  process.exit(2);
});
