import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createRuntimeInput, isAllowedCorsOrigin } from "../sidecar/runtime_request.mjs";
import { createAdmissionController } from "../sidecar/http_admission.mjs";
import { makeBaseInput, rawJson } from "../audit/test_helpers.ts";
import { executeDeterministicPipeline, resetRuntimeState } from "../audit/node_runtime.ts";
import { REASON_CODES } from "../shared/index.ts";

process.env.MNDE_RECEIPT_HMAC_SECRET ??= "runtime-security-test-secret-000000000001";
process.env.MNDE_RECEIPT_HMAC_KEY_ID ??= "runtime-security-test-key";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runPipeline(input) {
  resetRuntimeState();
  const result = executeDeterministicPipeline(rawJson(input));
  assert.ok(!("parse_boundary" in result));
  return result.receipt;
}

function runPipelineFailure(input) {
  resetRuntimeState();
  const result = executeDeterministicPipeline(rawJson(input));
  return "parse_boundary" in result ? result : result.receipt.decision_output;
}

function withUniqueRequest(input, id) {
  return makeBaseInput({
    ...input,
    execution_request: {
      ...input.execution_request,
      request_id: id,
      release_request: { execution_id: id, ...input.execution_request?.release_request }
    }
  });
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

function testHardcodedSecretRemoved() {
  const source = readFileSync(new URL("../ram0na/engine.ts", import.meta.url), "utf8");
  const oldSecretMarker = ["ecs", "prod", "signing", "secret", "v2"].join("-");
  const oldKeyMarker = ["ecs", "prod", "key", "v2"].join("-");
  assert.equal(source.includes(oldSecretMarker), false);
  assert.equal(source.includes(oldKeyMarker), false);
}

function testMissingSigningEnvFailsClosed() {
  const previousSecret = process.env.MNDE_RECEIPT_HMAC_SECRET;
  const previousKeyId = process.env.MNDE_RECEIPT_HMAC_KEY_ID;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.MNDE_RECEIPT_HMAC_SECRET;
    delete process.env.MNDE_RECEIPT_HMAC_KEY_ID;
    process.env.NODE_ENV = "production";
    const decision = runPipeline(
      withUniqueRequest({
        execution_request: {
          tool_calls: [{ tool: "deploy", priority: 1 }],
          orbit_intent: {
            payload: {
              tool_calls: [{ tool: "deploy", priority: 1 }]
            }
          }
        }
      }, "missing-signing-env")
    ).decision_output;
    assert.equal(decision.decision, "REFUSE");
    assert.notEqual(decision.reason_code, REASON_CODES.OkAllow);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.MNDE_RECEIPT_HMAC_SECRET;
    } else {
      process.env.MNDE_RECEIPT_HMAC_SECRET = previousSecret;
    }
    if (previousKeyId === undefined) {
      delete process.env.MNDE_RECEIPT_HMAC_KEY_ID;
    } else {
      process.env.MNDE_RECEIPT_HMAC_KEY_ID = previousKeyId;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
}

function testCorsAllowlist() {
  assert.equal(isAllowedCorsOrigin(undefined), true);
  assert.equal(isAllowedCorsOrigin("http://127.0.0.1:8080"), true);
  assert.equal(isAllowedCorsOrigin("http://localhost:8080"), true);
  assert.equal(isAllowedCorsOrigin("http://127.0.0.1:8787"), false);
  assert.equal(isAllowedCorsOrigin("https://example.test"), false);
}

function testNestedReservedFieldsRefuse() {
  const cases = [
    ["nested-timestamp", { audit: { timestamp: "2026-05-17T00:00:00Z" } }],
    ["nested-exec", { wrapper: [{ exec: "node payload.js" }] }],
    ["nested-command", { task: { command: "deploy" } }]
  ];
  for (const [name, parameters] of cases) {
    const result = runPipelineFailure(
      withUniqueRequest({
        execution_request: {
          parameters
        }
      }, `reserved-${name}`)
    );
    assert.equal(result.decision, "REFUSE", name);
    assert.equal(result.reason_code, REASON_CODES.NonDeterministicInput, name);
  }

  const protoInput = withUniqueRequest({
    execution_request: {
      parameters: { safe: {} }
    }
  }, "reserved-nested-proto");
  Object.defineProperty(protoInput.execution_request.parameters.safe, "__proto__", {
    value: "pollute",
    enumerable: true
  });
  const protoResult = runPipelineFailure(protoInput);
  assert.equal(protoResult.decision, "REFUSE", "nested-proto");
  assert.equal(protoResult.reason_code, REASON_CODES.NonDeterministicInput, "nested-proto");
}

function testDuplicateToolCallRefuses() {
  const result = runPipelineFailure(
    withUniqueRequest({
      execution_request: {
        tool_calls: [
          { tool: "deploy", priority: 1 },
          { tool: "deploy", priority: 2 }
        ],
        orbit_intent: {
          payload: {
            tool_calls: [
              { tool: "deploy", priority: 1 },
              { tool: "deploy", priority: 2 }
            ]
          }
        }
      }
    }, "duplicate-tool-call")
  );
  assert.equal(result.decision, "REFUSE");
  assert.equal(result.reason_code, REASON_CODES.SchemaValidation);
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

function testActionSmugglingRefuses() {
  const cases = [
    ["workflow", { workflow: { phases: ["compile", "deploy"] } }],
    ["steps", { plan: { steps: ["compile", "deploy"] } }],
    ["tasks", { tasks: [{ launch: "start_training_job" }] }],
    ["operations", { operations: [{ launch: "shell" }] }],
    ["pipeline", { pipeline: { launch: "delete production" } }]
  ];
  for (const [name, parameters] of cases) {
    const receipt = runPipeline(
      withUniqueRequest({
        execution_request: {
          parameters
        }
      }, `smuggle-${name}`)
    );
    assert.equal(receipt.decision_output.decision, "REFUSE", name);
    assert.equal(receipt.decision_output.reason_code, REASON_CODES.OrbitMultipleActions, name);
  }
}

function testNormalizedDangerousPatternRefuses() {
  const input = withUniqueRequest({
    execution_request: {
      parameters: {
        endpoint: "  CURL   HTTP://０x７f０００００１/latest/meta-data  ",
        note: "please  rm   -rf  temporary workspace"
      }
    }
  }, "normalized-dangerous-pattern");
  const receipt = runPipeline(input);
  assert.equal(receipt.decision_output.decision, "REFUSE");
  assert.equal(receipt.decision_output.reason_code, REASON_CODES.ForbiddenActionInParameters);
}

function testReplayDeterminismUnchanged() {
  const input = withUniqueRequest({
    execution_request: {
      tool_calls: [{ tool: "deploy", priority: 1 }],
      orbit_intent: {
        payload: {
          tool_calls: [{ tool: "deploy", priority: 1 }]
        }
      }
    }
  }, "replay-determinism-security");
  const first = runPipeline(input);
  const second = runPipeline(input);
  assert.equal(first.request_hash, second.request_hash);
  assert.equal(first.decision_output.decision_hash, second.decision_output.decision_hash);
  assert.equal(first.decision_output.decision, second.decision_output.decision);
}

function testNoUnsignedAllowDecisions() {
  const receipt = runPipeline(
    withUniqueRequest({
      execution_request: {
        tool_calls: [{ tool: "deploy", priority: 1 }],
        orbit_intent: {
          payload: {
            tool_calls: [{ tool: "deploy", priority: 1 }]
          }
        }
      }
    }, "signed-allow-check")
  );
  assert.equal(receipt.decision_output.decision, "ALLOW");
  assert.equal(typeof receipt.signature?.value, "string");
  assert.ok(receipt.signature.value.length > 0);
  assert.equal(typeof receipt.verifiable_signature?.value, "string");
  assert.ok(receipt.verifiable_signature.value.length > 0);
}

function testUnsafeToolCallParametersRefuse() {
  const cases = [
    {
      name: "metadata-url",
      parameters: { url: "http://169.254.169.254/latest/meta-data" }
    },
    {
      name: "destructive-command",
      parameters: { script: "rm -rf /tmp/workspace" }
    },
    {
      name: "mirrored-orbit-metadata-url",
      parameters: { endpoint: "curl http://2130706433/admin" }
    }
  ];

  for (const item of cases) {
    const input = makeBaseInput({
      execution_request: {
        request_id: `unsafe-tool-call-${item.name}`,
        release_request: { execution_id: `unsafe-tool-call-${item.name}` },
        tool_calls: [{ tool: "fetch", priority: 1, parameters: item.parameters }],
        orbit_intent: {
          payload: {
            tool_calls: [{ tool: "fetch", priority: 1, parameters: item.parameters }]
          }
        }
      }
    });

    resetRuntimeState();
    const result = executeDeterministicPipeline(rawJson(input));
    assert.ok(!("parse_boundary" in result));
    assert.equal(result.receipt.decision_output.decision, "REFUSE", item.name);
    assert.equal(result.receipt.decision_output.reason_code, REASON_CODES.ForbiddenActionInParameters, item.name);
  }
}

function testUnsafeOrbitPayloadToolCallParametersRefuse() {
  const input = makeBaseInput({
    execution_request: {
      request_id: "unsafe-orbit-payload-tool-call",
      release_request: { execution_id: "unsafe-orbit-payload-tool-call" },
      tool_calls: [{ tool: "fetch", priority: 1 }],
      orbit_intent: {
        payload: {
            tool_calls: [{ tool: "fetch", priority: 1, parameters: { script: "drop_database production" } }]
        }
      }
    }
  });

  resetRuntimeState();
  const result = executeDeterministicPipeline(rawJson(input));
  assert.ok(!("parse_boundary" in result));
  assert.equal(result.receipt.decision_output.decision, "REFUSE");
  assert.equal(result.receipt.decision_output.reason_code, REASON_CODES.ForbiddenActionInParameters);
}

function testLegacyToolCallsWithoutParametersAllow() {
  const input = makeBaseInput({
    execution_request: {
      request_id: "legacy-tool-call-no-parameters",
      release_request: { execution_id: "legacy-tool-call-no-parameters" },
      tool_calls: [{ tool: "deploy", priority: 1 }],
      orbit_intent: {
        payload: {
          tool_calls: [{ tool: "deploy", priority: 1 }]
        }
      }
    }
  });

  resetRuntimeState();
  const result = executeDeterministicPipeline(rawJson(input));
  assert.ok(!("parse_boundary" in result));
  assert.equal(result.receipt.decision_output.decision, "ALLOW");
  assert.equal(result.receipt.decision_output.reason_code, REASON_CODES.OkAllow);
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
testHardcodedSecretRemoved();
testMissingSigningEnvFailsClosed();
testCorsAllowlist();
testNestedReservedFieldsRefuse();
testDuplicateToolCallRefuses();
testDeepToolCallEquality();
testActionSmugglingRefuses();
testNormalizedDangerousPatternRefuses();
testUnsafeToolCallParametersRefuse();
testUnsafeOrbitPayloadToolCallParametersRefuse();
testLegacyToolCallsWithoutParametersAllow();
testOrbitIpNormalization();
testReplayDeterminismUnchanged();
testNoUnsignedAllowDecisions();
testSocketAdmissionTracksActualAcquisition();
process.stdout.write("PASS runtime security correction tests\n");
