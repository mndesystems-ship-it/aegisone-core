import assert from "node:assert/strict";
import { buildRequest, estimateTotalCostCents, SCENARIOS, valuesFromRequest } from "../request-builder.js";

const safe = buildRequest(SCENARIOS.safe.values);
assert.equal(safe.execution_request.resources.gpu_count, 2);
assert.equal(safe.execution_request.resources.hours, 4);
assert.equal(safe.execution_request.resources.gpu_type, "a10g");
assert.equal(safe.pricing_data.gpu_hour_cents, 500);
assert.equal(safe.execution_request.runtime_observation.actual_total_cost_cents, 4000);
assert.equal(safe.execution_request.tool_calls[0].tool, "provision-gpu-job");
assert.equal(safe.execution_request.orbit_intent.payload.tool_calls[0].tool, "provision-gpu-job");
assert.equal(safe.execution_request.orbit_intent.signatures[0].sig, "operator-approved");

const highCost = buildRequest(SCENARIOS.highCost.values);
assert.equal(highCost.execution_request.resources.gpu_count, 99);
assert.equal(highCost.execution_request.runtime_observation.actual_gpu_count, 99);
assert.equal(highCost.execution_request.runtime_observation.actual_total_cost_cents, 198000);
assert.equal(highCost.execution_request.request_id, "production-refuse-001");

const custom = buildRequest({
  ...SCENARIOS.safe.values,
  userId: "reviewer",
  requestId: "request-123",
  executionId: "exec-123",
  region: "us-east-1",
  tool: "custom-tool",
  gpuType: "h100",
  gpuCount: 3,
  hours: 5,
  gpuHourCents: 700,
  actualGpuCount: 4,
  actualHours: 6,
  actualTotalCostCents: 16800,
  lifecycleState: "ARMED",
  holdState: "APPROVED",
  signature: "signed-by-reviewer",
  killSwitchActive: true,
  autoScale: true,
  retryOnFail: true,
  maxRetries: 2,
  maxScaleMultiplier: 3,
  alreadyConsumed: true
});
assert.deepEqual(valuesFromRequest(custom), {
  userId: "reviewer",
  requestId: "request-123",
  executionId: "exec-123",
  region: "us-east-1",
  tool: "custom-tool",
  gpuType: "h100",
  gpuCount: 3,
  hours: 5,
  gpuHourCents: 700,
  actualGpuCount: 4,
  actualHours: 6,
  actualTotalCostCents: 16800,
  lifecycleState: "ARMED",
  holdState: "APPROVED",
  signature: "signed-by-reviewer",
  killSwitchActive: true,
  autoScale: true,
  retryOnFail: true,
  maxRetries: 2,
  maxScaleMultiplier: 3,
  alreadyConsumed: true
});
assert.equal(estimateTotalCostCents({ gpuCount: 3, hours: 5, gpuHourCents: 700 }), 10500);
assert.throws(() => buildRequest({ ...SCENARIOS.safe.values, gpuCount: 1.5 }), /ERR_GPU_COUNT_INVALID/);

console.log("no-code request builder tests passed");
