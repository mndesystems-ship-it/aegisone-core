#!/usr/bin/env node
import path from "node:path";

import { canonicalize, loadPolicy } from "./codex-mnde/lib/decision_engine.mjs";
import { verifyReceiptLog } from "./codex-mnde/lib/receipts.mjs";

const receiptLog = process.argv[2] ?? process.env.MNDE_RECEIPT_LOG ?? path.resolve("receipts.jsonl");
const policyPath = process.argv[3] ?? process.env.MNDE_CODEX_POLICY ?? path.resolve("codex_mnde_policy.json");
const policy = loadPolicy(policyPath);
const report = verifyReceiptLog(receiptLog, policy);

process.stdout.write(`${canonicalize(report)}\n`);
if (report.invalid_receipts > 0 || report.drift_count > 0 || report.tamper_count > 0) {
  process.exit(1);
}
