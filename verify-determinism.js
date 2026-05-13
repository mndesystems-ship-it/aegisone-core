import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CSV_PATH = join("results", "determinism_responses.csv");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseCsvLine(line) {
  const first = line.indexOf(",");
  const second = line.indexOf(",", first + 1);
  if (first === -1 || second === -1) {
    return null;
  }
  return {
    timestamp: line.slice(0, first),
    response_code: line.slice(first + 1, second),
    body_base64: line.slice(second + 1)
  };
}

function decisionFields(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    return {
      decision: parsed.decision ?? null,
      reason_code: parsed.reason_code ?? null,
      request_hash: parsed.request_hash ?? null,
      decision_hash: parsed.decision_hash ?? null,
      policy_hash: parsed.policy_hash ?? null
    };
  } catch {
    return {
      decision: null,
      reason_code: "UNPARSEABLE_JSON",
      request_hash: null,
      decision_hash: null,
      policy_hash: null
    };
  }
}

if (!existsSync(CSV_PATH)) {
  console.error(`FAIL missing input file: ${CSV_PATH}`);
  process.exit(1);
}

const lines = readFileSync(CSV_PATH, "utf8").trim().split(/\r?\n/).filter(Boolean);
const rows = lines.slice(1).map(parseCsvLine).filter(Boolean);
const samplesByHash = new Map();
const mismatches = [];

let baseline = null;
for (let index = 0; index < rows.length; index += 1) {
  const row = rows[index];
  const body = Buffer.from(row.body_base64, "base64");
  const bodyText = body.toString("utf8");
  const hash = sha256(body);
  const fields = decisionFields(bodyText);
  if (!samplesByHash.has(hash)) {
    samplesByHash.set(hash, {
      index,
      response_code: row.response_code,
      hash,
      fields,
      body: bodyText.slice(0, 1000)
    });
  }
  if (baseline === null) {
    baseline = { hash, response_code: row.response_code, fields, body: bodyText.slice(0, 1000) };
  } else if (hash !== baseline.hash && mismatches.length < 10) {
    mismatches.push({
      index,
      response_code: row.response_code,
      hash,
      fields,
      body: bodyText.slice(0, 1000)
    });
  }
}

const uniqueHashes = samplesByHash.size;
console.log(`total responses: ${rows.length}`);
console.log(`unique hashes: ${uniqueHashes}`);

if (baseline) {
  console.log(`baseline hash: ${baseline.hash}`);
  console.log(`baseline response_code: ${baseline.response_code}`);
  console.log(`baseline decision: ${baseline.fields.decision}`);
  console.log(`baseline reason_code: ${baseline.fields.reason_code}`);
  console.log(`baseline request_hash: ${baseline.fields.request_hash}`);
  console.log(`baseline decision_hash: ${baseline.fields.decision_hash}`);
}

if (uniqueHashes > 1) {
  console.log("FAIL");
  console.log("first mismatching samples:");
  for (const mismatch of mismatches) {
    console.log(JSON.stringify(mismatch, null, 2));
  }
  process.exit(1);
}

console.log("PASS");
