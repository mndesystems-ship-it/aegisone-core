import { mkdirSync, writeFileSync } from "fs";

import {
  type CanonicalExecutionInput,
  type JsonValue,
  type SignedReceipt,
  canonicalizeJson
} from "../shared/index.ts";
import { runStrictPreflight } from "../preflight/engine.ts";
import { runStrictOrbit } from "../orbit/engine.ts";
import { commitArmAllow, runStrictArm } from "../arm/engine.ts";
import { buildReceipt, runStrictRamona } from "../ram0na/engine.ts";
import { executeDeterministicPipeline, resetRuntimeState } from "./node_runtime.ts";
import type { AdversarialCaseResult } from "./types.ts";

export function writeJsonArtifact(path: string, value: JsonValue): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function makeBaseInput(overrides?: Partial<CanonicalExecutionInput>): CanonicalExecutionInput {
  const base: CanonicalExecutionInput = {
    execution_request: {
      request_id: "req-allow-001",
      submitted_region: "us-west-2",
      actor: {
        user_id: "user-001"
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
        { tool: "compile", priority: 1 },
        { tool: "verify", priority: 2 }
      ],
      orbit_intent: {
        orbit_version: "2.0",
        action: "execute",
        boundary: "gpu-batch",
        payload: {
          tool_calls: [
            { tool: "compile", priority: 1 },
            { tool: "verify", priority: 2 }
          ]
        },
        lifecycle_state: "ARMED",
        signatures: [
          { alg: "hmac-sha256", sig: "orbit-signature-v1" }
        ]
      },
      release_request: {
        execution_id: "exec-001",
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
    pricing_data: {
      gpu_hour_cents: 500
    }
  };

  if (!overrides) {
    return base;
  }

  return {
    ...base,
    ...overrides,
    execution_request: {
      ...base.execution_request,
      ...overrides.execution_request,
      actor: {
        ...base.execution_request.actor,
        ...overrides.execution_request?.actor
      },
      resources: {
        ...base.execution_request.resources,
        ...overrides.execution_request?.resources
      },
      execution: {
        ...base.execution_request.execution,
        ...overrides.execution_request?.execution
      },
      tool_calls: overrides.execution_request?.tool_calls ?? base.execution_request.tool_calls,
      ...(overrides.execution_request?.parameters === undefined
        ? base.execution_request.parameters === undefined
          ? {}
          : { parameters: base.execution_request.parameters }
        : { parameters: overrides.execution_request.parameters }),
      orbit_intent: {
        ...base.execution_request.orbit_intent,
        ...overrides.execution_request?.orbit_intent,
        payload: {
          ...base.execution_request.orbit_intent.payload,
          ...overrides.execution_request?.orbit_intent?.payload
        },
        signatures: overrides.execution_request?.orbit_intent?.signatures ?? base.execution_request.orbit_intent.signatures
      },
      release_request: {
        ...base.execution_request.release_request,
        ...overrides.execution_request?.release_request
      },
      runtime_observation: {
        ...base.execution_request.runtime_observation,
        ...overrides.execution_request?.runtime_observation
      },
      ...(overrides.execution_request?.budget_token === undefined
        ? base.execution_request.budget_token === undefined
          ? {}
          : { budget_token: base.execution_request.budget_token }
        : { budget_token: overrides.execution_request.budget_token })
    },
    policy_document: {
      ...base.policy_document,
      ...overrides.policy_document,
      ...(overrides.policy_document?.trust === undefined
        ? base.policy_document.trust === undefined
          ? {}
          : { trust: base.policy_document.trust }
        : { trust: overrides.policy_document.trust }),
      rules: {
        ...base.policy_document.rules,
        ...overrides.policy_document?.rules
      }
    },
    pricing_data: {
      ...base.pricing_data,
      ...overrides.pricing_data
    }
  };
}

export function rawJson(value: JsonValue): string {
  return JSON.stringify(value);
}

export function writeRustParityVectors(path: string, vectors: Array<{ case_id: string; raw_input: string }>): void {
  writeFileSync(path, `${JSON.stringify(vectors, null, 2)}\n`, "utf8");
}

export function buildAdversarialCaseResult(
  caseId: string,
  expectation: string,
  observed: JsonValue,
  pass: boolean
): AdversarialCaseResult {
  return {
    case_id: caseId,
    expectation,
    observed,
    status: pass ? "PASS" : "FAIL"
  };
}

export function appendReceipts(outputPath: string, receipts: SignedReceipt[]): void {
  const lines = receipts.map((receipt) => canonicalizeJson(receipt as unknown as JsonValue));
  writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

export function simulateConcurrentDuplicate(rawInput: string): {
  first: { decision: "ALLOW" | "REFUSE"; reason_code: string };
  second: { decision: "ALLOW" | "REFUSE"; reason_code: string };
} {
  resetRuntimeState();
  const preflight = runStrictPreflight(rawInput);
  if ("parse_boundary" in preflight) {
    return {
      first: { decision: preflight.decision, reason_code: preflight.reason_code },
      second: { decision: preflight.decision, reason_code: preflight.reason_code }
    };
  }
  const preflightTrace = {
    layer: "preflight" as const,
    request_hash: preflight.request_hash,
    policy_hash: preflight.policy_hash,
    policy_version: preflight.parsed_input.policy_document.policy_version
  };
  const orbit = runStrictOrbit(preflight.parsed_input);
  const arm = runStrictArm(preflight.parsed_input, orbit, preflight.request_hash);
  const second = executeDeterministicPipeline(rawInput);
  const secondOutcome =
    "parse_boundary" in second
      ? { decision: second.decision, reason_code: second.reason_code }
      : { decision: second.receipt.decision_output.decision, reason_code: second.receipt.decision_output.reason_code };
  const ramona = runStrictRamona(preflight.parsed_input, arm);
  const receipt = buildReceipt({
    canonical_request: preflight.canonical_input,
    request_hash: preflight.request_hash,
    policy_hash: preflight.policy_hash,
    preflight: preflightTrace,
    orbit,
    arm,
    ramona,
    policy_version: preflight.parsed_input.policy_document.policy_version
  });
  if (receipt.decision_output.decision === "ALLOW") {
    commitArmAllow(arm.execution_id, preflight.request_hash, receipt.decision_output.decision_hash);
  }
  return {
    first: { decision: receipt.decision_output.decision, reason_code: receipt.decision_output.reason_code },
    second: secondOutcome
  };
}
