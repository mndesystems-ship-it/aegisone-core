import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

export const options = {
  vus: 1,
  iterations: 40,
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<50", "p(99)<100"],
    checks: ["rate>0.99"]
  }
};

const URL = "http://127.0.0.1:8787/v1/decisions";
const allowResponses = new Counter("mnde_allow_responses");
const refuseResponses = new Counter("mnde_refuse_responses");
const unsignedAllows = new Counter("mnde_unsigned_allows");

function baseRequest(id) {
  return {
    execution_request: {
      request_id: id,
      submitted_region: "us-west-2",
      actor: {
        user_id: "k6-operator"
      },
      resources: {
        gpu_type: "a10g",
        gpu_count: 2,
        hours: 4
      },
      execution: {
        auto_scale: false,
        max_scale_multiplier: 1,
        retry_on_fail: false,
        max_retries: 0
      },
      tool_calls: [
        {
          tool: "deploy_irreversible",
          priority: 1
        }
      ],
      orbit_intent: {
        orbit_version: "2.0",
        action: "execute",
        boundary: "production-local",
        payload: {
          tool_calls: [
            {
              tool: "deploy_irreversible",
              priority: 1
            }
          ]
        },
        lifecycle_state: "ARMED",
        signatures: [
          {
            alg: "ed25519.v1",
            sig: "operator-approved"
          }
        ]
      },
      release_request: {
        execution_id: `exec-${id}`,
        hold_state: "APPROVED",
        already_consumed: false
      },
      runtime_observation: {
        kill_switch_active: false,
        actual_gpu_count: 2,
        actual_hours: 4,
        actual_total_cost_cents: 4000
      }
    },
    pricing_data: {
      gpu_hour_cents: 500
    }
  };
}

function cases(iteration) {
  const suffix = `${__VU}-${iteration}`;
  const valid = baseRequest(`k6-valid-${suffix}`);

  const multi = baseRequest(`k6-multi-${suffix}`);
  multi.execution_request.tool_calls = [
    { tool: "compile", priority: 1 },
    { tool: "deploy_irreversible", priority: 2 }
  ];
  multi.execution_request.orbit_intent.payload.tool_calls = multi.execution_request.tool_calls;

  const highCost = baseRequest(`k6-high-cost-${suffix}`);
  highCost.execution_request.resources.gpu_count = 99;
  highCost.execution_request.runtime_observation.actual_gpu_count = 99;
  highCost.execution_request.runtime_observation.actual_total_cost_cents = 198000;

  const missingRequired = baseRequest(`k6-missing-${suffix}`);
  delete missingRequired.execution_request.resources;

  return [
    {
      name: "valid single irreversible action",
      payload: valid,
      expect: (body, status) => status === 200 && body.decision === "ALLOW"
    },
    {
      name: "multi-action request",
      payload: multi,
      expect: (body, status) =>
        status === 200 &&
        body.decision === "REFUSE" &&
        body.reason_code === "ERR_ORBIT_MULTIPLE_ACTIONS"
    },
    {
      name: "high-cost request",
      payload: highCost,
      expect: (body, status) => status === 200 && body.decision === "REFUSE"
    },
    {
      name: "missing required field",
      payload: missingRequired,
      expect: (body, status) => status === 400 || body.decision === "REFUSE"
    }
  ];
}

function parseBody(response) {
  try {
    return response.json();
  } catch (_) {
    return {};
  }
}

function hasSignedReceipt(body) {
  const receipt = body && body.receipt;
  const legacy = receipt && receipt.signature && receipt.signature.value;
  const publicSig = receipt && receipt.verifiable_signature && receipt.verifiable_signature.value;
  return Boolean(legacy || publicSig);
}

function keySetVersion(body) {
  return (
    body &&
    body.receipt &&
    body.receipt.decision_output &&
    body.receipt.decision_output.key_set_version
  );
}

export default function () {
  const item = cases(__ITER)[__ITER % 4];
  const response = http.post(URL, JSON.stringify(item.payload), {
    headers: {
      "content-type": "application/json"
    },
    tags: {
      case: item.name
    }
  });
  const body = parseBody(response);
  const isAllow = body.decision === "ALLOW";
  const isRefuse = body.decision === "REFUSE";
  const isMalformedCase = item.name === "missing required field";

  if (isAllow) {
    allowResponses.add(1);
  }
  if (isRefuse) {
    refuseResponses.add(1);
  }
  if (isAllow && (!hasSignedReceipt(body) || !keySetVersion(body))) {
    unsignedAllows.add(1);
  }

  check(response, {
    "HTTP status is not 500": (r) => r.status !== 500,
    "case expectation met": (r) => item.expect(body, r.status),
    "decision exists": () => typeof body.decision === "string",
    "request_hash exists": () => isMalformedCase || typeof body.request_hash === "string",
    "decision_hash exists": () => isMalformedCase || typeof body.decision_hash === "string",
    "policy_hash exists": () => isMalformedCase || typeof body.policy_hash === "string",
    "key_set_version exists": () => isMalformedCase || typeof keySetVersion(body) === "string",
    "no unsigned ALLOW": () => !isAllow || (hasSignedReceipt(body) && typeof keySetVersion(body) === "string")
  });
}
