import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const source = process.argv[2] ?? path.join("reviewer-kit", "artifacts", "receipts", "allow-receipt.json");
const outDir = process.argv[3] ?? path.join("tests", "receipts");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeFixture(name, value) {
  writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

mkdirSync(outDir, { recursive: true });
const base = readJson(source);

writeFixture("valid-receipt.json", base);

let fixture = clone(base);
fixture.verifiable_signature.value = `00${fixture.verifiable_signature.value.slice(2)}`;
writeFixture("invalid-signature.json", fixture);

fixture = clone(base);
fixture.request_hash = "0".repeat(64);
fixture.decision_output.request_hash = fixture.request_hash;
fixture.pipeline_trace.preflight.request_hash = fixture.request_hash;
writeFixture("invalid-request-hash.json", fixture);

fixture = clone(base);
fixture.decision_output.decision_hash = "1".repeat(64);
writeFixture("invalid-decision-hash.json", fixture);

fixture = clone(base);
fixture.decision_output.policy_hash = "2".repeat(64);
fixture.pipeline_trace.preflight.policy_hash = fixture.decision_output.policy_hash;
writeFixture("invalid-policy-hash.json", fixture);

writeFileSync(path.join(outDir, "corrupted-json.json"), "{\n  \"schema_version\": \"ecs.receipt.v2\",\n", "utf8");

fixture = clone(base);
delete fixture.canonical_request;
writeFixture("missing-field.json", fixture);

process.stdout.write(`Wrote receipt verifier fixtures to ${outDir}\n`);
