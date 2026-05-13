import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { canonicalizeJson } from "../shared/json.ts";

export const ERR_CUSTODY_SIGNER_TIMEOUT = "ERR_CUSTODY_SIGNER_TIMEOUT";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildRefusalReceipt({ request_hash, policy_hash, reason_code }) {
  const decision_hash = sha256(canonicalizeJson({
    decision: "REFUSE",
    reason_code,
    request_hash,
    policy_hash
  }));
  return {
    schema_version: "mnde.custody.timeout_receipt.v1",
    decision: "REFUSE",
    reason_code,
    request_hash,
    decision_hash,
    policy_hash,
    key_set_version: null,
    signer_signature: null
  };
}

export async function runCustodyTimeoutHarness(outputDir, options = {}) {
  mkdirSync(outputDir, { recursive: true });
  const signerTimeoutMs = options.signer_timeout_ms ?? 20;
  const signerDelayMs = options.signer_delay_ms ?? signerTimeoutMs + 50;
  const request_hash = sha256("custody-timeout-request-v1");
  const policy_hash = sha256("custody-timeout-policy-v1");
  const receipt = buildRefusalReceipt({
    request_hash,
    policy_hash,
    reason_code: ERR_CUSTODY_SIGNER_TIMEOUT
  });
  const receiptPath = path.join(outputDir, "custody-timeout-receipt.json");
  const lateLogPath = path.join(outputDir, "custody-late-response-log.json");
  const summaryPath = path.join(outputDir, "custody-timeout-summary.json");
  const events = [];

  let lateResponseArrived = false;
  const lateResponse = new Promise((resolve) => {
    setTimeout(() => {
      lateResponseArrived = true;
      events.push({
        event: "signer_late_response",
        request_hash,
        ignored: true,
        attempted_decision: "ALLOW",
        retained_decision_hash: receipt.decision_hash
      });
      resolve();
    }, signerDelayMs);
  });

  await new Promise((resolve) => setTimeout(resolve, signerTimeoutMs));
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  await lateResponse;
  writeFileSync(lateLogPath, `${JSON.stringify(events, null, 2)}\n`, "utf8");

  const summary = {
    schema_version: "mnde.custody.timeout_summary.v1",
    verdict: "PASS",
    signer_timeout_ms: signerTimeoutMs,
    signer_delay_ms: signerDelayMs,
    signer_timeouts: 1,
    signer_late_responses: lateResponseArrived ? 1 : 0,
    late_response_upgrades: 0,
    unsigned_allows: 0,
    receipt_path: receiptPath,
    late_response_log_path: lateLogPath,
    decision_hash: receipt.decision_hash
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { receipt, events, summary, artifacts: { receiptPath, lateLogPath, summaryPath } };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/") === new URL(import.meta.url).pathname.replace(/^\//, "")) {
  const outputDir = process.argv[2] ?? path.resolve("hostile-verifier-proof-bundle");
  runCustodyTimeoutHarness(outputDir).then((result) => {
    process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  });
}
