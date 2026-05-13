import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  canonicalize,
  decide,
  hashCanonical,
  signReceipt,
  verifyReceiptSignature
} from "./decision_engine.mjs";

export function appendReceipt(receiptLog, receipt) {
  const resolved = path.resolve(receiptLog);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${canonicalize(receipt)}\n`, { encoding: "utf8", flag: "a" });
}

export function readReceipts(receiptLog) {
  try {
    return readFileSync(path.resolve(receiptLog), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function verifyReceiptLog(receiptLog, policy) {
  const receipts = readReceipts(receiptLog);
  const report = {
    drift_count: 0,
    invalid_receipts: 0,
    receipt_count: receipts.length,
    schema_version: "mnde.codex.receipt_integrity_report.v1",
    tamper_count: 0,
    valid_receipts: 0
  };
  for (const receipt of receipts) {
    const signatureValid = verifyReceiptSignature(receipt);
    if (!signatureValid) {
      report.invalid_receipts += 1;
      report.tamper_count += 1;
      continue;
    }
    const replayed = decide(receipt.request, policy);
    const drift = replayed.request_hash !== receipt.request_hash
      || replayed.decision !== receipt.decision
      || replayed.reason !== receipt.reason
      || replayed.decision_hash !== receipt.decision_hash;
    if (drift) {
      report.drift_count += 1;
      report.invalid_receipts += 1;
      continue;
    }
    report.valid_receipts += 1;
  }
  return report;
}

export function receiptDigest(receipt) {
  return hashCanonical(receipt);
}

export function refusalReceipt({ request, decision }) {
  return signReceipt({ request, decision, execution_status: "REFUSED_NOT_EXECUTED" });
}
