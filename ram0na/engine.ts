import { createHmac, createHash } from "crypto";
import { performance } from "perf_hooks";
import {
  RECEIPT_PUBLIC_KEY_FINGERPRINT,
  RECEIPT_SIGNATURE_ALGORITHM,
  RECEIPT_SIGNATURE_KEY_ID,
  REASON_CODES,
  canonicalizeJson,
  signReceiptPayload,
  verifyReceiptPayloadSignature,
  type ArmTrace,
  type CanonicalExecutionInput,
  type JsonValue,
  type OrbitTrace,
  type PreflightTrace,
  type RamonaTrace,
  type SignedReceipt,
  type SignedReceiptPayload
} from "../shared/index.ts";

const SIGNING_SECRET = "ecs-prod-signing-secret-v2";
const SIGNING_KEY_ID = "ecs-prod-key-v2";
const RECEIPT_KEY_SET_VERSION = "receipt-key-set-v1";
type TimingCollector = Partial<Record<"signing_ms", number>>;

function formatUsdFromCents(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `${dollars}.${remainder.toString().padStart(2, "0")}`;
}

function signPayload(payload: SignedReceiptPayload, timings?: TimingCollector): SignedReceipt {
  const canonicalPayload = canonicalizeJson(payload as unknown as JsonValue);
  const signingStarted = performance.now();
  const hmacValue = createHmac("sha256", SIGNING_SECRET).update(canonicalPayload).digest("hex");
  const verifiableValue = signReceiptPayload(canonicalPayload);
  if (timings) {
    timings.signing_ms = Math.max(0, Math.round(performance.now() - signingStarted));
  }
  return {
    ...payload,
    signature: {
      algorithm: "HMAC-SHA256",
      key_id: SIGNING_KEY_ID,
      value: hmacValue
    },
    verifiable_signature: {
      algorithm: RECEIPT_SIGNATURE_ALGORITHM,
      key_id: RECEIPT_SIGNATURE_KEY_ID,
      public_key_fingerprint: RECEIPT_PUBLIC_KEY_FINGERPRINT,
      value: verifiableValue
    }
  };
}

export function runStrictRamona(input: CanonicalExecutionInput, arm: ArmTrace): RamonaTrace {
  const runtimeHash = createHash("sha256")
    .update(canonicalizeJson(input.execution_request.runtime_observation as unknown as JsonValue))
    .digest("hex");

  if (arm.decision === "REFUSE") {
    return {
      layer: "ramona",
      decision: "REFUSE",
      reason_code: arm.reason_code,
      runtime_hash: runtimeHash
    };
  }
  if (input.execution_request.runtime_observation.kill_switch_active) {
    return {
      layer: "ramona",
      decision: "REFUSE",
      reason_code: REASON_CODES.KillSwitch,
      runtime_hash: runtimeHash
    };
  }
  if (input.execution_request.runtime_observation.actual_gpu_count > input.execution_request.resources.gpu_count) {
    return {
      layer: "ramona",
      decision: "REFUSE",
      reason_code: REASON_CODES.RuntimeGpuDrift,
      runtime_hash: runtimeHash
    };
  }
  if (input.execution_request.runtime_observation.actual_hours > input.execution_request.resources.hours) {
    return {
      layer: "ramona",
      decision: "REFUSE",
      reason_code: REASON_CODES.RuntimeHoursDrift,
      runtime_hash: runtimeHash
    };
  }
  if (input.execution_request.runtime_observation.actual_total_cost_cents > arm.projected_total_cost_cents) {
    return {
      layer: "ramona",
      decision: "REFUSE",
      reason_code: REASON_CODES.RuntimeCostDrift,
      runtime_hash: runtimeHash
    };
  }
  return {
    layer: "ramona",
    decision: "ALLOW",
    reason_code: REASON_CODES.OkRamona,
    runtime_hash: runtimeHash
  };
}

export function buildReceipt(input: {
  canonical_request: string;
  request_hash: string;
  policy_hash: string;
  preflight: PreflightTrace;
  orbit: OrbitTrace;
  arm: ArmTrace;
  ramona: RamonaTrace;
  policy_version: string;
  timings?: TimingCollector;
}): SignedReceipt {
  const decision = input.orbit.decision === "ALLOW" && input.arm.decision === "ALLOW" && input.ramona.decision === "ALLOW" ? "ALLOW" : "REFUSE";
  const reasonCode = decision === "ALLOW" ? REASON_CODES.OkAllow : input.ramona.reason_code;
  const decisionHash = createHash("sha256")
    .update(
      canonicalizeJson({
        request_hash: input.request_hash,
        policy_hash: input.policy_hash,
        decision,
        reason_code: reasonCode,
        policy_version: input.policy_version,
        execution_id: input.arm.execution_id,
        projected_total_cost_cents: input.arm.projected_total_cost_cents,
        allowed_cost_cents: input.arm.allowed_cost_cents,
        prevented_cost_cents: input.arm.prevented_cost_cents
      } as unknown as JsonValue)
    )
    .digest("hex");

  const payload: SignedReceiptPayload = {
    schema_version: "ecs.receipt.v2",
    canonical_request: input.canonical_request,
    request_hash: input.request_hash,
    decision_output: {
      decision,
      decision_hash: decisionHash,
      request_hash: input.request_hash,
      reason_code: reasonCode,
      total_cost_usd: formatUsdFromCents(input.arm.projected_total_cost_cents),
      allowed_cost_usd: formatUsdFromCents(input.arm.allowed_cost_cents),
      prevented_cost_usd: formatUsdFromCents(input.arm.prevented_cost_cents),
      policy_version: input.policy_version,
      policy_hash: input.policy_hash,
      execution_id: input.arm.execution_id,
      key_set_version: RECEIPT_KEY_SET_VERSION
    },
    pipeline_trace: {
      preflight: input.preflight,
      orbit: input.orbit,
      arm: input.arm,
      ramona: input.ramona
    }
  };
  return signPayload(payload, input.timings);
}

export function verifyReceiptSignature(receipt: SignedReceipt): boolean {
  const { signature, verifiable_signature: _verifiableSignature, ...payload } = receipt;
  if (signature.algorithm !== "HMAC-SHA256" || signature.key_id !== SIGNING_KEY_ID) {
    return false;
  }
  const canonicalPayload = canonicalizeJson(payload as unknown as JsonValue);
  const expected = createHmac("sha256", SIGNING_SECRET).update(canonicalPayload).digest("hex");
  const hmacValid = expected === signature.value;
  if (!hmacValid) {
    return false;
  }

  if (!receipt.verifiable_signature) {
    return true;
  }

  return verifyReceiptPublicSignature(receipt);
}

export function verifyReceiptPublicSignature(receipt: SignedReceipt): boolean {
  if (!receipt.verifiable_signature) {
    return false;
  }
  const { signature: _legacySignature, verifiable_signature, ...payload } = receipt;
  if (
    verifiable_signature.algorithm !== RECEIPT_SIGNATURE_ALGORITHM ||
    verifiable_signature.key_id !== RECEIPT_SIGNATURE_KEY_ID ||
    verifiable_signature.public_key_fingerprint !== RECEIPT_PUBLIC_KEY_FINGERPRINT
  ) {
    return false;
  }

  const canonicalPayload = canonicalizeJson(payload as unknown as JsonValue);
  return verifyReceiptPayloadSignature(canonicalPayload, verifiable_signature.value);
}

export function verifyReceiptReplay(receipt: SignedReceipt, rerunReceipt: SignedReceipt): { ok: boolean; reason_code: string } {
  if (!verifyReceiptSignature(receipt) || !verifyReceiptSignature(rerunReceipt)) {
    return { ok: false, reason_code: REASON_CODES.ReceiptSignatureInvalid };
  }
  const stored = canonicalizeJson(receipt as unknown as JsonValue);
  const rerun = canonicalizeJson(rerunReceipt as unknown as JsonValue);
  return stored === rerun
    ? { ok: true, reason_code: REASON_CODES.OkAllow }
    : { ok: false, reason_code: REASON_CODES.ReplayMismatch };
}
