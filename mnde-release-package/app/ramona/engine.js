import { createHmac, createHash } from "crypto";
import { RECEIPT_PUBLIC_KEY_FINGERPRINT, RECEIPT_SIGNATURE_ALGORITHM, RECEIPT_SIGNATURE_KEY_ID, REASON_CODES, canonicalizeJson, signReceiptPayload, verifyReceiptPayloadSignature } from "../shared/index.js";
const SIGNING_SECRET = "ecs-prod-signing-secret-v2";
const SIGNING_KEY_ID = "ecs-prod-key-v2";
function formatUsdFromCents(cents) {
    const dollars = Math.floor(cents / 100);
    const remainder = cents % 100;
    return `${dollars}.${remainder.toString().padStart(2, "0")}`;
}
function signPayload(payload) {
    const canonicalPayload = canonicalizeJson(payload);
    return {
        ...payload,
        signature: {
            algorithm: "HMAC-SHA256",
            key_id: SIGNING_KEY_ID,
            value: createHmac("sha256", SIGNING_SECRET).update(canonicalPayload).digest("hex")
        },
        verifiable_signature: {
            algorithm: RECEIPT_SIGNATURE_ALGORITHM,
            key_id: RECEIPT_SIGNATURE_KEY_ID,
            public_key_fingerprint: RECEIPT_PUBLIC_KEY_FINGERPRINT,
            value: signReceiptPayload(canonicalPayload)
        }
    };
}
export function runStrictRamona(input, arm) {
    const runtimeHash = createHash("sha256").update(canonicalizeJson(input.execution_request.runtime_observation)).digest("hex");
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
export function buildReceipt(input) {
    const decision = input.orbit.decision === "ALLOW" && input.arm.decision === "ALLOW" && input.ramona.decision === "ALLOW" ? "ALLOW" : "REFUSE";
    const reasonCode = decision === "ALLOW" ? REASON_CODES.OkAllow : input.ramona.reason_code;
    const keySetVersion = input.policy_key_set_version ?? input.policy_document?.trust?.key_version ?? "ed25519.v1";
    const manifestRef = input.manifest_ref ?? `policy-proof:${input.policy_hash}`;
    const translationVersion = "mnde.reason_translation.v1";
    const decisionHash = createHash("sha256").update(canonicalizeJson({
        request_hash: input.request_hash,
        policy_hash: input.policy_hash,
        key_set_version: keySetVersion,
        manifest_ref: manifestRef,
        translation_version: translationVersion,
        decision,
        reason_code: reasonCode,
        policy_version: input.policy_version,
        execution_id: input.arm.execution_id,
        projected_total_cost_cents: input.arm.projected_total_cost_cents,
        allowed_cost_cents: input.arm.allowed_cost_cents,
        prevented_cost_cents: input.arm.prevented_cost_cents
    })).digest("hex");
    const payload = {
        schema_version: "ecs.receipt.v2",
        canonical_request: input.canonical_request,
        request_hash: input.request_hash,
        policy_hash: input.policy_hash,
        key_set_version: keySetVersion,
        manifest_ref: manifestRef,
        translation_version: translationVersion,
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
            execution_id: input.arm.execution_id
        },
        pipeline_trace: {
            preflight: input.preflight,
            orbit: input.orbit,
            arm: input.arm,
            ramona: input.ramona
        }
    };
    return signPayload(payload);
}
export function verifyReceiptSignature(receipt) {
    const { signature, verifiable_signature: _verifiableSignature, ...payload } = receipt;
    if (signature.algorithm !== "HMAC-SHA256" || signature.key_id !== SIGNING_KEY_ID) {
        return false;
    }
    const canonicalPayload = canonicalizeJson(payload);
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
export function verifyReceiptPublicSignature(receipt) {
    if (!receipt.verifiable_signature) {
        return false;
    }
    const { signature: _legacySignature, verifiable_signature, ...payload } = receipt;
    if (verifiable_signature.algorithm !== RECEIPT_SIGNATURE_ALGORITHM || verifiable_signature.key_id !== RECEIPT_SIGNATURE_KEY_ID || verifiable_signature.public_key_fingerprint !== RECEIPT_PUBLIC_KEY_FINGERPRINT) {
        return false;
    }
    const canonicalPayload = canonicalizeJson(payload);
    return verifyReceiptPayloadSignature(canonicalPayload, verifiable_signature.value);
}
export function verifyReceiptReplay(receipt, rerunReceipt) {
    if (!verifyReceiptSignature(receipt) || !verifyReceiptSignature(rerunReceipt)) {
        return {
            ok: false,
            reason_code: REASON_CODES.ReceiptSignatureInvalid
        };
    }
    const stored = canonicalizeJson(receipt);
    const rerun = canonicalizeJson(rerunReceipt);
    return stored === rerun ? {
        ok: true,
        reason_code: REASON_CODES.OkAllow
    } : {
        ok: false,
        reason_code: REASON_CODES.ReplayMismatch
    };
}
