import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

export const options = {
  scenarios: {
    sustained_mixed_execution_gate: {
      executor: "ramping-vus",
      stages: [
        { duration: "30s", target: 50 },
        { duration: "3m", target: 100 },
        { duration: "2m", target: 200 },
        { duration: "30s", target: 400 },
        { duration: "30s", target: 0 }
      ],
      gracefulRampDown: "10s"
    }
  },
  thresholds: {
    http_req_failed: ["rate<0.001"],
    http_req_duration: ["p(95)<25", "p(99)<50"],
    checks: ["rate>0.999"],
    mnde_unexpected_allows: ["count==0"],
    mnde_unsigned_allows: ["count==0"],
    mnde_multi_action_bypass: ["count==0"],
    mnde_http_500s: ["count==0"]
  }
};

const URL = "http://127.0.0.1:8787/v1/decisions";
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 400 }));

export const mnde_allow_responses = new Counter("mnde_allow_responses");
export const mnde_refuse_responses = new Counter("mnde_refuse_responses");
export const mnde_unexpected_allows = new Counter("mnde_unexpected_allows");
export const mnde_unexpected_refuses = new Counter("mnde_unexpected_refuses");
export const mnde_unsigned_allows = new Counter("mnde_unsigned_allows");
export const mnde_multi_action_bypass = new Counter("mnde_multi_action_bypass");
export const mnde_http_500s = new Counter("mnde_http_500s");

function baseRequest(id) {
  return {
    execution_request: {
      request_id: id,
      submitted_region: "us-west-2",
      actor: {
        user_id: "k6-heavy-operator"
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

function requestClass(iteration) {
  const id = `k6-heavy-${__VU}-${iteration}`;
  const valid = baseRequest(`${id}-valid`);

  const multi = baseRequest(`${id}-multi`);
  multi.execution_request.tool_calls = [
    { tool: "compile", priority: 1 },
    { tool: "deploy_irreversible", priority: 2 }
  ];
  multi.execution_request.orbit_intent.payload.tool_calls = multi.execution_request.tool_calls;

  const highCost = baseRequest(`${id}-high-cost`);
  highCost.execution_request.resources.gpu_count = 99;
  highCost.execution_request.runtime_observation.actual_gpu_count = 99;
  highCost.execution_request.runtime_observation.actual_total_cost_cents = 198000;

  const selected = iteration % 4;
  if (selected === 0) {
    return {
      name: "valid_single_irreversible",
      payload: valid,
      expectAllow: true,
      expectReason: null,
      allowHttp400: false
    };
  }
  if (selected === 1) {
    return {
      name: "multi_action",
      payload: multi,
      expectAllow: false,
      expectReason: "ERR_ORBIT_MULTIPLE_ACTIONS",
      allowHttp400: false
    };
  }
  if (selected === 2) {
    return {
      name: "high_cost",
      payload: highCost,
      expectAllow: false,
      expectReason: null,
      allowHttp400: false
    };
  }
  return {
    name: "malformed_json",
    rawBody: `{"execution_request":{"request_id":"${id}-malformed"`,
    expectAllow: false,
    expectReason: null,
    allowHttp400: true
  };
}

function parseJson(response) {
  try {
    return response.json();
  } catch (_) {
    return {};
  }
}

function receiptDecision(body) {
  return body && body.receipt && body.receipt.decision_output;
}

function keySetVersion(body) {
  const decision = receiptDecision(body);
  return decision && decision.key_set_version;
}

function hasSignature(body) {
  const receipt = body && body.receipt;
  return Boolean(
    receipt &&
      ((receipt.signature && receipt.signature.value) ||
        (receipt.verifiable_signature && receipt.verifiable_signature.value))
  );
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export default function () {
  const item = requestClass(__ITER);
  const response = http.post(URL, item.rawBody || JSON.stringify(item.payload), {
    headers: {
      "content-type": "application/json"
    },
    tags: {
      request_class: item.name
    }
  });
  const body = parseJson(response);
  const statusOk = response.status === 200 || (item.allowHttp400 && response.status === 400);
  const decision = body.decision;
  const isAllow = decision === "ALLOW";
  const isRefuse = decision === "REFUSE";
  const expectedDecision = item.expectAllow ? "ALLOW" : "REFUSE";
  const requestHash = body.request_hash;
  const decisionHash = body.decision_hash;
  const policyHash = body.policy_hash;
  const keySet = keySetVersion(body);

  if (response.status === 500) {
    mnde_http_500s.add(1);
  }
  if (isAllow) {
    mnde_allow_responses.add(1);
  }
  if (isRefuse) {
    mnde_refuse_responses.add(1);
  }
  if (isAllow && !item.expectAllow) {
    mnde_unexpected_allows.add(1);
  }
  if (isRefuse && item.expectAllow) {
    mnde_unexpected_refuses.add(1);
  }
  if (isAllow && (!hasSignature(body) || !nonEmptyString(keySet))) {
    mnde_unsigned_allows.add(1);
  }
  if (item.name === "multi_action" && (isAllow || body.reason_code !== "ERR_ORBIT_MULTIPLE_ACTIONS")) {
    mnde_multi_action_bypass.add(1);
  }

  check(response, {
    "HTTP status is 200 or expected 400": () => statusOk,
    "no HTTP 500": () => response.status !== 500,
    "decision exists for valid MNDe responses": () => response.status === 400 || nonEmptyString(decision),
    "request_hash exists": () => response.status === 400 || nonEmptyString(requestHash),
    "decision_hash exists": () => response.status === 400 || nonEmptyString(decisionHash),
    "policy_hash exists": () => response.status === 400 || nonEmptyString(policyHash),
    "key_set_version exists": () => {
      if (response.status === 400) {
        return true;
      }
      if (isRefuse && !body.receipt) {
        return true;
      }
      return nonEmptyString(keySet);
    },
    "ALLOW only appears on valid single-action requests": () => !isAllow || item.expectAllow,
    "multi-action always refuses with ERR_ORBIT_MULTIPLE_ACTIONS": () =>
      item.name !== "multi_action" || (isRefuse && body.reason_code === "ERR_ORBIT_MULTIPLE_ACTIONS"),
    "no unsigned ALLOW": () => !isAllow || (hasSignature(body) && nonEmptyString(keySet)),
    "no empty decision_hash": () => response.status === 400 || nonEmptyString(decisionHash),
    "no empty request_hash": () => response.status === 400 || nonEmptyString(requestHash),
    "expected decision": () => response.status === 400 || decision === expectedDecision
  });
}

function metricValue(data, name, valueName, fallback = 0) {
  const metric = data.metrics[name];
  if (!metric || !metric.values || metric.values[valueName] === undefined) {
    return fallback;
  }
  return metric.values[valueName];
}

function counter(data, name) {
  return metricValue(data, name, "count", 0);
}

export function handleSummary(data) {
  const total = counter(data, "http_reqs");
  const allowCount = counter(data, "mnde_allow_responses");
  const refuseCount = counter(data, "mnde_refuse_responses");
  const p95 = metricValue(data, "http_req_duration", "p(95)", 0);
  const p99 = metricValue(data, "http_req_duration", "p(99)", 0);
  const errorRate = metricValue(data, "http_req_failed", "rate", 0);
  const failures = {
    unexpected_allows: counter(data, "mnde_unexpected_allows"),
    unexpected_refuses: counter(data, "mnde_unexpected_refuses"),
    unsigned_allows: counter(data, "mnde_unsigned_allows"),
    multi_action_bypass: counter(data, "mnde_multi_action_bypass"),
    http_500s: counter(data, "mnde_http_500s")
  };
  const pass =
    errorRate < 0.001 &&
    p95 < 25 &&
    p99 < 50 &&
    failures.unexpected_allows === 0 &&
    failures.unsigned_allows === 0 &&
    failures.multi_action_bypass === 0 &&
    failures.http_500s === 0;

  const lines = [
    "",
    `MNDe k6 heavy proof: ${pass ? "PASS" : "FAIL"}`,
    `total_requests=${total}`,
    `allow_count=${allowCount}`,
    `refuse_count=${refuseCount}`,
    `p95_ms=${p95}`,
    `p99_ms=${p99}`,
    `error_rate=${errorRate}`,
    `mnde_unexpected_allows=${failures.unexpected_allows}`,
    `mnde_unexpected_refuses=${failures.unexpected_refuses}`,
    `mnde_unsigned_allows=${failures.unsigned_allows}`,
    `mnde_multi_action_bypass=${failures.multi_action_bypass}`,
    `mnde_http_500s=${failures.http_500s}`,
    ""
  ];

  return {
    stdout: `${lines.join("\n")}\n`
  };
}
