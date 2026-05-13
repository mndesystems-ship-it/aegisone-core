import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";

const SIDECAR_URL = "http://127.0.0.1:8787";
const DECISIONS_URL = `${SIDECAR_URL}/v1/decisions`;
const RUN_ID = `${process.pid}-${Date.now()}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseRequest(id) {
  return {
    execution_request: {
      request_id: id,
      submitted_region: "us-west-2",
      actor: { user_id: "l0-smoke" },
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

function requestText(url, { method = "GET", body = null, timeoutMs = 2_000, agent = false } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      agent,
      timeout: timeoutMs,
      headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("request timeout"), { name: "AbortError" })));
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

async function waitForHealth(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await requestText(`${SIDECAR_URL}/healthz`, { timeoutMs: 500 });
      if (res.status === 200) return JSON.parse(res.text);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error("health check timed out");
}

async function runOverloadForFiveSeconds() {
  const end = Date.now() + 5_000;
  const counters = {
    completed: 0,
    l0_sheds: 0,
    signed_decisions: 0,
    connection_errors: 0,
    other_errors: 0
  };
  let sequence = 0;
  const workers = Array.from({ length: 24 }, async (_, worker) => {
    while (Date.now() < end) {
      const body = JSON.stringify(baseRequest(`l0-overload-${RUN_ID}-${worker}-${sequence++}`));
      try {
        const res = await requestText(DECISIONS_URL, { method: "POST", body, timeoutMs: 1_000, agent: false });
        counters.completed += 1;
        const parsed = JSON.parse(res.text);
        if (parsed.reason_code === "ERR_L0_TRANSPORT_SHED") counters.l0_sheds += 1;
        if (parsed.receipt?.signature?.value || parsed.receipt?.verifiable_signature?.value) counters.signed_decisions += 1;
      } catch (error) {
        if (["ECONNRESET", "ECONNREFUSED", "EPIPE"].includes(error.code)) counters.connection_errors += 1;
        else counters.other_errors += 1;
      }
    }
  });
  await Promise.all(workers);
  return counters;
}

const externalSidecar = process.env.MNDE_L0_SMOKE_EXTERNAL === "1";
const smokeMode = process.env.MNDE_L0_SMOKE_MODE ?? "503";
const child = externalSidecar ? null : spawn(process.execPath, ["--experimental-strip-types", ".\\mnde-local-sidecar.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MNDE_L0_ENABLE: "1",
    MNDE_L0_MAX_CONNECTIONS: "2",
    MNDE_L0_BACKLOG: "8",
    MNDE_L0_KEEPALIVE_TIMEOUT_MS: "100",
    MNDE_L0_HEADERS_TIMEOUT_MS: "400",
    MNDE_L0_SHED_MODE: smokeMode,
    MNDE_L0_HYBRID_503_CONNECTIONS: process.env.MNDE_L0_SMOKE_HYBRID_503_CONNECTIONS ?? "128",
    MNDE_HTTP_MAX_ACTIVE_REQUESTS: "1",
    MNDE_HTTP_MAX_ACTIVE_SOCKETS: "128",
    MNDE_HTTP_REQUEST_TIMEOUT_MS: "2000",
    MNDE_WORKER_POOL_SIZE: "2",
    MNDE_WORKER_QUEUE_MAX_DEPTH: "1",
    MNDE_RECEIPT_QUEUE_MAX_ITEMS: "10000",
    MNDE_RECEIPT_QUEUE_MAX_BYTES: "104857600",
    MNDE_RECEIPT_BATCH_MAX_SIZE: "128",
    MNDE_RECEIPT_BATCH_MAX_AGE_MS: "5"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child?.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

try {
  const health = await waitForHealth();
  assert.equal(health.ok, true);

  const normalBody = JSON.stringify(baseRequest(`l0-smoke-allow-${RUN_ID}`));
  const normal = await requestText(DECISIONS_URL, { method: "POST", body: normalBody, timeoutMs: 2_000 });
  assert.equal(normal.status, 200);
  const normalParsed = JSON.parse(normal.text);
  assert.equal(normalParsed.decision, "ALLOW");
  assert.ok(normalParsed.receipt?.signature?.value || normalParsed.receipt?.verifiable_signature?.value);

  const overload = await runOverloadForFiveSeconds();
  assert.ok(overload.completed > 0, "overload must complete HTTP responses");
  if (smokeMode === "503") {
    assert.ok(overload.l0_sheds > 0, "503 overload must produce valid L0 shed responses");
    assert.equal(overload.connection_errors, 0, "503 mode must not explode into connection errors");
  } else if (smokeMode === "hybrid") {
    assert.ok(overload.l0_sheds > 0, "hybrid overload must produce valid L0 shed responses");
    assert.equal(overload.connection_errors, 0, "request-level hybrid overload must not destroy valid HTTP requests");
  }
  assert.equal(overload.other_errors, 0);

  const metrics = await requestText(`${SIDECAR_URL}/metrics`, { timeoutMs: 2_000 });
  assert.equal(metrics.status, 200);
  if (smokeMode === "503") {
    assert.match(metrics.text, /mnde_l0_shed_503_total [1-9]/);
  } else if (smokeMode === "hybrid") {
    assert.match(metrics.text, /mnde_l0_shed_503_total [1-9]/);
    assert.match(metrics.text, /mnde_l0_shed_destroy_total 0/);
  }
  assert.equal(stderr.trim(), "");

  process.stdout.write(`PASS L0 repair smoke (${smokeMode}): ${JSON.stringify(overload)}\n`);
} finally {
  if (child) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 1_000).unref();
  }
}
