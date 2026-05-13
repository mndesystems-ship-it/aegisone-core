import assert from "node:assert/strict";

import {
  ACTIONS,
  POLICY,
  evaluateRequest,
  generateWorkload,
  runAdversarialExpansion,
  runAdversarialValidation,
  runControlRun,
  runDeterminismCheck,
  runExternalVerifier,
  runReplayCheck,
  runSidecarFailureTest,
  runSoakTest
} from "./mnde_execution_gate_scenario.mjs";
import { REASON_CODES } from "../shared/index.ts";

function testRejectsUnknownDuplicateTimestampAndNonIntegerInputs() {
  const unknown = JSON.stringify({
    action: "start_training_job",
    cost_usd_micro: 10_000_000,
    max_runtime_seconds: 3600,
    retry_count: 0,
    resource_limits: { gpu_count: 2, max_scale_multiplier: 1 },
    policy_id: POLICY.policy_id,
    surprise: true
  });
  assert.equal(evaluateRequest(unknown).receipt.decision_output.reason_code, REASON_CODES.SchemaValidation);

  const duplicate = `{"action":"start_training_job","action":"scale_gpu_cluster","cost_usd_micro":10000000,"max_runtime_seconds":3600,"retry_count":0,"resource_limits":{"gpu_count":2,"max_scale_multiplier":1},"policy_id":"${POLICY.policy_id}"}`;
  assert.equal(evaluateRequest(duplicate).receipt.decision_output.reason_code, REASON_CODES.DuplicateJsonKeys);

  const timestamp = JSON.stringify({
    action: "start_training_job",
    cost_usd_micro: 10_000_000,
    max_runtime_seconds: 3600,
    retry_count: 0,
    resource_limits: { gpu_count: 2, max_scale_multiplier: 1 },
    policy_id: POLICY.policy_id,
    timestamp: "2026-05-02T00:00:00Z"
  });
  assert.equal(evaluateRequest(timestamp).receipt.decision_output.reason_code, REASON_CODES.NonDeterministicInput);

  const decimalCost = `{"action":"start_training_job","cost_usd_micro":10000000.5,"max_runtime_seconds":3600,"retry_count":0,"resource_limits":{"gpu_count":2,"max_scale_multiplier":1},"policy_id":"${POLICY.policy_id}"}`;
  assert.equal(evaluateRequest(decimalCost).receipt.decision_output.reason_code, REASON_CODES.InvalidJsonNumber);
}

function testPolicyRefusalsUseFixedReasonCodes() {
  const overCost = JSON.stringify({
    action: "start_training_job",
    cost_usd_micro: POLICY.max_cost_usd_micro + 1,
    max_runtime_seconds: 3600,
    retry_count: 0,
    resource_limits: { gpu_count: 2, max_scale_multiplier: 1 },
    policy_id: POLICY.policy_id
  });
  assert.equal(evaluateRequest(overCost).receipt.decision_output.reason_code, REASON_CODES.CostLimit);

  const retry = JSON.stringify({
    action: "retry_failed_job",
    cost_usd_micro: 20_000_000,
    max_runtime_seconds: 3600,
    retry_count: POLICY.max_retry_count + 1,
    resource_limits: { gpu_count: 2, max_scale_multiplier: 1 },
    policy_id: POLICY.policy_id
  });
  assert.equal(evaluateRequest(retry).receipt.decision_output.reason_code, REASON_CODES.RetryLimit);

  const autoscale = JSON.stringify({
    action: "scale_gpu_cluster",
    cost_usd_micro: 20_000_000,
    max_runtime_seconds: 3600,
    retry_count: 0,
    resource_limits: { gpu_count: 2, max_scale_multiplier: POLICY.max_scale_multiplier + 1 },
    policy_id: POLICY.policy_id
  });
  assert.equal(evaluateRequest(autoscale).receipt.decision_output.reason_code, REASON_CODES.AutoScaleDenied);
}

function testDeterminismReplayAndAdversarialFailureDetection() {
  const request = JSON.stringify({
    action: ACTIONS.start_training_job.name,
    cost_usd_micro: 80_000_000,
    max_runtime_seconds: 3600,
    retry_count: 0,
    resource_limits: { gpu_count: 4, max_scale_multiplier: 1 },
    policy_id: POLICY.policy_id
  });

  const determinism = runDeterminismCheck(request, 100);
  assert.equal(determinism.drift_mismatches, 0);

  const receipts = Array.from({ length: 100 }, (_, index) =>
    evaluateRequest(
      JSON.stringify({
        action: ACTIONS.extend_runtime.name,
        cost_usd_micro: 10_000_000 + index,
        max_runtime_seconds: 1800,
        retry_count: 0,
        resource_limits: { gpu_count: 1, max_scale_multiplier: 1 },
        policy_id: POLICY.policy_id
      })
    ).receipt
  );
  const replay = runReplayCheck(receipts);
  assert.equal(replay.replay_mismatches, 0);

  const adversarial = runAdversarialValidation(receipts[0]);
  assert.equal(adversarial.detection_rate_percent, 100);
  assert.equal(adversarial.fail_closed_count, adversarial.total);
}

function testControlRunSidecarVerifierSoakAndAdversarialExpansion() {
  const workload = generateWorkload(200);
  const control = runControlRun(workload);
  assert.equal(control.total_requests, 200);
  assert.ok(control.total_cost_executed_without_mnde > 0);
  assert.ok(control.failure_events_triggered > 0);
  assert.ok(control.runaway_events_triggered > 0);

  const receipts = workload.slice(0, 100).map((item) => evaluateRequest(item.raw).receipt);
  const verifier = runExternalVerifier(receipts);
  assert.equal(verifier.independent_replay_mismatches, 0);
  assert.equal(verifier.verified_receipts, receipts.length);

  const sidecar = runSidecarFailureTest(workload.slice(0, 50));
  assert.equal(sidecar.fail_closed_rate_percent, 100);
  assert.equal(sidecar.unintended_execution_count, 0);

  const soak = runSoakTest(1_000, 25);
  assert.equal(soak.total_requests, 1_000);
  assert.equal(soak.drift_mismatches, 0);
  assert.equal(soak.replay_mismatches, 0);
  assert.equal(soak.error_rate_percent, 0);
  assert.equal(soak.latency_stability, "stable");
  assert.equal(soak.memory_stability, "stable");

  const expansion = runAdversarialExpansion();
  assert.equal(expansion.identical_hashes, true);
  assert.equal(expansion.bypass_count, 0);
}

function testOrbitMultipleActionRefusals() {
  const base = JSON.parse(JSON.stringify({
    action: "deploy_irreversible",
    cost_usd_micro: 10_000_000,
    max_runtime_seconds: 3600,
    retry_count: 0,
    resource_limits: { gpu_count: 2, max_scale_multiplier: 1 },
    policy_id: POLICY.policy_id
  }));

  const cases = [
    JSON.stringify({ ...base, tool_calls: [{ tool: "compile" }, { tool: "deploy_irreversible" }] }),
    JSON.stringify({ ...base, actions: ["compile", "deploy_irreversible"] }),
    JSON.stringify({ ...base, metadata: { action: "deploy_irreversible" } }),
    `{"action":"deploy_irreversible","cost_usd_micro":10000000,"max_runtime_seconds":3600,"retry_count":0,"resource_limits":{"gpu_count":2,"max_scale_multiplier":1},"policy_id":"${POLICY.policy_id}","metadata":{"encoded":"\\u0061ction:deploy_irreversible"}}`
  ];

  for (const raw of cases) {
    const out = evaluateRequest(raw).receipt.decision_output;
    assert.equal(out.decision, "REFUSE");
    assert.equal(out.reason_code, REASON_CODES.OrbitMultipleActions);
  }
}

testRejectsUnknownDuplicateTimestampAndNonIntegerInputs();
testPolicyRefusalsUseFixedReasonCodes();
testDeterminismReplayAndAdversarialFailureDetection();
testControlRunSidecarVerifierSoakAndAdversarialExpansion();
testOrbitMultipleActionRefusals();
process.stdout.write("PASS MNDe execution gate scenario tests\n");
