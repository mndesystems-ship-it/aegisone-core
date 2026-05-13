import { verifyReceiptPublicSignature, verifyReceiptSignature } from "../ramona/engine.js";
import { canonicalHash, decisionHashFromReceipt, requestHashFromCanonicalRequest, usdStringToMicroUsd } from "./format.js";
import { resolveHistoricalPolicy } from "./policy.js";
import { replayReceipt } from "./replay.js";
import { reasonContextFromReceipt, translateReason } from "./reasons.js";
import { validateReceiptShape } from "./schema.js";

function costProjection(decisionOutput) {
    return {
        total_cost_micro_usd: usdStringToMicroUsd(decisionOutput.total_cost_usd),
        allowed_cost_micro_usd: usdStringToMicroUsd(decisionOutput.allowed_cost_usd),
        prevented_cost_micro_usd: usdStringToMicroUsd(decisionOutput.prevented_cost_usd)
    };
}

function failedVerification(receipt, receiptHash, reasonCode, message) {
    return {
        schema_version: "mnde.receipt_verification.v1",
        status: "FAILED",
        reason_code: reasonCode,
        error: message,
        receipt_hash: receiptHash,
        request_hash: receipt?.request_hash ?? null,
        decision_hash: receipt?.decision_output?.decision_hash ?? null,
        decision: receipt?.decision_output?.decision ?? null,
        decision_reason_code: receipt?.decision_output?.reason_code ?? null,
        receipt_signature_valid: false,
        public_signature_valid: false,
        historical_policy_found: false,
        policy_signature_valid: false,
        replay_valid: false,
        decision_hash_matches: false,
        cost_fields_match: false,
        human_reason: receipt?.decision_output?.reason_code ? translateReason(receipt.decision_output.reason_code, reasonContextFromReceipt(receipt)) : null
    };
}

export function verifyReceipt(input, policyStoreArg = undefined) {
    const receipt = input?.receipt && (input?.policy_store || input?.policyStore) ? input.receipt : input;
    const policyStore = input?.receipt && (input?.policy_store || input?.policyStore) ? (input.policy_store ?? input.policyStore) : policyStoreArg;
    const receiptHash = receipt && typeof receipt === "object" ? canonicalHash(receipt) : null;
    try {
        validateReceiptShape(receipt);
    } catch (error) {
        return failedVerification(receipt, receiptHash, "ERR_SCHEMA_VALIDATION", error.message);
    }
    try {
        if (requestHashFromCanonicalRequest(receipt.canonical_request) !== receipt.request_hash) {
            return failedVerification(receipt, receiptHash, "ERR_REQUEST_HASH_MISMATCH", "request_hash_mismatch");
        }
        if (decisionHashFromReceipt(receipt) !== receipt.decision_output.decision_hash) {
            return failedVerification(receipt, receiptHash, "ERR_DECISION_HASH_MISMATCH", "decision_hash_mismatch");
        }
    } catch (error) {
        return failedVerification(receipt, receiptHash, "ERR_SCHEMA_VALIDATION", error.message);
    }
    const legacyValid = verifyReceiptSignature(receipt);
    const publicValid = verifyReceiptPublicSignature(receipt);
    if (!legacyValid || !publicValid) {
        return {
            ...failedVerification(receipt, receiptHash, "ERR_RECEIPT_SIGNATURE_INVALID", "receipt_signature_invalid"),
            receipt_signature_valid: legacyValid,
            public_signature_valid: publicValid
        };
    }
    let policy;
    try {
        policy = resolveHistoricalPolicy(policyStore, receipt.decision_output.policy_version, receipt.decision_output.policy_hash);
    } catch (error) {
        return {
            ...failedVerification(receipt, receiptHash, "ERR_HISTORICAL_POLICY_MISSING", error.message),
            receipt_signature_valid: true,
            public_signature_valid: true
        };
    }
    let replay;
    try {
        replay = replayReceipt(receipt, policyStore);
    } catch (error) {
        return {
            ...failedVerification(receipt, receiptHash, "ERR_REPLAY_MISMATCH", error.message),
            receipt_signature_valid: true,
            public_signature_valid: true,
            historical_policy_found: true,
            policy_signature_valid: true
        };
    }
    const originalCosts = costProjection(receipt.decision_output);
    const replayCosts = replay.replayed ? {
        total_cost_micro_usd: replay.replayed.total_cost_micro_usd,
        allowed_cost_micro_usd: replay.replayed.allowed_cost_micro_usd,
        prevented_cost_micro_usd: replay.replayed.prevented_cost_micro_usd
    } : null;
    const decisionHashMatches = replay.replayed?.decision_hash === receipt.decision_output.decision_hash;
    const costFieldsMatch = replayCosts !== null &&
        originalCosts.total_cost_micro_usd === replayCosts.total_cost_micro_usd &&
        originalCosts.allowed_cost_micro_usd === replayCosts.allowed_cost_micro_usd &&
        originalCosts.prevented_cost_micro_usd === replayCosts.prevented_cost_micro_usd;
    const verified = !replay.drift && decisionHashMatches && costFieldsMatch;
    return {
        schema_version: "mnde.receipt_verification.v1",
        status: verified ? "VERIFIED" : "FAILED",
        reason_code: verified ? "OK_VERIFIED" : "ERR_REPLAY_MISMATCH",
        receipt_hash: receiptHash,
        request_hash: receipt.request_hash,
        decision_hash: receipt.decision_output.decision_hash,
        decision: receipt.decision_output.decision,
        decision_reason_code: receipt.decision_output.reason_code,
        receipt_signature_valid: true,
        public_signature_valid: true,
        historical_policy_found: true,
        policy_signature_valid: true,
        policy_version: policy.policy_version,
        policy_hash: receipt.decision_output.policy_hash,
        replay_valid: !replay.drift,
        decision_hash_matches: decisionHashMatches,
        cost_fields_match: costFieldsMatch,
        mismatches: replay.mismatches,
        human_reason: translateReason(receipt.decision_output.reason_code, reasonContextFromReceipt(receipt))
    };
}

export function assertVerified(report) {
    if (report.status !== "VERIFIED") {
        throw new Error(report.reason_code);
    }
    return report;
}
