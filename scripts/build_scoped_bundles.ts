import { createHash } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { canonicalizeJson, type JsonValue } from "../shared/json.ts";

type Receipt = {
  canonical_request: string;
  decision_output: {
    decision: "ALLOW" | "REFUSE";
    decision_hash: string;
    reason_code: string;
    policy_version: string;
    request_hash: string;
  };
  pipeline_trace?: {
    preflight?: {
      policy_hash?: string;
    };
  };
  signature: {
    algorithm: string;
    key_id: string;
    value: string;
  };
  request_hash: string;
};

const REPO_ROOT = process.cwd();
const STABLE_DIR = join(REPO_ROOT, "stable-proof-bundle");
const VOLATILE_DIR = join(REPO_ROOT, "volatile-benchmark-bundle");

function ensureCleanDir(path: string) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalWriteJson(path: string, value: JsonValue) {
  writeFileSync(path, `${canonicalizeJson(value)}\n`, "utf8");
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function canonicalJsonLines(path: string, rows: JsonValue[]) {
  const body = rows.map((row) => canonicalizeJson(row)).join("\n");
  writeFileSync(path, body.length > 0 ? `${body}\n` : "", "utf8");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonLines(path: string): Receipt[] {
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) {
    return [];
  }
  return text.split(/\r?\n/).map((line) => JSON.parse(line) as Receipt);
}

function relativeStable(file: string): string {
  return file.replace(`${STABLE_DIR}\\`, "").replace(/\\/g, "/");
}

function buildStableBundle() {
  ensureCleanDir(STABLE_DIR);

  const receipts = readJsonLines(join(REPO_ROOT, "audit-proof-bundle", "signed_receipts.jsonl"))
    .sort((left, right) => left.request_hash.localeCompare(right.request_hash));

  const canonicalRequests = receipts.map((receipt) => ({
    request_hash: receipt.request_hash,
    canonical_request: receipt.canonical_request
  }));
  const decisions = receipts.map((receipt) => ({
    request_hash: receipt.request_hash,
    decision: receipt.decision_output.decision,
    reason_code: receipt.decision_output.reason_code
  }));
  const decisionHashes = receipts.map((receipt) => ({
    request_hash: receipt.request_hash,
    decision_hash: receipt.decision_output.decision_hash
  }));

  const policyMap = new Map<string, { policy_hash: string; policy: JsonValue }>();
  for (const receipt of receipts) {
    const parsed = JSON.parse(receipt.canonical_request) as { policy_document: JsonValue };
    const policyHash = receipt.pipeline_trace?.preflight?.policy_hash ?? sha256(canonicalizeJson(parsed.policy_document));
    if (!policyMap.has(policyHash)) {
      policyMap.set(policyHash, {
        policy_hash: policyHash,
        policy: parsed.policy_document
      });
    }
  }
  const policies = [...policyMap.values()].sort((left, right) => left.policy_hash.localeCompare(right.policy_hash));

  const signatures = receipts.map((receipt) => ({
    request_hash: receipt.request_hash,
    algorithm: receipt.signature.algorithm,
    key_id: receipt.signature.key_id,
    value: receipt.signature.value
  }));

  canonicalJsonLines(join(STABLE_DIR, "canonical_requests.jsonl"), canonicalRequests as JsonValue[]);
  canonicalJsonLines(join(STABLE_DIR, "decisions.jsonl"), decisions as JsonValue[]);
  canonicalJsonLines(join(STABLE_DIR, "decision_hashes.jsonl"), decisionHashes as JsonValue[]);
  canonicalJsonLines(join(STABLE_DIR, "policies.jsonl"), policies as JsonValue[]);
  canonicalJsonLines(join(STABLE_DIR, "signatures.jsonl"), signatures as JsonValue[]);
  canonicalJsonLines(join(STABLE_DIR, "receipts.jsonl"), receipts as unknown as JsonValue[]);
  copyFileSync(join(REPO_ROOT, "external-review-drop", "failure_proofs.json"), join(STABLE_DIR, "failure_proofs.json"));
  copyFileSync(join(REPO_ROOT, "TEST_MATRIX.md"), join(STABLE_DIR, "TEST_MATRIX.md"));

  const manifestEntries = [
    "canonical_requests.jsonl",
    "decisions.jsonl",
    "decision_hashes.jsonl",
    "policies.jsonl",
    "signatures.jsonl",
    "receipts.jsonl",
    "failure_proofs.json",
    "TEST_MATRIX.md"
  ].map((file) => ({
    file,
    sha256: sha256(readFileSync(join(STABLE_DIR, file)))
  }));

  manifestEntries.sort((left, right) => left.file.localeCompare(right.file));

  const manifest = {
    schema_version: "ecs.stable.manifest.v1",
    scope: "stable-proof-bundle",
    reproducibility: "scoped",
    artifacts: manifestEntries
  };

  canonicalWriteJson(join(STABLE_DIR, "manifest.json"), manifest as unknown as JsonValue);

  const stableManifestHash = sha256(readFileSync(join(STABLE_DIR, "manifest.json")));
  const stableReceiptsHash = sha256(readFileSync(join(STABLE_DIR, "receipts.jsonl")));

  canonicalWriteJson(
    join(STABLE_DIR, "hashes.json"),
    {
      stable_manifest_sha256: stableManifestHash,
      stable_receipts_sha256: stableReceiptsHash
    } as unknown as JsonValue
  );

  return {
    stable_manifest_sha256: stableManifestHash,
    stable_receipts_sha256: stableReceiptsHash
  };
}

function buildVolatileBundle() {
  ensureCleanDir(VOLATILE_DIR);

  const files = [
    ["audit-proof-bundle", "summary.json"],
    ["audit-proof-bundle", "benchmark_report.md"],
    ["audit-proof-bundle", "performance_report.json"],
    ["mnde-controlled-benchmark-bundle", "summary.json"],
    ["mnde-controlled-benchmark-bundle", "latency_report.json"],
    ["mnde-controlled-benchmark-bundle", "latency_real_validation.json"],
    ["mnde-controlled-benchmark-bundle", "workload_manifest.json"]
  ] as const;

  for (const [dir, file] of files) {
    copyFileSync(join(REPO_ROOT, dir, file), join(VOLATILE_DIR, `${dir.replace(/-bundle$/, "")}-${file}`));
  }

  const consistencySource = join(REPO_ROOT, "volatile-benchmark-bundle", "benchmark_consistency_report.json");
  const includeConsistencyReport = existsSync(consistencySource);
  if (includeConsistencyReport) {
    copyFileSync(consistencySource, join(VOLATILE_DIR, "volatile-benchmark-benchmark_consistency_report.json"));
  }

  const auditSummary = readJson(join(REPO_ROOT, "audit-proof-bundle", "summary.json"));
  const benchmarkSummary = readJson(join(REPO_ROOT, "mnde-controlled-benchmark-bundle", "summary.json"));

  const benchmarkValidation = {
    schema_version: "ecs.volatile.validation.v1",
    scope: "volatile-benchmark-bundle",
    tolerance_percent: {
      throughput_delta_max: 3,
      latency_p99_delta_max: 3
    },
    metrics: {
      throughput_rps: auditSummary.throughput,
      latency_p99_ms: auditSummary.latency_stats.map((item: any) => ({
        profile: item.profile,
        p99: item.p99
      })),
      controlled_benchmark_p99_ns: benchmarkSummary.before_vs_after.agent_control.measured_p99_latency_ns
    }
  };

  writeJson(join(VOLATILE_DIR, "benchmark_validation.json"), benchmarkValidation);

  const manifest = {
    schema_version: "ecs.volatile.manifest.v1",
    scope: "volatile-benchmark-bundle",
    reproducibility: "excluded",
    artifacts: [
      ...files.map(([dir, file]) => ({
        file: `${dir.replace(/-bundle$/, "")}-${file}`,
        sha256: sha256(readFileSync(join(VOLATILE_DIR, `${dir.replace(/-bundle$/, "")}-${file}`)))
      })),
      {
        file: "benchmark_validation.json",
        sha256: sha256(readFileSync(join(VOLATILE_DIR, "benchmark_validation.json")))
      },
      ...(includeConsistencyReport
        ? [
            {
              file: "volatile-benchmark-benchmark_consistency_report.json",
              sha256: sha256(readFileSync(join(VOLATILE_DIR, "volatile-benchmark-benchmark_consistency_report.json")))
            }
          ]
        : [])
    ].sort((left, right) => left.file.localeCompare(right.file))
  };

  writeJson(join(VOLATILE_DIR, "manifest.json"), manifest);
}

function main() {
  const stable = buildStableBundle();
  buildVolatileBundle();
  process.stdout.write(
    `${JSON.stringify(
      {
        stable_proof_bundle: STABLE_DIR,
        volatile_benchmark_bundle: VOLATILE_DIR,
        ...stable
      },
      null,
      2
    )}\n`
  );
}

main();
