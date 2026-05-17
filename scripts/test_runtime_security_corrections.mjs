import assert from "node:assert/strict";

import { createRuntimeInput, isAllowedCorsOrigin } from "../sidecar/runtime_request.mjs";
import { createAdmissionController } from "../sidecar/http_admission.mjs";
import { makeBaseInput, rawJson } from "../audit/test_helpers.ts";
import { executeDeterministicPipeline, resetRuntimeState } from "../audit/node_runtime.ts";
import { REASON_CODES } from "../shared/index.ts";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function testPolicyDocumentIsServerAuthoritative() {
  const serverPolicy = makeBaseInput().policy_document;
  const callerPolicy = {
    ...serverPolicy,
    policy_version: "policy.attacker",
    rules: {
      ...serverPolicy.rules,
      max_total_cost_cents: 999999999
    }
  };
  const request = makeBaseInput({
    execution_request: {
      request_id: "policy-injection-attempt",
      release_request: { execution_id: "policy-injection-attempt" }
    },
    policy_document: callerPolicy
  });
  const before = clone(request);
  const runtimeInput = createRuntimeInput(request, serverPolicy);

  assert.deepEqual(request, before, "sanitization must not mutate caller request");
  assert.deepEqual(runtimeInput.policy_document, serverPolicy);
  assert.notEqual(runtimeInput.policy_document.policy_version, callerPolicy.policy_version);
}

function testCorsAllowlist() {
  assert.equal(isAllowedCorsOrigin(undefined), true);
  assert.equal(isAllowedCorsOrigin("http://127.0.0.1:8080"), true);
  assert.equal(isAllowedCorsOrigin("http://localhost:8080"), true);
  assert.equal(isAllowedCorsOrigin("http://127.0.0.1:8787"), false);
  assert.equal(isAllowedCorsOrigin("https://example.test"), false);
}

function testDeepToolCallEquality() {
  const input = makeBaseInput({
    execution_request: {
      request_id: "deep-tool-call-equality",
      release_request: { execution_id: "deep-tool-call-equality" },
      tool_calls: [{ tool: "deploy", priority: 1, parameters: { target: "prod", flags: ["safe"] } }],
      orbit_intent: {
        payload: {
          tool_calls: [{ tool: "deploy", priority: 1, parameters: { target: "prod", flags: ["unsafe"] } }]
        }
      }
    }
  });

  resetRuntimeState();
  const result = executeDeterministicPipeline(rawJson(input));
  assert.ok(!("parse_boundary" in result));
  assert.equal(result.receipt.decision_output.decision, "REFUSE");
  assert.equal(result.receipt.decision_output.reason_code, REASON_CODES.ToolCallSequence);
}

function testOrbitIpNormalization() {
  const equivalents = ["0x7f000001", "2130706433", "::ffff:127.0.0.1", "0xa9fea9fe", "2852039166"];
  for (const value of equivalents) {
    const input = makeBaseInput({
      execution_request: {
        request_id: `orbit-normalize-${value}`,
        release_request: { execution_id: `orbit-normalize-${value}` },
        parameters: { endpoint: `curl   http://${value}/latest/meta-data` }
      }
    });
    resetRuntimeState();
    const result = executeDeterministicPipeline(rawJson(input));
    assert.ok(!("parse_boundary" in result));
    assert.equal(result.receipt.decision_output.decision, "REFUSE", value);
    assert.equal(result.receipt.decision_output.reason_code, REASON_CODES.ForbiddenActionInParameters, value);
  }
}

function testSocketAdmissionTracksActualAcquisition() {
  const admission = createAdmissionController({ max_active_requests: 10, max_active_sockets: 1 });
  const first = admission.tryAcquireSocket({});
  const second = admission.tryAcquireSocket({});
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(admission.snapshot().active_sockets, 1);
  first.release();
  assert.equal(admission.snapshot().active_sockets, 0);
}

testPolicyDocumentIsServerAuthoritative();
testCorsAllowlist();
testDeepToolCallEquality();
testOrbitIpNormalization();
testSocketAdmissionTracksActualAcquisition();
process.stdout.write("PASS runtime security correction tests\n");
