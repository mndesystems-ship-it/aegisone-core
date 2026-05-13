import { evaluateReleaseControl } from "../arm/index.ts";
import { validateOrbitIntent } from "../orbit/index.ts";
import { verifyPolicyTrust } from "../policy/index.ts";
import { runPreflight } from "../preflight/index.ts";
import { evaluateRuntimeRefusal } from "../ramona/index.ts";
import { hashCanonicalJson } from "../shared/index.ts";
import type { DecisionObject } from "../shared/types.ts";

export type PipelineResult = {
  request_object: import("../shared/types.ts").RequestObject;
  policy_object: import("../shared/types.ts").PolicyObject;
  decision_object: DecisionObject;
  orbit_result: ReturnType<typeof validateOrbitIntent>;
  policy_trust_result: ReturnType<typeof verifyPolicyTrust>;
  arm_result: ReturnType<typeof evaluateReleaseControl>;
  ramona_result?: ReturnType<typeof evaluateRuntimeRefusal>;
};

function buildDecisionObject(input: Omit<DecisionObject, "decision_hash">): DecisionObject {
  const decisionHash = hashCanonicalJson({
    schema_version: input.schema_version,
    decision: input.decision,
    reasons: input.reasons,
    request_hash: input.request_hash,
    policy_hash: input.policy_hash,
    validation_hash: input.validation_hash,
    projected_total_cost_usd: input.projected_total_cost_usd,
    allowed_cost_usd: input.allowed_cost_usd,
    prevented_cost_usd: input.prevented_cost_usd,
    policy_version: input.policy_version,
    release_hash: input.release_hash ?? null,
    runtime_hash: input.runtime_hash ?? null
  });

  return {
    ...input,
    decision_hash: decisionHash
  };
}

export function runMndePipeline(rawInput: string, pinnedPolicyVersion = "policy.v1"): PipelineResult {
  const preflightResult = runPreflight(rawInput);
  const orbitResult = validateOrbitIntent(preflightResult.request_object.orbit_intent);
  const policyTrustResult = verifyPolicyTrust(
    preflightResult.policy_object,
    preflightResult.request_object,
    pinnedPolicyVersion
  );

  preflightResult.request_object.runtime_request.observed_policy_hash = policyTrustResult.policy_hash;

  const armResult = evaluateReleaseControl(
    preflightResult.request_object,
    orbitResult,
    policyTrustResult,
    preflightResult.policy_object.rules
  );

  if (orbitResult.decision !== "PASS" || !policyTrustResult.trusted || armResult.decision !== "ALLOW") {
    const upstreamDecision =
      orbitResult.decision !== "PASS" || !policyTrustResult.trusted
        ? "REFUSE"
        : armResult.decision;

    return {
      request_object: preflightResult.request_object,
      policy_object: preflightResult.policy_object,
      orbit_result: orbitResult,
      policy_trust_result: policyTrustResult,
      arm_result: armResult,
      decision_object: buildDecisionObject({
        schema_version: "mnde.decision.v1",
        decision: upstreamDecision,
        reasons: [
          ...(orbitResult.decision === "PASS" ? [] : [`orbit.reason=${orbitResult.reason}`]),
          ...policyTrustResult.reasons,
          ...armResult.reasons
        ],
        request_hash: preflightResult.request_hash,
        policy_hash: policyTrustResult.policy_hash,
        validation_hash: orbitResult.validation_hash,
        projected_total_cost_usd: armResult.projected_total_cost_usd,
        allowed_cost_usd: armResult.allowed_cost_usd,
        prevented_cost_usd: armResult.prevented_cost_usd,
        policy_version: policyTrustResult.policy_version,
        release_hash: armResult.release_hash
      })
    };
  }

  const ramonaResult = evaluateRuntimeRefusal(
    preflightResult.request_object,
    preflightResult.request_hash,
    policyTrustResult.policy_hash,
    armResult.projected_total_cost_usd,
    preflightResult.policy_object.rules.max_total_cost_usd
  );

  return {
    request_object: preflightResult.request_object,
    policy_object: preflightResult.policy_object,
    orbit_result: orbitResult,
    policy_trust_result: policyTrustResult,
    arm_result: armResult,
    ramona_result: ramonaResult,
    decision_object: buildDecisionObject({
      schema_version: "mnde.decision.v1",
      decision: ramonaResult.decision,
      reasons: ramonaResult.reasons,
      request_hash: preflightResult.request_hash,
      policy_hash: policyTrustResult.policy_hash,
      validation_hash: orbitResult.validation_hash,
      projected_total_cost_usd: armResult.projected_total_cost_usd,
      allowed_cost_usd: armResult.allowed_cost_usd,
      prevented_cost_usd: armResult.prevented_cost_usd,
      policy_version: policyTrustResult.policy_version,
      release_hash: armResult.release_hash,
      runtime_hash: ramonaResult.runtime_hash
    })
  };
}

if (process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href === import.meta.url) {
  process.stdout.write(
    JSON.stringify(
      {
        pipeline: "mnde-core",
        entry: "runMndePipeline(rawInput, pinnedPolicyVersion)"
      },
      null,
      2
    )
  );
}
