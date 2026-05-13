import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const spec = readFileSync("REVIEW_SPEC.md", "utf8");

for (const required of [
  "Executive Summary",
  "Launch Integration Contract",
  "System Components",
  "Decision Pipeline",
  "Receipt System",
  "No-Code Review UI",
  "Operations Layer",
  "Release Integrity",
  "Request Shape",
  "Response Shape",
  "Security And Safety Model",
  "Operational Requirements",
  "Evidence Already Packaged",
  "Reviewer Walkthrough",
  "Verification Commands",
  "Current Launch Status",
  "Review Questions",
  "Known Non-Goals",
  "POST /v1/decisions",
  "preflight",
  "orbit",
  "arm",
  "ramona"
]) {
  assert.match(spec, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

console.log("PASS review spec docs tests");
