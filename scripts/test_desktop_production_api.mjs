const baseUrl = process.env.MNDE_SIDECAR_URL ?? "http://127.0.0.1:8787";
const failures = [];

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return await response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return await response.json();
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`FAIL ${name}`);
  }
}

const safeRequest = {
  execution_request: {
    request_id: "prod-safe-1",
    submitted_region: "us-west-2",
    actor: { user_id: "verify-user" },
    resources: { gpu_type: "a10g", gpu_count: 1, hours: 1 },
    execution: { auto_scale: false, max_scale_multiplier: 1, retry_on_fail: false, max_retries: 0 },
    tool_calls: [{ tool: "compile", priority: 1 }],
    orbit_intent: {
      orbit_version: "2.0",
      action: "execute",
      boundary: "gpu-batch",
      payload: { tool_calls: [{ tool: "compile", priority: 1 }] },
      lifecycle_state: "ARMED",
      signatures: [{ alg: "hmac-sha256", sig: "orbit-signature-v1" }]
    },
    release_request: { execution_id: "exec-prod-safe-1", hold_state: "APPROVED", already_consumed: false },
    runtime_observation: { kill_switch_active: false, actual_gpu_count: 1, actual_hours: 1, actual_total_cost_cents: 500 }
  },
  policy_document: {
    schema_version: "ecs.policy.v1",
    policy_version: "policy.v1",
    rules: {
      max_total_cost_cents: 500000,
      allow_auto_scale: true,
      max_gpu_count: 32,
      max_hours: 72,
      require_manual_approval_above_cents: 250000,
      max_retry_count: 5
    }
  },
  pricing_data: { gpu_hour_cents: 500 }
};

const refusalRequest = structuredClone(safeRequest);
refusalRequest.execution_request.request_id = "prod-refuse-1";
refusalRequest.execution_request.resources.gpu_count = 64;
refusalRequest.execution_request.runtime_observation.actual_gpu_count = 64;

await check("/v1/decisions returns deterministic signed allow", async () => {
  const first = await postJson("/v1/decisions", safeRequest);
  const secondRequest = structuredClone(safeRequest);
  secondRequest.execution_request.request_id = "prod-safe-2";
  secondRequest.execution_request.release_request.execution_id = "exec-prod-safe-2";
  const second = await postJson("/v1/decisions", secondRequest);
  if (first.decision !== "ALLOW" || second.decision !== "ALLOW") throw new Error(`expected two signed ALLOW decisions, got ${first.decision}/${second.decision}`);
  if (!first.request_hash || !first.decision_hash || !second.request_hash || !second.decision_hash) throw new Error("decision hashes missing");
  if (!first.receipt?.verifiable_signature?.value || !second.receipt?.verifiable_signature?.value) throw new Error("receipt signature missing");
});

await check("/v1/decisions refuses unsafe request fail-closed", async () => {
  const result = await postJson("/v1/decisions", refusalRequest);
  if (result.decision !== "REFUSE") throw new Error(`expected REFUSE, got ${result.decision}`);
  if (!result.request_hash || !result.decision_hash) throw new Error("refusal hashes missing");
});

await check("/identity reports repo-local sidecar", async () => {
  const identity = await getJson("/identity");
  if (!identity.repo_root || !identity.process_id) throw new Error("identity missing repo_root/process_id");
});

if (failures.length > 0) {
  console.log("VERDICT: FAIL");
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}

console.log("VERDICT: PASS");
