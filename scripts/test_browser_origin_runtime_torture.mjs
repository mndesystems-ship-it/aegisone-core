import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

const SIDECAR_URL = "http://127.0.0.1:8787";
const DECISIONS_URL = `${SIDECAR_URL}/v1/decisions`;
const OUT_DIR = join(process.cwd(), "sidecar-scaling-output", "browser-origin-runtime-torture");
const RECEIPT_LOG = join(OUT_DIR, "receipts.jsonl");
const SUMMARY_PATH = join(OUT_DIR, "summary.json");
const LATENCY_PATH = join(OUT_DIR, "latency.json");
const FAILURE_MATRIX_PATH = join(OUT_DIR, "failure-matrix.json");
const RUN_ID = `${process.pid}-${Date.now()}`;

mkdirSync(OUT_DIR, { recursive: true });
rmSync(RECEIPT_LOG, { force: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseRequest(id, mode = "allow") {
  const highCost = mode === "refuse";
  return {
    execution_request: {
      request_id: id,
      submitted_region: "us-west-2",
      actor: { user_id: "browser-origin-torture" },
      resources: { gpu_type: "a10g", gpu_count: highCost ? 99 : 2, hours: 4 },
      execution: { auto_scale: false, max_scale_multiplier: 1, retry_on_fail: false, max_retries: 0 },
      tool_calls: [{ tool: "provision-gpu-job", priority: 1 }],
      orbit_intent: {
        orbit_version: "2.0",
        action: "execute",
        boundary: "production-local",
        payload: { tool_calls: [{ tool: "provision-gpu-job", priority: 1 }] },
        lifecycle_state: "ARMED",
        signatures: [{ alg: "ed25519.v1", sig: "operator-approved" }]
      },
      release_request: { execution_id: id, hold_state: "APPROVED", already_consumed: false },
      runtime_observation: {
        kill_switch_active: false,
        actual_gpu_count: highCost ? 99 : 2,
        actual_hours: 4,
        actual_total_cost_cents: highCost ? 198000 : 4000
      }
    },
    pricing_data: { gpu_hour_cents: 500 }
  };
}

function requestText(url, {
  method = "GET",
  body = null,
  timeoutMs = 1_000,
  agent = false,
  origin = "http://127.0.0.1:8080"
} = {}) {
  const target = new URL(url);
  const headers = {
    origin,
    referer: `${origin}/`,
    "user-agent": "MNDeBrowserOriginTorture/1.0"
  };
  if (body) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      agent,
      timeout: timeoutMs,
      headers
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        latency_ms: Math.max(0, Math.round(performance.now() - started)),
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("request timeout"), { code: "ETESTTIMEOUT" })));
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

async function waitForHealth(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await requestText(`${SIDECAR_URL}/healthz`, { timeoutMs: 500, agent: false });
      if (res.status === 200 && JSON.parse(res.text).ok === true) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error("ERR_HEALTH_TIMEOUT");
}

async function continuousHealthPoll(stop, metrics) {
  while (!stop.done) {
    try {
      const res = await requestText(`${SIDECAR_URL}/healthz`, { timeoutMs: 500, agent: false });
      metrics.health_polls += 1;
      metrics.health_latency_ms.push(res.latency_ms);
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.text).ok, true);
    } catch (error) {
      metrics.health_failures += 1;
      recordError(metrics, "health", error);
    }
    await sleep(50);
  }
}

async function runBrowserTraffic(profile, metrics) {
  const agents = Array.from({ length: profile.agents }, () => new http.Agent({
    keepAlive: true,
    maxSockets: profile.maxSockets,
    maxFreeSockets: profile.maxFreeSockets,
    timeout: 1_000
  }));
  let sequence = 0;
  const end = Date.now() + profile.duration_ms;
  const workers = Array.from({ length: profile.concurrency }, async (_, workerIndex) => {
    const agent = agents[workerIndex % agents.length];
    while (Date.now() < end) {
      const mode = sequence % 5 === 0 ? "refuse" : "allow";
      const id = `browser-origin-${RUN_ID}-${profile.name}-${workerIndex}-${sequence++}`;
      const body = JSON.stringify(baseRequest(id, mode));
      try {
        const res = await requestText(DECISIONS_URL, { method: "POST", body, timeoutMs: 1_500, agent });
        metrics.decisions += 1;
        metrics.decision_latency_ms.push(res.latency_ms);
        const parsed = JSON.parse(res.text);
        if (parsed.decision === "ALLOW") metrics.allows += 1;
        if (parsed.decision === "REFUSE") metrics.refusals += 1;
        if (parsed.decision === "ALLOW" && !parsed.receipt?.verifiable_signature?.value && !parsed.receipt?.signature?.value) {
          metrics.unsigned_allows += 1;
        }
      } catch (error) {
        metrics.decision_errors += 1;
        recordError(metrics, profile.name, error);
      }
      if (sequence % profile.refreshEvery === 0) {
        try {
          await requestText(`${SIDECAR_URL}/readyz`, { timeoutMs: 750, agent });
          metrics.refreshes += 1;
        } catch (error) {
          metrics.refresh_errors += 1;
          recordError(metrics, "refresh", error);
        }
      }
    }
  });
  await Promise.all(workers);
  for (const agent of agents) agent.destroy();
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function recordError(metrics, phase, error) {
  if (metrics.errors.length < 100) {
    metrics.errors.push({ phase, code: error.code ?? error.message });
  }
}

async function maybeMetrics() {
  try {
    const res = await requestText(`${SIDECAR_URL}/metrics`, { timeoutMs: 1_000, agent: false });
    return res.text;
  } catch {
    return "";
  }
}

const child = spawn(process.execPath, ["--experimental-strip-types", ".\\mnde-local-sidecar.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MNDE_RECEIPT_LOG: RECEIPT_LOG,
    MNDE_HTTP_REQUEST_TIMEOUT_MS: "1200",
    MNDE_HTTP_KEEP_ALIVE_TIMEOUT_MS: "150",
    MNDE_HTTP_HEADERS_TIMEOUT_MS: "800",
    MNDE_HTTP_MAX_ACTIVE_REQUESTS: "16",
    MNDE_HTTP_MAX_ACTIVE_SOCKETS: "64",
    MNDE_HTTP_MAX_REQUESTS_PER_SOCKET: "8",
    MNDE_L0_ENABLE: "1",
    MNDE_L0_MAX_CONNECTIONS: "32",
    MNDE_L0_HYBRID_503_CONNECTIONS: "48",
    MNDE_L0_KEEPALIVE_TIMEOUT_MS: "150",
    MNDE_L0_HEADERS_TIMEOUT_MS: "800",
    MNDE_WORKER_POOL_SIZE: "2",
    MNDE_WORKER_QUEUE_MAX_DEPTH: "8",
    MNDE_WORKER_TASK_TIMEOUT_MS: "1000",
    MNDE_RECEIPT_QUEUE_MAX_ITEMS: "256",
    MNDE_RECEIPT_QUEUE_MAX_BYTES: "1048576",
    MNDE_RECEIPT_BATCH_MAX_SIZE: "32",
    MNDE_RECEIPT_BATCH_MAX_AGE_MS: "10",
    MNDE_RECEIPT_FLUSH_TIMEOUT_MS: "1000",
    MNDE_SOCKET_IDLE_TIMEOUT_MS: "300",
    MNDE_WATCHDOG_MAX_OPEN_SOCKETS: "64"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
let stdout = "";
let childExit = null;
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
child.on("exit", (code, signal) => {
  childExit = { code, signal };
});

const metrics = {
  health_polls: 0,
  health_failures: 0,
  decisions: 0,
  allows: 0,
  refusals: 0,
  unsigned_allows: 0,
  decision_errors: 0,
  refreshes: 0,
  refresh_errors: 0,
  health_latency_ms: [],
  decision_latency_ms: [],
  errors: []
};
const stop = { done: false };

try {
  await waitForHealth();
  const healthTask = continuousHealthPoll(stop, metrics);
  await runBrowserTraffic({ name: "mixed", agents: 8, maxSockets: 4, maxFreeSockets: 4, concurrency: 16, duration_ms: 2_500, refreshEvery: 7 }, metrics);
  await sleep(500);
  await runBrowserTraffic({ name: "spike", agents: 16, maxSockets: 8, maxFreeSockets: 8, concurrency: 32, duration_ms: 1_500, refreshEvery: 5 }, metrics);
  await sleep(750);
  await runBrowserTraffic({ name: "recovery", agents: 4, maxSockets: 2, maxFreeSockets: 2, concurrency: 8, duration_ms: 1_500, refreshEvery: 11 }, metrics);
  stop.done = true;
  await healthTask;

  const finalHealth = await requestText(`${SIDECAR_URL}/healthz`, { timeoutMs: 1_000, agent: false });
  assert.equal(finalHealth.status, 200, "final health must respond");
  assert.equal(JSON.parse(finalHealth.text).ok, true, "final health must be ok");
  const finalMetrics = await maybeMetrics();
  const summary = {
    schema_version: "mnde.browser_origin_torture.v1",
    metrics: {
      ...metrics,
      health_latency_p95_ms: percentile(metrics.health_latency_ms, 0.95),
      decision_latency_p95_ms: percentile(metrics.decision_latency_ms, 0.95)
    },
    sidecar_metrics_text: finalMetrics,
    stdout,
    stderr,
    receipt_log_exists: true
  };
  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  writeFileSync(LATENCY_PATH, JSON.stringify({
    health_latency_ms: metrics.health_latency_ms,
    decision_latency_ms: metrics.decision_latency_ms
  }, null, 2));
  writeFileSync(FAILURE_MATRIX_PATH, JSON.stringify({
    health_unresponsive: metrics.health_failures,
    decision_transport_errors: metrics.decision_errors,
    refresh_errors: metrics.refresh_errors,
    unsigned_allows: metrics.unsigned_allows
  }, null, 2));

  assert.equal(metrics.health_failures, 0, `health failures: ${JSON.stringify(metrics.errors.slice(0, 5))}`);
  assert.equal(metrics.unsigned_allows, 0);
  assert.ok(metrics.decisions > 0, "must complete decisions");
  assert.ok(metrics.allows > 0, "must include allows");
  assert.ok(metrics.refusals > 0, "must include refusals");
  assert.ok(readFileSync(RECEIPT_LOG, "utf8").trim().length > 0, "receipt log must not be empty");
  process.stdout.write(`PASS browser-origin runtime torture: ${JSON.stringify({
    decisions: metrics.decisions,
    health_polls: metrics.health_polls,
    health_p95: percentile(metrics.health_latency_ms, 0.95),
    decision_p95: percentile(metrics.decision_latency_ms, 0.95)
  })}\n`);
} finally {
  stop.done = true;
  if (metrics.health_polls === 0 || metrics.health_failures > 0) {
    writeFileSync(SUMMARY_PATH, JSON.stringify({
      schema_version: "mnde.browser_origin_torture.debug.v1",
      child_exit: childExit,
      stdout,
      stderr,
      metrics
    }, null, 2));
  }
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
}
