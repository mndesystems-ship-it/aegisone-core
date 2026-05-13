import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createAdmissionController,
  DEFAULT_HTTP_LIMITS,
  DEFAULT_L0_LIMITS,
  ERR_SIDECAR_SATURATED,
  parseHttpLimitConfig,
  parseL0LimitConfig
} from "../sidecar/http_admission.mjs";
import { SocketRegistry } from "../sidecar/socket_registry.mjs";
import { RuntimeWatchdog } from "../sidecar/runtime_watchdog.mjs";
import { ReceiptPersistenceQueue } from "../sidecar/receipt_persistence_queue.mjs";
import { buildSidecarRefusalReceipt } from "../sidecar/refusal_receipt.mjs";
import { verifySignedReceipt } from "../audit/node_runtime.ts";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "mnde-sidecar-admission-"));
}

function testHttpLimitDefaultsAndEnvParsing() {
  assert.equal(DEFAULT_HTTP_LIMITS.max_active_requests, 96);
  assert.equal(DEFAULT_HTTP_LIMITS.max_active_sockets, 128);
  assert.equal(DEFAULT_HTTP_LIMITS.max_request_body_bytes, 1_048_576);
  assert.equal(DEFAULT_HTTP_LIMITS.request_timeout_ms, 10_000);
  assert.equal(DEFAULT_HTTP_LIMITS.keep_alive_timeout_ms, 1_000);
  assert.equal(DEFAULT_HTTP_LIMITS.headers_timeout_ms, 2_000);
  assert.equal(DEFAULT_HTTP_LIMITS.max_requests_per_socket, 100);

  const parsed = parseHttpLimitConfig({
    MNDE_HTTP_MAX_ACTIVE_REQUESTS: "3",
    MNDE_HTTP_MAX_ACTIVE_SOCKETS: "4",
    MNDE_HTTP_MAX_REQUEST_BODY_BYTES: "128",
    MNDE_HTTP_REQUEST_TIMEOUT_MS: "50",
    MNDE_HTTP_KEEP_ALIVE_TIMEOUT_MS: "60",
    MNDE_HTTP_HEADERS_TIMEOUT_MS: "70",
    MNDE_HTTP_MAX_REQUESTS_PER_SOCKET: "2"
  });
  assert.deepEqual(parsed, {
    max_active_requests: 3,
    max_active_sockets: 4,
    max_request_body_bytes: 128,
    request_timeout_ms: 50,
    keep_alive_timeout_ms: 60,
    headers_timeout_ms: 70,
    max_requests_per_socket: 2
  });
}

function testL0LimitDefaultsAndEnvParsing() {
  assert.equal(DEFAULT_L0_LIMITS.enable, true);
  assert.equal(DEFAULT_L0_LIMITS.max_connections, 64);
  assert.equal(DEFAULT_L0_LIMITS.hybrid_503_connections, 72);
  assert.equal(DEFAULT_L0_LIMITS.backlog, 128);
  assert.equal(DEFAULT_L0_LIMITS.keepalive_timeout_ms, 250);
  assert.equal(DEFAULT_L0_LIMITS.headers_timeout_ms, 750);
  assert.equal(DEFAULT_L0_LIMITS.shed_mode, "503");

  assert.deepEqual(parseL0LimitConfig({
    MNDE_L0_ENABLE: "0",
    MNDE_L0_MAX_CONNECTIONS: "2",
    MNDE_L0_HYBRID_503_CONNECTIONS: "6",
    MNDE_L0_BACKLOG: "3",
    MNDE_L0_KEEPALIVE_TIMEOUT_MS: "4",
    MNDE_L0_HEADERS_TIMEOUT_MS: "5",
    MNDE_L0_SHED_MODE: "hybrid"
  }), {
    enable: false,
    max_connections: 2,
    hybrid_503_connections: 6,
    backlog: 3,
    keepalive_timeout_ms: 4,
    headers_timeout_ms: 5,
    shed_mode: "hybrid"
  });

  assert.throws(() => parseL0LimitConfig({
    MNDE_L0_MAX_CONNECTIONS: "8",
    MNDE_L0_HYBRID_503_CONNECTIONS: "7"
  }), /MNDE_L0_HYBRID_503_CONNECTIONS/);
}

function testPreParseAdmissionRefusesBeforeBodyRead() {
  const admission = createAdmissionController({ max_active_requests: 1, max_active_sockets: 10 });
  const first = admission.tryAcquireRequest();
  assert.equal(first.ok, true);
  assert.equal(admission.snapshot().active_requests, 1);

  const refused = admission.tryAcquireRequest();
  assert.deepEqual(refused, { ok: false, reason_code: ERR_SIDECAR_SATURATED, admission_wait_ms: 0 });
  assert.equal(admission.snapshot().refused_by_admission_total, 1);
  assert.equal(admission.snapshot().active_requests, 1);

  first.release();
  assert.equal(admission.snapshot().active_requests, 0);
}

function testActiveSocketCapRefusesImmediately() {
  const admission = createAdmissionController({ max_active_requests: 10, max_active_sockets: 1 });
  const first = admission.tryAcquireSocket();
  assert.equal(first.ok, true);
  const refused = admission.tryAcquireSocket();
  assert.deepEqual(refused, { ok: false, reason_code: ERR_SIDECAR_SATURATED });
  assert.equal(admission.snapshot().active_sockets, 1);
  assert.equal(admission.snapshot().refused_by_admission_total, 1);
  first.release();
}

function testMaxRequestsPerSocketCap() {
  const admission = createAdmissionController({ max_active_requests: 10, max_active_sockets: 10, max_requests_per_socket: 2 });
  const socket = {};
  assert.equal(admission.noteSocketRequest(socket).ok, true);
  assert.equal(admission.noteSocketRequest(socket).ok, true);
  assert.deepEqual(admission.noteSocketRequest(socket), { ok: false, reason_code: ERR_SIDECAR_SATURATED });
}

async function testSignedRefusalReceiptPersistsCompactRefusal() {
  const root = tempRoot();
  try {
    const file = path.join(root, "receipts.jsonl");
    const queue = new ReceiptPersistenceQueue({
      path: file,
      durability_mode: "strict_audit",
      max_items: 32,
      max_bytes: 100_000,
      max_batch_size: 8,
      max_batch_age_ms: 1
    });
    await queue.start();

    const receipt = buildSidecarRefusalReceipt({
      raw_body: "{\"bad\":true}",
      reason_code: ERR_SIDECAR_SATURATED,
      policy_hash: "policy-hash",
      policy_version: "policy.v1",
      timings: { total_server_ms: 1.25, socket_accepted_ms: 123.456 }
    });
    assert.equal(receipt.decision_output.decision, "REFUSE");
    assert.equal(receipt.decision_output.reason_code, ERR_SIDECAR_SATURATED);
    assert.equal(verifySignedReceipt(receipt), true);

    const enqueued = await queue.enqueue(receipt);
    assert.equal(enqueued.ok, true);
    await enqueued.durable;

    const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).decision_output.reason_code, ERR_SIDECAR_SATURATED);
    await queue.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testSocketRegistryDestroysIdleSockets() {
  const registry = new SocketRegistry({
    idle_timeout_ms: 1,
    eviction_interval_ms: 10,
    shutdown_grace_ms: 10
  });
  let destroyed = false;
  const socket = {
    setNoDelay() {},
    on() {},
    prependListener() {},
    destroy() {
      destroyed = true;
    }
  };
  registry.track(socket);
  assert.equal(registry.metrics().open, 1);
  registry.destroyIdle(performance.now() + 5);
  assert.equal(destroyed, true);
  assert.equal(registry.metrics().idle_destroyed, 1);
}

function testWatchdogDegradesOnSocketAccumulation() {
  const watchdog = new RuntimeWatchdog({
    interval_ms: 10,
    max_event_loop_lag_ms: 100,
    fatal_event_loop_lag_ms: 1000,
    max_open_sockets: 2,
    fatal_open_sockets: 10
  }, () => ({ open_sockets: 3, receipt_fail_closed: false }));
  watchdog.setDegraded("ERR_SOCKET_ACCUMULATION");
  assert.equal(watchdog.canAcceptDecisions(), false);
  assert.equal(watchdog.snapshot().degraded_reason, "ERR_SOCKET_ACCUMULATION");
}

testHttpLimitDefaultsAndEnvParsing();
testL0LimitDefaultsAndEnvParsing();
testPreParseAdmissionRefusesBeforeBodyRead();
testActiveSocketCapRefusesImmediately();
testMaxRequestsPerSocketCap();
await testSignedRefusalReceiptPersistsCompactRefusal();
testSocketRegistryDestroysIdleSockets();
testWatchdogDegradesOnSocketAccumulation();
process.stdout.write("PASS sidecar admission control tests\n");
