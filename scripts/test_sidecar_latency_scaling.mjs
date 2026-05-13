import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ReceiptPersistenceQueue,
  SystemSaturationController,
  validateReceiptPersistenceConfig
} from "../sidecar/receipt_persistence_queue.mjs";
import {
  DeterministicWorkerPool,
  WORKER_POOL_SATURATED,
  WORKER_TIMEOUT
} from "../sidecar/deterministic_worker_pool.mjs";
import { executeDeterministicPipeline, makeBaseInput, resetRuntimeState } from "../audit/node_runtime.ts";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "mnde-sidecar-queue-"));
}

function receipt(id, bytes = 64) {
  return {
    schema_version: "ecs.receipt.v2",
    request_hash: `request-${id}`,
    canonical_request: JSON.stringify({ id, pad: "x".repeat(bytes) }),
    decision_output: {
      decision: "ALLOW",
      decision_hash: `decision-${id}`,
      request_hash: `request-${id}`,
      reason_code: "OK_ALLOW",
      total_cost_usd: "1.00",
      allowed_cost_usd: "1.00",
      prevented_cost_usd: "0.00",
      policy_version: "policy.v1",
      policy_hash: "policy-hash",
      execution_id: `execution-${id}`,
      key_set_version: "receipt-key-set-v1"
    },
    pipeline_trace: {
      preflight: { layer: "preflight", request_hash: `request-${id}`, policy_hash: "policy-hash", policy_version: "policy.v1" },
      orbit: { layer: "orbit", decision: "ALLOW", reason_code: "OK_ORBIT", validation_hash: "orbit" },
      arm: {
        layer: "arm",
        decision: "ALLOW",
        reason_code: "OK_ARM",
        projected_total_cost_cents: 100,
        allowed_cost_cents: 100,
        prevented_cost_cents: 0,
        execution_id: `execution-${id}`
      },
      ramona: { layer: "ramona", decision: "ALLOW", reason_code: "OK_RAM0NA", runtime_hash: "runtime" }
    },
    signature: { algorithm: "HMAC-SHA256", key_id: "test", value: "sig" }
  };
}

async function testThroughputModeAcceptsBeforeDurableFlushAndPreservesOrder() {
  const root = tempRoot();
  try {
    const file = path.join(root, "receipts.jsonl");
    const queue = new ReceiptPersistenceQueue({
      path: file,
      durability_mode: "throughput",
      max_items: 10,
      max_bytes: 100_000,
      max_batch_size: 3,
      max_batch_age_ms: 60_000
    });
    await queue.start();

    const first = await queue.enqueue(receipt("a"));
    const second = await queue.enqueue(receipt("b"));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(statSync(file).size, 0);

    const third = await queue.enqueue(receipt("c"));
    assert.equal(third.ok, true);
    await third.durable;

    const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /"request_hash":"request-a"/);
    assert.match(lines[1], /"request_hash":"request-b"/);
    assert.match(lines[2], /"request_hash":"request-c"/);
    await queue.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testStrictModeWaitsForDurableFlush() {
  const root = tempRoot();
  try {
    const file = path.join(root, "receipts.jsonl");
    const queue = new ReceiptPersistenceQueue({
      path: file,
      durability_mode: "strict_audit",
      max_items: 10,
      max_bytes: 100_000,
      max_batch_size: 10,
      max_batch_age_ms: 1
    });
    await queue.start();

    const accepted = await queue.enqueue(receipt("strict"));
    assert.equal(accepted.ok, true);
    await accepted.durable;
    assert.match(readFileSync(file, "utf8"), /"request_hash":"request-strict"/);
    await queue.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testQueueSaturationRefusesDeterministically() {
  const root = tempRoot();
  try {
    const file = path.join(root, "receipts.jsonl");
    const queue = new ReceiptPersistenceQueue({
      path: file,
      durability_mode: "throughput",
      max_items: 10,
      max_bytes: 1500,
      max_batch_size: 10,
      max_batch_age_ms: 60_000
    });
    await queue.start();

    assert.equal((await queue.enqueue(receipt("one"))).ok, true);
    const saturated = await queue.enqueue(receipt("two"));
    assert.deepEqual(saturated, {
      ok: false,
      reason_code: "ERR_RECEIPT_QUEUE_SATURATED"
    });
    await queue.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testStartupValidationRejectsUnsafeConfig() {
  assert.throws(
    () => validateReceiptPersistenceConfig({
      path: "",
      durability_mode: "throughput",
      max_items: 1,
      max_bytes: 1024,
      max_batch_size: 1,
      max_batch_age_ms: 10
    }),
    /ERR_RECEIPT_PERSISTENCE_CONFIG/
  );
  assert.throws(
    () => validateReceiptPersistenceConfig({
      path: "receipts.jsonl",
      durability_mode: "throughput",
      max_items: 1,
      max_bytes: 100,
      max_batch_size: 2,
      max_batch_age_ms: 10
    }),
    /ERR_RECEIPT_PERSISTENCE_CONFIG/
  );
}

function testPipelineStageTimingsDoNotChangeReceiptDeterminism() {
  const raw = JSON.stringify(makeBaseInput());
  const timings = {};
  resetRuntimeState();
  const first = executeDeterministicPipeline(raw, { timings });
  resetRuntimeState();
  const second = executeDeterministicPipeline(raw);
  assert.equal("parse_boundary" in first, false);
  assert.equal("parse_boundary" in second, false);
  assert.deepEqual(first.receipt, second.receipt);
  for (const key of ["preflight_ms", "orbit_ms", "arm_ms", "ramona_ms", "canonicalize_ms", "receipt_build_ms", "signing_ms"]) {
    assert.equal(typeof timings[key], "number", key);
    assert.ok(timings[key] >= 0, key);
  }
}

function testSystemSaturationControllerRefusesBeforeCollapse() {
  const controller = new SystemSaturationController({
    max_inflight: 4,
    inflight_shed_threshold: 3,
    max_event_loop_lag_ms: 50,
    queue_high_watermark_items: 10,
    queue_high_watermark_bytes: 10_000
  });
  assert.equal(controller.shouldRefuse({ inflight: 2, event_loop_lag_ms: 0, queue_depth: 0, queue_bytes: 0 }).ok, true);
  assert.deepEqual(
    controller.shouldRefuse({ inflight: 3, event_loop_lag_ms: 0, queue_depth: 0, queue_bytes: 0 }),
    { ok: false, reason_code: "ERR_SYSTEM_SATURATED", saturation_signal: "inflight" }
  );
  assert.deepEqual(
    controller.shouldRefuse({ inflight: 1, event_loop_lag_ms: 60, queue_depth: 0, queue_bytes: 0 }),
    { ok: false, reason_code: "ERR_SYSTEM_SATURATED", saturation_signal: "event_loop_lag" }
  );
  assert.deepEqual(
    controller.shouldRefuse({ inflight: 1, event_loop_lag_ms: 0, queue_depth: 11, queue_bytes: 0 }),
    { ok: false, reason_code: "ERR_SYSTEM_SATURATED", saturation_signal: "receipt_queue_depth" }
  );
}

async function testWorkerPoolRefusesWhenBoundedQueueIsFull() {
  const pool = new DeterministicWorkerPool({
    worker_count: 1,
    max_queue_depth: 1,
    worker_url: new URL("../sidecar/deterministic_worker.mjs", import.meta.url)
  });
  const raw = JSON.stringify(makeBaseInput());
  const first = pool.submit(raw);
  const second = pool.submit(raw);
  const third = pool.submit(raw);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(third, { ok: false, reason_code: WORKER_POOL_SATURATED });
  await first.result;
  await second.result;
  assert.equal(pool.metrics().refused, 1);
  await pool.shutdown();
}

async function testWorkerPoolPreservesDeterministicPipelineOutput() {
  const pool = new DeterministicWorkerPool({
    worker_count: 2,
    max_queue_depth: 4,
    worker_url: new URL("../sidecar/deterministic_worker.mjs", import.meta.url)
  });
  const raw = JSON.stringify(makeBaseInput());
  resetRuntimeState();
  const direct = executeDeterministicPipeline(raw);
  const submitted = pool.submit(raw);
  assert.equal(submitted.ok, true);
  const worker = await submitted.result;
  assert.equal(worker.ok, true);
  assert.equal("parse_boundary" in direct, false);
  assert.deepEqual(worker.result.receipt, direct.receipt);
  assert.equal(typeof worker.timings.preflight_ms, "number");
  assert.equal(typeof pool.metrics().busy_ratio, "number");
  await pool.shutdown();
}

async function testWorkerPoolTimesOutAndReplacesHungWorker() {
  const pool = new DeterministicWorkerPool({
    worker_count: 1,
    max_queue_depth: 1,
    task_timeout_ms: 1,
    worker_url: new URL("../sidecar/deterministic_worker.mjs", import.meta.url)
  });
  const submitted = pool.submit(JSON.stringify(makeBaseInput()));
  assert.equal(submitted.ok, true);
  const result = await submitted.result;
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, WORKER_TIMEOUT);
  const metrics = pool.metrics();
  assert.equal(metrics.timeout_count, 1);
  assert.equal(metrics.restart_count >= 1, true);
  await pool.shutdown();
}

await testThroughputModeAcceptsBeforeDurableFlushAndPreservesOrder();
await testStrictModeWaitsForDurableFlush();
await testQueueSaturationRefusesDeterministically();
testStartupValidationRejectsUnsafeConfig();
testPipelineStageTimingsDoNotChangeReceiptDeterminism();
testSystemSaturationControllerRefusesBeforeCollapse();
await testWorkerPoolRefusesWhenBoundedQueueIsFull();
await testWorkerPoolPreservesDeterministicPipelineOutput();
await testWorkerPoolTimesOutAndReplacesHungWorker();
process.stdout.write("PASS sidecar latency scaling tests\n");
