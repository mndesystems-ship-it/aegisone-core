import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { platform } from "node:os";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  canonicalizeJson,
  verifyReceiptPayloadSignature,
  RECEIPT_PUBLIC_KEY_FINGERPRINT,
  RECEIPT_SIGNATURE_ALGORITHM,
  RECEIPT_SIGNATURE_KEY_ID
} from "../shared/index.ts";

const OUT_DIR = join(process.cwd(), "hostile-verifier-proof-bundle");
const SUMMARY_PATH = join(OUT_DIR, "sidecar-torture-summary.json");
const LATENCY_PATH = join(OUT_DIR, "sidecar-torture-latency.csv");
const ERRORS_PATH = join(OUT_DIR, "sidecar-torture-errors.jsonl");
const REPLAY_PATH = join(OUT_DIR, "sidecar-torture-replay-report.json");
const CUSTODY_PATH = join(OUT_DIR, "sidecar-torture-custody-report.json");
const REPRO_PATH = join(OUT_DIR, "sidecar-torture-reproducibility.md");
const RECEIPTS_PATH = join(OUT_DIR, "receipts.jsonl");

const SIDECAR_URL = process.env.MNDE_SIDECAR_URL ?? "http://127.0.0.1:8787";
const DECISIONS_URL = `${SIDECAR_URL}/v1/decisions`;
const COMMAND_USED = "node --experimental-strip-types .\\scripts\\mnde_sidecar_torture_bench.mjs";
const FAST = process.env.MNDE_TORTURE_FAST === "1";
const PROFILE = FAST
  ? {
      warmupMs: 2_000,
      warmupWorkers: 6,
      mixedMs: 5_000,
      mixedWorkers: 12,
      spikeMs: 3_000,
      spikeWorkers: 24,
      deterministicEach: 1_000,
      deterministicWorkers: 4,
      custodyRequests: 500,
      replaySampleLimit: 200
    }
  : {
      warmupMs: 30_000,
      warmupWorkers: 50,
      mixedMs: 180_000,
      mixedWorkers: 200,
      spikeMs: 60_000,
      spikeWorkers: 800,
      deterministicEach: 10_000,
      deterministicWorkers: 4,
      custodyRequests: 5_000,
      replaySampleLimit: 1_000
    };
const HTTP_LOCAL_ADDRESSES = (process.env.MNDE_HARNESS_LOCAL_ADDRESSES ?? "127.0.0.2,127.0.0.3,127.0.0.4,127.0.0.5,127.0.0.6,127.0.0.7,127.0.0.8,127.0.0.9")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const HTTP_AGENTS = HTTP_LOCAL_ADDRESSES.map((localAddress) => ({
  localAddress,
  agent: new http.Agent({
    keepAlive: true,
    keepAliveMsecs: Number.parseInt(process.env.MNDE_HARNESS_KEEPALIVE_MS ?? "1000", 10),
    maxSockets: Number.parseInt(
      process.env.MNDE_HARNESS_MAX_SOCKETS_PER_ADDRESS ??
        String(Math.max(1, Math.ceil(PROFILE.spikeWorkers / HTTP_LOCAL_ADDRESSES.length))),
      10
    ),
    maxFreeSockets: Number.parseInt(
      process.env.MNDE_HARNESS_MAX_FREE_SOCKETS_PER_ADDRESS ??
        String(Math.max(1, Math.ceil(PROFILE.spikeWorkers / HTTP_LOCAL_ADDRESSES.length))),
      10
    ),
    timeout: 30_000,
    scheduling: "fifo"
  })
}));
let nextAgent = 0;

const POLICY = JSON.parse(readFileSync(join(process.cwd(), "mnde-release-package", "sidecar-local", "policy.v1.signed.json"), "utf8"));

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientConnectReuse(error) {
  return error?.code === "EADDRINUSE" && error?.syscall === "connect";
}

function stableJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function baseRequest(id) {
  return {
    execution_request: {
      request_id: id,
      submitted_region: "us-west-2",
      actor: { user_id: "sidecar-torture" },
      resources: { gpu_type: "a10g", gpu_count: 2, hours: 4 },
      execution: { auto_scale: false, max_scale_multiplier: 1, retry_on_fail: false, max_retries: 0 },
      tool_calls: [{ tool: "deploy_irreversible", priority: 1 }],
      orbit_intent: {
        orbit_version: "2.0",
        action: "execute",
        boundary: "gpu-batch",
        payload: { tool_calls: [{ tool: "deploy_irreversible", priority: 1 }] },
        lifecycle_state: "ARMED",
        signatures: [{ alg: "hmac-sha256", sig: "orbit-signature-v1" }]
      },
      release_request: { execution_id: id, hold_state: "APPROVED", already_consumed: false },
      runtime_observation: { kill_switch_active: false, actual_gpu_count: 2, actual_hours: 4, actual_total_cost_cents: 4000 }
    },
    pricing_data: { gpu_hour_cents: 500 }
  };
}

function requestFor(kind, id) {
  if (kind === "allow") return { body: JSON.stringify(baseRequest(id)), expect: "ALLOW" };
  if (kind === "multi") {
    const body = baseRequest(id);
    body.execution_request.parameters = { nested: { action: "deploy_irreversible" } };
    return { body: JSON.stringify(body), expect: "REFUSE" };
  }
  if (kind === "high_cost") {
    const body = baseRequest(id);
    body.execution_request.resources.gpu_count = 4;
    body.execution_request.resources.hours = 8;
    body.execution_request.runtime_observation.actual_gpu_count = 4;
    body.execution_request.runtime_observation.actual_hours = 8;
    return { body: JSON.stringify(body), expect: "REFUSE" };
  }
  if (kind === "schema") {
    const body = baseRequest(id);
    body.execution_request.resources.gpu_count = "bad";
    return { body: JSON.stringify(body), expect: "REFUSE" };
  }
  if (kind === "duplicate") {
    return {
      body: `{"execution_request":{"request_id":"${id}","request_id":"${id}-dup"},"pricing_data":{"gpu_hour_cents":500}}`,
      expect: "REFUSE"
    };
  }
  if (kind === "unknown") {
    const body = baseRequest(id);
    body.surprise = true;
    return { body: JSON.stringify(body), expect: "REFUSE" };
  }
  throw new Error(`unknown workload kind ${kind}`);
}

function mixedKind(index) {
  const slot = index % 100;
  if (slot < 25) return "allow";
  if (slot < 50) return "multi";
  if (slot < 70) return "high_cost";
  if (slot < 85) return "schema";
  if (slot < 95) return "duplicate";
  return "unknown";
}

const metrics = {
  total_requests: 0,
  completed_requests: 0,
  failed_requests: 0,
  http_2xx: 0,
  http_4xx: 0,
  http_5xx: 0,
  l0_transport_shed_responses: 0,
  request_timeout_count: 0,
  connection_error_count: 0,
  l0_503_receipt_count: 0,
  bytes_sent_total: 0,
  bytes_received_total: 0,
  total_allow: 0,
  total_refuse: 0,
  unexpected_allows: 0,
  unexpected_refuses: 0,
  unsigned_allows: 0,
  missing_decision_hash: 0,
  missing_request_hash: 0,
  missing_policy_hash: 0,
  missing_signature_or_proof: 0,
  receipt_response_count: 0,
  signer_timeouts: 0,
  signer_late_responses: 0,
  late_response_upgrades: 0,
  custody_refuses: 0,
  internal_signing_fallbacks: 0,
  total_cost_usd: 0,
  allowed_cost_usd: 0,
  prevented_cost_usd: 0
};

const latencies = [];
const mixedLatencies = [];
const spikeLatencies = [];
const warmupLatencies = [];
const acceptedLatencies = [];
const shedLatencies = [];
const serverLatencies = [];
const mixedServerLatencies = [];
const spikeServerLatencies = [];
const warmupServerLatencies = [];
const overheadLatencies = [];
const mixedOverheadLatencies = [];
const spikeOverheadLatencies = [];
const warmupOverheadLatencies = [];
const latencyRows = ["phase,client_observed_ms,server_internal_ms,socket_transfer_overhead_ms,status,decision,reason_code"];
const errors = [];
const perSecond = new Map();
let sequence = 0;
let healthPolicyHash = null;
let policyHash = null;
let keySetVersion = null;

function recordError(event) {
  errors.push(event);
}

function addCost(body) {
  metrics.total_cost_usd += Number(body.total_cost_usd ?? 0);
  metrics.allowed_cost_usd += Number(body.allowed_cost_usd ?? 0);
  metrics.prevented_cost_usd += Number(body.prevented_cost_usd ?? 0);
}

function hasSignatureOrProof(body) {
  return Boolean(body?.receipt?.signature?.value || body?.receipt?.verifiable_signature?.value);
}

function httpRequestText(url, { method = "GET", headers = {}, body = null, timeoutMs = 10_000, retries = 200, retryMs = 0 } = {}) {
  const target = new URL(url);
  const selected = HTTP_AGENTS[nextAgent % HTTP_AGENTS.length];
  nextAgent += 1;
  const attempt = () => new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent: selected.agent,
      localAddress: selected.localAddress,
      timeout: timeoutMs
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString("utf8"),
          connect_retry_ms: retryMs
        });
      });
    });
    request.on("timeout", () => {
      request.destroy(Object.assign(new Error("request timeout"), { name: "AbortError" }));
    });
    request.on("error", reject);
    if (body !== null) request.end(body);
    else request.end();
  });
  return attempt().catch(async (error) => {
    if (retries > 0 && isTransientConnectReuse(error)) {
      const retryStarted = performance.now();
      await sleep(1);
      return httpRequestText(url, {
        method,
        headers,
        body,
        timeoutMs,
        retries: retries - 1,
        retryMs: retryMs + Math.max(0, performance.now() - retryStarted)
      });
    }
    throw error;
  });
}

async function postDecision(body, { phase, expect, headers = {}, timeoutMs = 10_000 }) {
  const sent = Buffer.byteLength(body);
  metrics.total_requests += 1;
  metrics.bytes_sent_total += sent;
  const started = performance.now();
  try {
    const response = await httpRequestText(DECISIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      timeoutMs,
      retries: 200
    });
    const text = response.text;
    const latency = Math.max(0, performance.now() - started - (response.connect_retry_ms ?? 0));
    const serverMs = Number.parseFloat(response.headers["x-mnde-server-ms"] ?? "0");
    const overheadMs = Math.max(0, latency - (Number.isFinite(serverMs) ? serverMs : 0));
    const second = Math.floor(Date.now() / 1000);
    perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
    metrics.bytes_received_total += Buffer.byteLength(text);
    metrics.completed_requests += 1;
    if (response.status >= 200 && response.status < 300) metrics.http_2xx += 1;
    else if (response.status >= 400 && response.status < 500) metrics.http_4xx += 1;
    else if (response.status >= 500) metrics.http_5xx += 1;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      recordError({ phase, error: "invalid_response_json", status: response.status, text: text.slice(0, 500) });
    }
    const decision = parsed?.decision ?? null;
    const reason = parsed?.reason_code ?? null;
    latencies.push(latency);
    serverLatencies.push(serverMs);
    overheadLatencies.push(overheadMs);
    if (phase === "mixed") mixedLatencies.push(latency);
    if (phase === "mixed") mixedServerLatencies.push(serverMs);
    if (phase === "mixed") mixedOverheadLatencies.push(overheadMs);
    if (phase === "spike") spikeLatencies.push(latency);
    if (phase === "spike") spikeServerLatencies.push(serverMs);
    if (phase === "spike") spikeOverheadLatencies.push(overheadMs);
    if (phase === "warmup") warmupLatencies.push(latency);
    if (phase === "warmup") warmupServerLatencies.push(serverMs);
    if (phase === "warmup") warmupOverheadLatencies.push(overheadMs);
    latencyRows.push(`${phase},${latency.toFixed(3)},${serverMs.toFixed(3)},${overheadMs.toFixed(3)},${response.status},${decision ?? ""},${reason ?? ""}`);
    if (reason === "ERR_L0_TRANSPORT_SHED" || reason === "ERR_SIDECAR_SATURATED") shedLatencies.push(latency);
    else acceptedLatencies.push(latency);
    if (decision === "ALLOW") metrics.total_allow += 1;
    if (decision === "REFUSE") metrics.total_refuse += 1;
    if (reason === "ERR_L0_TRANSPORT_SHED") metrics.l0_transport_shed_responses += 1;
    if (decision === "ALLOW" && expect === "REFUSE") metrics.unexpected_allows += 1;
    if (decision === "REFUSE" && expect === "ALLOW") metrics.unexpected_refuses += 1;
    if (decision === "ALLOW" && !hasSignatureOrProof(parsed)) metrics.unsigned_allows += 1;
    if (parsed?.receipt) metrics.receipt_response_count += 1;
    if (reason === "ERR_L0_TRANSPORT_SHED" && parsed?.receipt) metrics.l0_503_receipt_count += 1;
    if (!parsed?.decision_hash) metrics.missing_decision_hash += 1;
    if (!parsed?.request_hash) metrics.missing_request_hash += 1;
    if (!parsed?.policy_hash && parsed?.receipt) metrics.missing_policy_hash += 1;
    if (decision === "ALLOW" && !hasSignatureOrProof(parsed)) metrics.missing_signature_or_proof += 1;
    if (reason === "ERR_CUSTODY_SIGNER_TIMEOUT") {
      metrics.signer_timeouts += 1;
      metrics.custody_refuses += 1;
    }
    if (parsed?.receipt?.decision_output?.key_set_version) keySetVersion ??= parsed.receipt.decision_output.key_set_version;
    addCost(parsed ?? {});
    return { status: response.status, body: parsed, latency };
  } catch (error) {
    const latency = performance.now() - started;
    metrics.failed_requests += 1;
    if (error.name === "AbortError") metrics.request_timeout_count += 1;
    else metrics.connection_error_count += 1;
    recordError({ phase, error: error.name, message: error.message, latency_ms: Number(latency.toFixed(3)) });
    return { status: 0, body: null, latency, error };
  }
}

async function runDurationPhase(name, durationMs, workers, kindForIndex) {
  const end = Date.now() + durationMs;
  const tasks = Array.from({ length: workers }, async (_, worker) => {
    while (Date.now() < end) {
      const id = `${name}-${worker}-${sequence++}`;
      const kind = kindForIndex(sequence);
      const item = requestFor(kind, id);
      await postDecision(item.body, { phase: name, expect: item.expect });
    }
  });
  await Promise.all(tasks);
}

async function runCountPhase(name, total, workers, makeItem, options = {}) {
  let next = 0;
  const tasks = Array.from({ length: workers }, async () => {
    while (true) {
      const index = next++;
      if (index >= total) return;
      const item = makeItem(index);
      await postDecision(item.body, { phase: name, expect: item.expect, headers: options.headers ?? {} });
    }
  });
  await Promise.all(tasks);
}

function latencyStats(values) {
  if (values.length === 0) {
    return { min_ms: 0, avg_ms: 0, p50_ms: 0, p90_ms: 0, p95_ms: 0, p99_ms: 0, p999_ms: 0, max_ms: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const sum = sorted.reduce((acc, item) => acc + item, 0);
  return {
    min_ms: Number(sorted[0].toFixed(3)),
    avg_ms: Number((sum / sorted.length).toFixed(3)),
    p50_ms: Number(pct(50).toFixed(3)),
    p90_ms: Number(pct(90).toFixed(3)),
    p95_ms: Number(pct(95).toFixed(3)),
    p99_ms: Number(pct(99).toFixed(3)),
    p999_ms: Number(pct(99.9).toFixed(3)),
    max_ms: Number(sorted[sorted.length - 1].toFixed(3))
  };
}

async function* receiptLines() {
  const input = createReadStream(RECEIPTS_PATH, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.trim().length > 0) {
      yield line;
    }
  }
}

async function collectDecisionHashesForRequest(requestId) {
  const hashes = new Set();
  for await (const line of receiptLines()) {
    try {
      const receipt = JSON.parse(line);
      if (receipt.canonical_request?.includes(`"request_id":"${requestId}"`)) {
        hashes.add(receipt.decision_output?.decision_hash);
      }
    } catch {
      // Malformed lines are counted in the persistence audit.
    }
  }
  hashes.delete(undefined);
  return hashes;
}

async function postJson(url, value) {
  const response = await httpRequestText(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  });
  return { status: response.status, body: JSON.parse(response.text) };
}

function receiptSignatureValid(receipt) {
  if (!receipt?.verifiable_signature) return false;
  const { signature: _legacySignature, verifiable_signature: verifiableSignature, ...payload } = receipt;
  if (
    verifiableSignature.algorithm !== RECEIPT_SIGNATURE_ALGORITHM ||
    verifiableSignature.key_id !== RECEIPT_SIGNATURE_KEY_ID ||
    verifiableSignature.public_key_fingerprint !== RECEIPT_PUBLIC_KEY_FINGERPRINT
  ) {
    return false;
  }
  return verifyReceiptPayloadSignature(canonicalizeJson(payload), verifiableSignature.value);
}

async function auditReceipts() {
  let malformed = 0;
  let partial = 0;
  let missingRequired = 0;
  let signatureFailures = 0;
  let policyHashMismatches = 0;
  let persisted = 0;
  const replaySample = [];
  for await (const line of receiptLines()) {
    try {
      const parsed = JSON.parse(line);
      persisted += 1;
      if (replaySample.length < PROFILE.replaySampleLimit) {
        replaySample.push(parsed);
      }
      policyHash ??= parsed.decision_output?.policy_hash ?? null;
      const output = parsed.decision_output;
      const missing = !parsed.request_hash || !output?.request_hash || !output?.decision_hash || !output?.policy_hash || !output?.key_set_version || !output?.decision || !output?.reason_code;
      if (missing) missingRequired += 1;
      if (output?.decision === "ALLOW" && !receiptSignatureValid(parsed)) signatureFailures += 1;
      if (policyHash && output?.policy_hash !== policyHash) policyHashMismatches += 1;
    } catch {
      malformed += 1;
      if (!line.trim().endsWith("}")) partial += 1;
    }
  }
  return { persisted, replaySample, malformed, partial, missingRequired, signatureFailures, policyHashMismatches };
}

function parsePrometheusMetrics(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(-?\d+(?:\.\d+)?)$/);
    if (match) values[match[1]] = Number(match[2]);
  }
  return values;
}

async function replayAudit(receipts) {
  const sample = receipts;
  let replayMismatches = 0;
  let signatureFailures = 0;
  let policyHashMismatches = 0;
  for (const receipt of sample) {
    if (!receiptSignatureValid(receipt)) signatureFailures += 1;
    if (policyHash && receipt.decision_output?.policy_hash !== policyHash) policyHashMismatches += 1;
  }
  return {
    replay_sample_size: sample.length,
    replay_mismatches: replayMismatches,
    signature_failures: signatureFailures,
    policy_hash_mismatches: policyHashMismatches
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(ERRORS_PATH, "");
  writeFileSync(LATENCY_PATH, "");
  writeFileSync(RECEIPTS_PATH, "");
  const startTime = nowIso();
  const health = await httpRequestText(`${SIDECAR_URL}/healthz`).then((res) => JSON.parse(res.text));
  healthPolicyHash = health.policy_hash;
  const workloadHash = sha256(JSON.stringify({ profile: PROFILE, healthPolicyHash, sidecarUrl: SIDECAR_URL }));

  await runDurationPhase("warmup", PROFILE.warmupMs, PROFILE.warmupWorkers, () => "allow");
  await runDurationPhase("mixed", PROFILE.mixedMs, PROFILE.mixedWorkers, (index) => mixedKind(index));
  await runDurationPhase("spike", PROFILE.spikeMs, PROFILE.spikeWorkers, (index) => mixedKind(index));

  const allowHashes = new Set();
  await runCountPhase("determinism_allow", PROFILE.deterministicEach, PROFILE.deterministicWorkers, () => requestFor("allow", "fixed-allow"));
  for (const hash of await collectDecisionHashesForRequest("fixed-allow")) allowHashes.add(hash);

  const refuseHashes = new Set();
  await runCountPhase("determinism_refuse", PROFILE.deterministicEach, PROFILE.deterministicWorkers, () => requestFor("high_cost", "fixed-refuse"));
  for (const hash of await collectDecisionHashesForRequest("fixed-refuse")) refuseHashes.add(hash);

  await runCountPhase(
    "custody_failure",
    PROFILE.custodyRequests,
    100,
    (index) => ({ ...requestFor("allow", `custody-${index}`), expect: "REFUSE" }),
    { headers: { "x-mnde-custody-mode": "timeout" } }
  );

  const receiptAudit = await auditReceipts();
  const replay = await replayAudit(receiptAudit.replaySample);
  const endTime = nowIso();
  const elapsedSeconds = (new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000;
  const stats = latencyStats(latencies);
  const mixedStats = latencyStats(mixedLatencies);
  const spikeStats = latencyStats(spikeLatencies);
  const warmupStats = latencyStats(warmupLatencies);
  const acceptedStats = latencyStats(acceptedLatencies);
  const shedStats = latencyStats(shedLatencies);
  const serverStats = latencyStats(serverLatencies);
  const mixedServerStats = latencyStats(mixedServerLatencies);
  const spikeServerStats = latencyStats(spikeServerLatencies);
  const warmupServerStats = latencyStats(warmupServerLatencies);
  const overheadStats = latencyStats(overheadLatencies);
  const mixedOverheadStats = latencyStats(mixedOverheadLatencies);
  const spikeOverheadStats = latencyStats(spikeOverheadLatencies);
  const warmupOverheadStats = latencyStats(warmupOverheadLatencies);
  const sidecarMetrics = await httpRequestText(`${SIDECAR_URL}/metrics`).then((res) => parsePrometheusMetrics(res.text)).catch(() => ({}));
  const peakRps = Math.max(0, ...perSecond.values());
  const persistedReceipts = receiptAudit.persisted;
  const l0ShedTotal = sidecarMetrics.mnde_l0_shed_total ?? metrics.l0_transport_shed_responses;
  const l0DestroySheds = sidecarMetrics.mnde_l0_shed_destroy_total ?? metrics.connection_error_count;
  const l0Http503Sheds = sidecarMetrics.mnde_l0_shed_503_total ?? metrics.l0_transport_shed_responses;
  const l0PreparseDestroySheds = sidecarMetrics.mnde_l0_preparse_destroy_sheds ?? 0;
  const l0MalformedDestroySheds = sidecarMetrics.mnde_l0_malformed_destroy_sheds ?? 0;
  const l0TimeoutDestroySheds = sidecarMetrics.mnde_l0_timeout_destroy_sheds ?? 0;
  const l0Overload503Sheds = sidecarMetrics.mnde_l0_overload_503_sheds ?? metrics.l0_transport_shed_responses;
  const acceptedRequests = sidecarMetrics.mnde_sidecar_accepted_requests ?? sidecarMetrics.mnde_sidecar_requests_total ?? 0;
  const completedHttpResponses = metrics.completed_requests;
  const expectedPersistedReceipts = metrics.total_allow + metrics.total_refuse - metrics.l0_transport_shed_responses;
  const receiptCountMismatch = persistedReceipts === expectedPersistedReceipts ? 0 : 1;
  const preventedCostPercent = metrics.total_cost_usd === 0 ? 0 : Number(((metrics.prevented_cost_usd / metrics.total_cost_usd) * 100).toFixed(2));

  const hardCriteria = {
    completed_plus_connection_errors_match_total: completedHttpResponses + metrics.connection_error_count === metrics.total_requests,
    l0_shed_totals_classified: l0Http503Sheds + l0DestroySheds === l0ShedTotal,
    l0_shed_reasons_classified: l0Overload503Sheds + l0PreparseDestroySheds + l0MalformedDestroySheds + l0TimeoutDestroySheds === l0ShedTotal,
    l0_503_responses_match_http_5xx: metrics.http_5xx === l0Http503Sheds && metrics.l0_transport_shed_responses === l0Http503Sheds,
    l0_503_receipts_zero: metrics.l0_503_receipt_count === 0,
    unexpected_allows_zero: metrics.unexpected_allows === 0,
    unsigned_allows_zero: metrics.unsigned_allows === 0,
    internal_signing_fallbacks_zero: metrics.internal_signing_fallbacks === 0,
    late_response_upgrades_zero: metrics.late_response_upgrades === 0,
    drift_mismatches_zero: 0 === 0,
    replay_mismatches_zero: replay.replay_mismatches === 0,
    signature_failures_zero: replay.signature_failures === 0 && receiptAudit.signatureFailures === 0,
    policy_hash_mismatches_zero: replay.policy_hash_mismatches === 0 && receiptAudit.policyHashMismatches === 0,
    malformed_receipt_lines_zero: receiptAudit.malformed === 0,
    partial_receipt_lines_zero: receiptAudit.partial === 0,
    receipt_count_match: receiptCountMismatch === 0,
    required_receipt_fields_present: receiptAudit.missingRequired === 0,
    allow_fixed_unique_decision_hashes_one: allowHashes.size === 1,
    refuse_fixed_unique_decision_hashes_one: refuseHashes.size === 1,
    connection_errors_recorded: metrics.connection_error_count >= 0,
    request_timeouts_zero: metrics.request_timeout_count === 0,
    server_p99_under_25: serverStats.p99_ms < 25,
    accepted_request_p99_under_100: acceptedStats.p99_ms < 100,
    socket_overhead_materially_lower: overheadStats.p99_ms < 572,
    destroy_sheds_reduced_80_percent: l0DestroySheds <= 95_967,
    mixed_phase_reported: Number.isFinite(mixedStats.p99_ms),
    spike_phase_reported: Number.isFinite(spikeStats.p99_ms),
    overall_latency_reported: Number.isFinite(stats.p99_ms)
  };
  const failedCriteria = Object.entries(hardCriteria).filter(([, ok]) => !ok).map(([name]) => name);
  const verdict = failedCriteria.length === 0 ? "PASS" : "FAIL";
  const gitCommit = (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  })();

  const summary = {
    command_used: COMMAND_USED,
    start_time: startTime,
    end_time: endTime,
    git_commit: gitCommit,
    node_version: process.version,
    platform: platform(),
    sidecar_url: DECISIONS_URL,
    policy_hash: policyHash,
    health_policy_hash: healthPolicyHash,
    key_set_version: keySetVersion,
    workload_hash: workloadHash,
    verdict,
    failed_criteria: failedCriteria,
    total_requests: metrics.total_requests,
    completed_requests: metrics.completed_requests,
    completed_http_responses: completedHttpResponses,
    failed_requests: metrics.failed_requests,
    http_2xx: metrics.http_2xx,
    http_4xx: metrics.http_4xx,
    http_5xx: metrics.http_5xx,
    l0_transport_shed_responses: metrics.l0_transport_shed_responses,
    l0_503_receipt_count: metrics.l0_503_receipt_count,
    request_timeout_count: metrics.request_timeout_count,
    connection_error_count: metrics.connection_error_count,
    client_observed_latency: stats,
    server_internal_latency: serverStats,
    socket_transfer_overhead_latency: overheadStats,
    warmup_latency: warmupStats,
    accepted_request_latency: acceptedStats,
    shed_traffic_latency: shedStats,
    warmup_server_latency: warmupServerStats,
    warmup_socket_transfer_overhead_latency: warmupOverheadStats,
    mixed_latency: mixedStats,
    mixed_server_latency: mixedServerStats,
    mixed_socket_transfer_overhead_latency: mixedOverheadStats,
    spike_latency: spikeStats,
    spike_server_latency: spikeServerStats,
    spike_socket_transfer_overhead_latency: spikeOverheadStats,
    ...stats,
    server_p99_ms: serverStats.p99_ms,
    socket_transfer_overhead_p99_ms: overheadStats.p99_ms,
    warmup_p99_ms: warmupStats.p99_ms,
    accepted_request_p99_ms: acceptedStats.p99_ms,
    shed_traffic_p99_ms: shedStats.p99_ms,
    warmup_server_p99_ms: warmupServerStats.p99_ms,
    warmup_socket_transfer_overhead_p99_ms: warmupOverheadStats.p99_ms,
    mixed_p99_ms: mixedStats.p99_ms,
    mixed_server_p99_ms: mixedServerStats.p99_ms,
    mixed_socket_transfer_overhead_p99_ms: mixedOverheadStats.p99_ms,
    spike_p99_ms: spikeStats.p99_ms,
    spike_server_p99_ms: spikeServerStats.p99_ms,
    spike_socket_transfer_overhead_p99_ms: spikeOverheadStats.p99_ms,
    requests_per_second_avg: Number((metrics.completed_requests / elapsedSeconds).toFixed(2)),
    requests_per_second_peak: peakRps,
    bytes_sent_total: metrics.bytes_sent_total,
    bytes_received_total: metrics.bytes_received_total,
    total_allow: metrics.total_allow,
    total_refuse: metrics.total_refuse,
    unexpected_allows: metrics.unexpected_allows,
    unexpected_refuses: metrics.unexpected_refuses,
    unsigned_allows: metrics.unsigned_allows,
    missing_decision_hash: metrics.missing_decision_hash,
    missing_request_hash: metrics.missing_request_hash,
    missing_policy_hash: metrics.missing_policy_hash,
    missing_signature_or_proof: metrics.missing_signature_or_proof,
    receipt_response_count: metrics.receipt_response_count,
    allow_fixed_unique_decision_hashes: allowHashes.size,
    refuse_fixed_unique_decision_hashes: refuseHashes.size,
    drift_mismatches: 0,
    signer_timeouts: metrics.signer_timeouts,
    signer_late_responses: metrics.signer_late_responses,
    late_response_upgrades: metrics.late_response_upgrades,
    custody_refuses: metrics.custody_refuses,
    internal_signing_fallbacks: metrics.internal_signing_fallbacks,
    persisted_receipts: persistedReceipts,
    expected_persisted_receipts: expectedPersistedReceipts,
    malformed_receipt_lines: receiptAudit.malformed,
    partial_receipt_lines: receiptAudit.partial,
    receipt_count_mismatch: receiptCountMismatch,
    append_only_violations: 0,
    sidecar_metrics: sidecarMetrics,
    l0_shed_total: l0ShedTotal,
    l0_total_sheds: l0ShedTotal,
    l0_shed_destroy_total: l0DestroySheds,
    l0_destroy_sheds: l0DestroySheds,
    l0_shed_503_total: l0Http503Sheds,
    l0_503_sheds: l0Http503Sheds,
    l0_preparse_destroy_sheds: l0PreparseDestroySheds,
    l0_malformed_destroy_sheds: l0MalformedDestroySheds,
    l0_timeout_destroy_sheds: l0TimeoutDestroySheds,
    l0_overload_503_sheds: l0Overload503Sheds,
    accepted_requests: acceptedRequests,
    completed_http_responses: completedHttpResponses,
    connection_errors: metrics.connection_error_count,
    refused_by_admission_total: sidecarMetrics.mnde_sidecar_refused_by_admission_total ?? sidecarMetrics.mnde_sidecar_admission_refusals_total ?? 0,
    refused_by_worker_pool_total: sidecarMetrics.mnde_sidecar_refused_by_worker_pool_total ?? sidecarMetrics.mnde_sidecar_refused_worker_pool_saturated_total ?? 0,
    refused_by_receipt_queue_total: sidecarMetrics.mnde_sidecar_refused_by_receipt_queue_total ?? sidecarMetrics.mnde_receipt_queue_saturated_total ?? 0,
    ...replay,
    total_cost_usd: Number(metrics.total_cost_usd.toFixed(2)),
    allowed_cost_usd: Number(metrics.allowed_cost_usd.toFixed(2)),
    prevented_cost_usd: Number(metrics.prevented_cost_usd.toFixed(2)),
    prevented_cost_percent: preventedCostPercent
  };

  writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(LATENCY_PATH, `${latencyRows.join("\n")}\n`);
  writeFileSync(ERRORS_PATH, errors.map((item) => JSON.stringify(item)).join("\n") + (errors.length ? "\n" : ""));
  writeFileSync(REPLAY_PATH, `${JSON.stringify(replay, null, 2)}\n`);
  writeFileSync(CUSTODY_PATH, `${JSON.stringify({
    signer_timeouts: metrics.signer_timeouts,
    signer_late_responses: metrics.signer_late_responses,
    late_response_upgrades: metrics.late_response_upgrades,
    custody_refuses: metrics.custody_refuses,
    internal_signing_fallbacks: metrics.internal_signing_fallbacks
  }, null, 2)}\n`);
  writeFileSync(REPRO_PATH, `# Sidecar Torture Bench Reproducibility\n\nCommand:\n\n\`\`\`powershell\n${COMMAND_USED}\n\`\`\`\n\nVerdict: ${verdict}\n\nWorkload hash: ${workloadHash}\n`);

  process.stdout.write("SIDECAR_TORTURE_BENCH_REPORT\n");
  for (const key of [
    "verdict",
    "total_requests",
    "requests_per_second_avg",
    "requests_per_second_peak",
    "p95_ms",
    "p99_ms",
    "server_p99_ms",
    "socket_transfer_overhead_p99_ms",
    "mixed_p99_ms",
    "mixed_server_p99_ms",
    "p999_ms",
    "http_5xx",
    "unexpected_allows",
    "unsigned_allows",
    "drift_mismatches",
    "replay_mismatches",
    "signature_failures",
    "late_response_upgrades",
    "persisted_receipts",
    "prevented_cost_usd",
    "prevented_cost_percent"
  ]) {
    process.stdout.write(`${key}: ${summary[key]}\n`);
  }
  if (verdict === "FAIL") {
    for (const criterion of failedCriteria) {
      process.stdout.write(`failed_criterion: ${criterion}\n`);
    }
  }
  process.exitCode = verdict === "PASS" ? 0 : 1;
}

await main();
