const BASE_REQUEST = Object.freeze({
  execution_request: {
    actor: {
      user_id: "operator"
    },
    execution: {
      auto_scale: false,
      max_retries: 0,
      max_scale_multiplier: 1,
      retry_on_fail: false
    },
    orbit_intent: {
      action: "execute",
      boundary: "production-local",
      lifecycle_state: "ARMED",
      orbit_version: "2.0",
      payload: {
        tool_calls: [
          {
            priority: 1,
            tool: "provision-gpu-job"
          }
        ]
      },
      signatures: [
        {
          alg: "ed25519.v1",
          sig: "operator-approved"
        }
      ]
    },
    release_request: {
      already_consumed: false,
      execution_id: "exec-production-allow-001",
      hold_state: "APPROVED"
    },
    request_id: "production-allow-001",
    resources: {
      gpu_count: 2,
      gpu_type: "a10g",
      hours: 4
    },
    runtime_observation: {
      actual_gpu_count: 2,
      actual_hours: 4,
      actual_total_cost_cents: 4000,
      kill_switch_active: false
    },
    submitted_region: "us-west-2",
    tool_calls: [
      {
        priority: 1,
        tool: "provision-gpu-job"
      }
    ]
  },
  pricing_data: {
    gpu_hour_cents: 500
  }
});

export const SCENARIOS = Object.freeze({
  safe: Object.freeze({
    label: "Safe sample",
    values: Object.freeze({
      userId: "operator",
      requestId: "production-allow-001",
      executionId: "exec-production-allow-001",
      region: "us-west-2",
      tool: "provision-gpu-job",
      gpuType: "a10g",
      gpuCount: 2,
      hours: 4,
      gpuHourCents: 500,
      actualGpuCount: 2,
      actualHours: 4,
      actualTotalCostCents: 4000,
      lifecycleState: "ARMED",
      holdState: "APPROVED",
      signature: "operator-approved",
      killSwitchActive: false,
      autoScale: false,
      retryOnFail: false,
      maxRetries: 0,
      maxScaleMultiplier: 1,
      alreadyConsumed: false
    })
  }),
  highCost: Object.freeze({
    label: "High-cost sample",
    values: Object.freeze({
      userId: "operator",
      requestId: "production-refuse-001",
      executionId: "exec-production-refuse-001",
      region: "us-west-2",
      tool: "provision-gpu-job",
      gpuType: "a10g",
      gpuCount: 99,
      hours: 4,
      gpuHourCents: 500,
      actualGpuCount: 99,
      actualHours: 4,
      actualTotalCostCents: 198000,
      lifecycleState: "ARMED",
      holdState: "APPROVED",
      signature: "operator-approved",
      killSwitchActive: false,
      autoScale: false,
      retryOnFail: false,
      maxRetries: 0,
      maxScaleMultiplier: 1,
      alreadyConsumed: false
    })
  })
});

export function cloneBaseRequest() {
  return JSON.parse(JSON.stringify(BASE_REQUEST));
}

export function estimateTotalCostCents(values) {
  return toSafeInteger(values.gpuCount, "GPU count") *
    toSafeInteger(values.hours, "Hours") *
    toSafeInteger(values.gpuHourCents, "GPU-hour price");
}

export function buildRequest(values) {
  const request = cloneBaseRequest();
  const executionRequest = request.execution_request;
  const toolCall = {
    priority: 1,
    tool: requiredText(values.tool, "Tool")
  };

  executionRequest.actor.user_id = requiredText(values.userId, "User ID");
  executionRequest.request_id = requiredText(values.requestId, "Request ID");
  executionRequest.submitted_region = requiredText(values.region, "Region");
  executionRequest.tool_calls = [toolCall];
  executionRequest.execution.auto_scale = Boolean(values.autoScale);
  executionRequest.execution.retry_on_fail = Boolean(values.retryOnFail);
  executionRequest.execution.max_retries = toSafeInteger(values.maxRetries, "Max retries");
  executionRequest.execution.max_scale_multiplier = toSafeInteger(values.maxScaleMultiplier, "Max scale multiplier");
  executionRequest.orbit_intent.lifecycle_state = requiredText(values.lifecycleState, "Lifecycle state");
  executionRequest.orbit_intent.payload.tool_calls = [toolCall];
  executionRequest.orbit_intent.signatures = [{
    alg: "ed25519.v1",
    sig: requiredText(values.signature, "Signature")
  }];
  executionRequest.release_request.already_consumed = Boolean(values.alreadyConsumed);
  executionRequest.release_request.execution_id = requiredText(values.executionId, "Execution ID");
  executionRequest.release_request.hold_state = requiredText(values.holdState, "Hold state");
  executionRequest.resources.gpu_count = toSafeInteger(values.gpuCount, "GPU count");
  executionRequest.resources.gpu_type = requiredText(values.gpuType, "GPU type");
  executionRequest.resources.hours = toSafeInteger(values.hours, "Hours");
  executionRequest.runtime_observation.actual_gpu_count = toSafeInteger(values.actualGpuCount, "Observed GPU count");
  executionRequest.runtime_observation.actual_hours = toSafeInteger(values.actualHours, "Observed hours");
  executionRequest.runtime_observation.actual_total_cost_cents = toSafeInteger(values.actualTotalCostCents, "Observed total cost");
  executionRequest.runtime_observation.kill_switch_active = Boolean(values.killSwitchActive);
  request.pricing_data.gpu_hour_cents = toSafeInteger(values.gpuHourCents, "GPU-hour price");

  return request;
}

export function valuesFromRequest(value) {
  const request = value?.request?.body && typeof value.request.body === "object" ? value.request.body : value;
  const executionRequest = request?.execution_request;
  if (!executionRequest) throw new Error("ERR_REQUEST_NOT_FOUND");

  return {
    userId: executionRequest.actor?.user_id ?? "",
    requestId: executionRequest.request_id ?? "",
    executionId: executionRequest.release_request?.execution_id ?? "",
    region: executionRequest.submitted_region ?? "",
    tool: executionRequest.tool_calls?.[0]?.tool ?? executionRequest.orbit_intent?.payload?.tool_calls?.[0]?.tool ?? "",
    gpuType: executionRequest.resources?.gpu_type ?? "",
    gpuCount: executionRequest.resources?.gpu_count ?? 0,
    hours: executionRequest.resources?.hours ?? 0,
    gpuHourCents: request?.pricing_data?.gpu_hour_cents ?? 0,
    actualGpuCount: executionRequest.runtime_observation?.actual_gpu_count ?? 0,
    actualHours: executionRequest.runtime_observation?.actual_hours ?? 0,
    actualTotalCostCents: executionRequest.runtime_observation?.actual_total_cost_cents ?? 0,
    lifecycleState: executionRequest.orbit_intent?.lifecycle_state ?? "",
    holdState: executionRequest.release_request?.hold_state ?? "",
    signature: executionRequest.orbit_intent?.signatures?.[0]?.sig ?? "",
    killSwitchActive: Boolean(executionRequest.runtime_observation?.kill_switch_active),
    autoScale: Boolean(executionRequest.execution?.auto_scale),
    retryOnFail: Boolean(executionRequest.execution?.retry_on_fail),
    maxRetries: executionRequest.execution?.max_retries ?? 0,
    maxScaleMultiplier: executionRequest.execution?.max_scale_multiplier ?? 1,
    alreadyConsumed: Boolean(executionRequest.release_request?.already_consumed)
  };
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`ERR_${label.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_REQUIRED`);
  return text;
}

function toSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`ERR_${label.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_INVALID`);
  }
  return number;
}
