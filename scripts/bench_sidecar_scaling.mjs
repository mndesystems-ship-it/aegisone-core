import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const OUT_DIR = join(process.cwd(), "sidecar-scaling-output");
const SIDECAR_URL = process.env.MNDE_SIDECAR_URL ?? "http://127.0.0.1:8787";
const DECISIONS_URL = `${SIDECAR_URL}/v1/decisions`;
const READY_URL = `${SIDECAR_URL}/readyz`;
const VERIFY_URL = `${SIDECAR_URL}/verify`;
const REPLAY_URL = `${SIDECAR_URL}/replay`;
const MODE = process.argv[2] ?? "sustained";
const OVERRIDE_WORKERS = process.env.MNDE_BENCH_WORKERS ? Number.parseInt(process.env.MNDE_BENCH_WORKERS, 10) : null;
const OVERRIDE_DURATION_MS = process.env.MNDE_BENCH_DURATION_MS ? Number.parseInt(process.env.MNDE_BENCH_DURATION_MS, 10) : null;
const PROFILES = {
  sustained: { workers: 300, duration_ms: 60_000 },
  burst: { workers: 900, duration_ms: 20_000 },
  overload: { workers: 1600, duration_ms: 15_000 },
  replay: { workers: 100, duration_ms: 10_000 },
  parity: { workers: 100, duration_ms: 10_000 }
};

function baseRequest(id) {
  return {
    execution_request: {
      request_id: id,
      submitted_region: "us-west-2",
      actor: { user_id: "sidecar-bench" },
      resources: { gpu_type: "a10g", gpu_count: 2, hours: 4 },
      execution: { auto_scale: false, max_scale_multiplier: 1, retry_on_fail: false, max_retries: 0 },
      tool_calls: [{ tool: "compile", priority: 1 }, { tool: "verify", priority: 2 }],
      orbit_intent: {
        orbit_version: "2.0",
        action: "execute",
        boundary: "gpu-batch",
        payload: { tool_calls: [{ tool: "compile", priority: 1 }, { tool: "verify", priority: 2 }] },
        lifecycle_state: "ARMED",
        signatures: [{ alg: "hmac-sha256", sig: "orbit-signature-v1" }]
      },
      release_request: { execution_id: id, hold_state: "APPROVED", already_consumed: false },
      runtime_observation: { kill_switch_active: false, actual_gpu_count: 2, actual_hours: 4, actual_total_cost_cents: 4000 }
    },
    pricing_data: { gpu_hour_cents: 500 }
  };
}

function requestFor(index) {
  const slot = index % 100;
  const body = baseRequest(`bench-${MODE}-${index}`);
  if (slot >= 50 && slot < 70) {
    body.execution_request.resources.gpu_count = 4;
    body.execution_request.resources.hours = 8;
    body.execution_request.runtime_observation.actual_gpu_count = 4;
    body.execution_request.runtime_observation.actual_hours = 8;
  }
  if (slot >= 70 && slot < 85) {
    body.execution_request.resources.gpu_count = "bad";
  }
  if (slot >= 85) {
    body.execution_request.parameters = { nested: { action: "deploy_irreversible" } };
  }
  return JSON.stringify(body);
}

function percentile(values, pct) {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(3));
}

async function postJson(url, value) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  });
  return response.json();
}

async function runProfile(profile) {
  const deadline = performance.now() + profile.duration_ms;
  const latencies = [];
  const receipts = [];
  const counters = {
    total: 0,
    http_errors: 0,
    unexpected_allows: 0,
    unsigned_allows: 0,
    queue_saturated: 0,
    replay_mismatches: 0,
    signature_failures: 0
  };
  let next = 0;

  async function worker() {
    while (performance.now() < deadline) {
      const index = next;
      next += 1;
      const started = performance.now();
      try {
        const response = await fetch(DECISIONS_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestFor(index)
        });
        const body = await response.json();
        latencies.push(performance.now() - started);
        counters.total += 1;
        if (!response.ok) counters.http_errors += 1;
        if (body.reason_code === "ERR_RECEIPT_QUEUE_SATURATED") counters.queue_saturated += 1;
        if (body.decision === "ALLOW" && !body.receipt?.signature && !body.receipt?.verifiable_signature) counters.unsigned_allows += 1;
        if (body.receipt) receipts.push(body.receipt);
      } catch {
        latencies.push(performance.now() - started);
        counters.http_errors += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: profile.workers }, () => worker()));

  const replaySample = receipts.slice(0, 1000);
  for (const receipt of replaySample) {
    const verified = await postJson(VERIFY_URL, { receipt });
    if (!verified.receipt_signature_valid) counters.signature_failures += 1;
    const replay = await postJson(REPLAY_URL, { receipt });
    if (replay.drift) counters.replay_mismatches += 1;
  }

  const ready = await fetch(READY_URL).then((res) => res.json());
  return {
    mode: MODE,
    sidecar_url: DECISIONS_URL,
    profile,
    workload_hash: createHash("sha256").update(JSON.stringify(profile)).digest("hex"),
    ...counters,
    receipts_sampled_for_replay: replaySample.length,
    p50_ms: percentile(latencies, 50),
    p90_ms: percentile(latencies, 90),
    p95_ms: percentile(latencies, 95),
    p99_ms: percentile(latencies, 99),
    p999_ms: percentile(latencies, 99.9),
    max_ms: Number(Math.max(0, ...latencies).toFixed(3)),
    requests_per_second: Number((counters.total / (profile.duration_ms / 1000)).toFixed(2)),
    readyz: ready,
    verdict: counters.http_errors === 0 && counters.unsigned_allows === 0 && counters.replay_mismatches === 0 && counters.signature_failures === 0
      ? "PASS"
      : "FAIL"
  };
}

if (!PROFILES[MODE]) {
  throw new Error(`Unknown mode ${MODE}; expected ${Object.keys(PROFILES).join(", ")}`);
}

mkdirSync(OUT_DIR, { recursive: true });
const selectedProfile = {
  ...PROFILES[MODE],
  ...(OVERRIDE_WORKERS ? { workers: OVERRIDE_WORKERS } : {}),
  ...(OVERRIDE_DURATION_MS ? { duration_ms: OVERRIDE_DURATION_MS } : {})
};
const report = await runProfile(selectedProfile);
writeFileSync(join(OUT_DIR, `${MODE}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  join(OUT_DIR, `${MODE}-report.md`),
  `# MNDe Sidecar ${MODE} Benchmark\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
