import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { performance } from "perf_hooks";
import {
  canonicalizeJson,
  hashCanonicalJson,
  REASON_CODES,
  type CanonicalExecutionInput,
  type JsonValue,
  type ExecutionResult,
  type SignedReceipt,
  type TypedFailure
} from "../shared/index.ts";
import { runStrictPreflight } from "../preflight/engine.ts";
import { runStrictOrbit } from "../orbit/engine.ts";
import { commitArmAllow, defineBudgetToken, resetArmStores, runStrictArm } from "../arm/engine.ts";
import { buildReceipt, runStrictRamona, verifyReceiptReplay, verifyReceiptSignature } from "../ramona/engine.ts";
import type { AdversarialCaseResult } from "./types.ts";

export type PipelineTimingKey =
  | "preflight_ms"
  | "orbit_ms"
  | "arm_ms"
  | "ramona_ms"
  | "canonicalize_ms"
  | "receipt_build_ms"
  | "signing_ms";

export type PipelineTimings = Partial<Record<PipelineTimingKey, number>>;
type PipelineOptions = { timings?: PipelineTimings };

function measure<T>(timings: PipelineTimings | undefined, key: PipelineTimingKey, fn: () => T): T {
  const started = performance.now();
  try {
    return fn();
  } finally {
    if (timings) {
      timings[key] = Math.max(0, Math.round(performance.now() - started));
    }
  }
}

function typedFailureFromReceipt(receipt: SignedReceipt): TypedFailure {
  return {
    decision: "REFUSE",
    request_hash: receipt.request_hash,
    decision_hash: receipt.decision_output.decision_hash,
    reason_code: receipt.decision_output.reason_code,
    parse_boundary: true
  };
}

export function executeDeterministicPipeline(rawInput: string, options: PipelineOptions = {}): ExecutionResult | TypedFailure {
  const timings = options.timings;
  const preflight = measure(timings, "preflight_ms", () => runStrictPreflight(rawInput));
  if ("parse_boundary" in preflight) {
    return preflight;
  }

  const preflightTrace = {
    layer: "preflight" as const,
    request_hash: preflight.request_hash,
    policy_hash: preflight.policy_hash,
    policy_version: preflight.parsed_input.policy_document.policy_version
  };
  const orbit = measure(timings, "orbit_ms", () => runStrictOrbit(preflight.parsed_input));
  const arm = measure(timings, "arm_ms", () => runStrictArm(preflight.parsed_input, orbit, preflight.request_hash));
  const ramona = measure(timings, "ramona_ms", () => runStrictRamona(preflight.parsed_input, arm));
  const receipt = measure(timings, "receipt_build_ms", () => buildReceipt({
    canonical_request: preflight.canonical_input,
    request_hash: preflight.request_hash,
    policy_hash: preflight.policy_hash,
    preflight: preflightTrace,
    orbit,
    arm,
    ramona,
    policy_version: preflight.parsed_input.policy_document.policy_version,
    timings
  }));

  if (receipt.decision_output.decision === "ALLOW") {
    commitArmAllow(arm.execution_id, preflight.request_hash, receipt.decision_output.decision_hash);
  }

  return {
    receipt,
    receipt_bytes: measure(timings, "canonicalize_ms", () => canonicalizeJson(receipt as unknown as JsonValue))
  };
}

export function verifySignedReceipt(receipt: SignedReceipt): boolean {
  return verifyReceiptSignature(receipt);
}

export function appendReceipts(outputPath: string, receipts: SignedReceipt[]): void {
  const lines = receipts.map((receipt) => canonicalizeJson(receipt as unknown as JsonValue));
  writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

export function replayReceiptStore(receiptPath: string): {
  total: number;
  exact_matches: number;
  mismatches: Array<Record<string, string>>;
} {
  const source = readFileSync(receiptPath, "utf8").trim();
  const lines = source.length === 0 ? [] : source.split(/\r?\n/);
  const mismatches: Array<Record<string, string>> = [];
  let exactMatches = 0;

  for (const line of lines) {
    let parsed: SignedReceipt;
    try {
      parsed = JSON.parse(line) as SignedReceipt;
    } catch {
      mismatches.push({ request_hash: "unparseable_receipt", error: REASON_CODES.InvalidJsonSyntax });
      continue;
    }
    if (!verifySignedReceipt(parsed)) {
      mismatches.push({ request_hash: parsed.request_hash, error: REASON_CODES.ReceiptSignatureInvalid });
      continue;
    }

    resetRuntimeState();
    const rerun = executeDeterministicPipeline(parsed.canonical_request);
    if ("parse_boundary" in rerun) {
      mismatches.push({ request_hash: parsed.request_hash, error: rerun.reason_code });
      continue;
    }

    const replay = verifyReceiptReplay(parsed, rerun.receipt);
    if (!replay.ok) {
      mismatches.push({ request_hash: parsed.request_hash, error: replay.reason_code });
      continue;
    }
    exactMatches += 1;
  }

  return {
    total: lines.length,
    exact_matches: exactMatches,
    mismatches
  };
}

export function writeJsonArtifact(path: string, value: JsonValue): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function hashFileArtifact(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

export function resetRuntimeState(): void {
  resetArmStores();
}

export function seedBudgetToken(token: string, maxBudgetCents: number): void {
  defineBudgetToken(token, maxBudgetCents);
}

export function decisionHashForRawInput(rawInput: string): string {
  return hashCanonicalJson(JSON.parse(rawInput) as JsonValue);
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
