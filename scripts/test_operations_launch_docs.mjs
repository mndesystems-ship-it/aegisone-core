import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const checklist = readFileSync("OPERATIONS_LAUNCH_CHECKLIST.md", "utf8");
const runbook = readFileSync("operator_runbook.md", "utf8");

for (const required of [
  "POST /v1/decisions",
  "GET /healthz",
  "GET /readyz",
  "GET /metrics",
  "Go/No-Go Summary",
  "Required Configuration",
  "Observability",
  "Logs And Receipts",
  "Key, Policy, And Signer Handling",
  "Fail-Closed Behavior",
  "Upgrade And Rollback",
  "Evidence To Save"
]) {
  assert.match(checklist, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

for (const required of [
  "OPERATIONS_LAUNCH_CHECKLIST.md",
  "Launch Go/No-Go",
  "POST /v1/decisions"
]) {
  assert.match(runbook, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

console.log("PASS operations launch docs tests");
