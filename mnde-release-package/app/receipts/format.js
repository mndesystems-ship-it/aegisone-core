import { canonicalizeJson, parseStrictJson } from "../shared/json.js";
import { sha256Hex } from "../shared/hash.js";

export function parseStrictJsonText(text) {
    const parsed = parseStrictJson(text);
    if (!parsed.ok) {
        throw new Error(parsed.reason);
    }
    return parsed.value;
}

export function canonicalHash(value) {
    return sha256Hex(canonicalizeJson(value));
}

export function requestHashFromCanonicalRequest(canonicalRequest) {
    const parsed = parseStrictJsonText(canonicalRequest);
    return canonicalHash(parsed);
}

export function centsFromUsdString(value) {
    const microUsd = usdStringToMicroUsd(value);
    if (microUsd % 10000 !== 0) {
        throw new Error("money_not_cent_aligned");
    }
    return microUsd / 10000;
}

export function decisionHashFromReceipt(receipt) {
    return canonicalHash({
        request_hash: receipt.request_hash,
        policy_hash: receipt.policy_hash,
        key_set_version: receipt.key_set_version,
        manifest_ref: receipt.manifest_ref,
        translation_version: receipt.translation_version,
        decision: receipt.decision_output.decision,
        reason_code: receipt.decision_output.reason_code,
        policy_version: receipt.decision_output.policy_version,
        execution_id: receipt.decision_output.execution_id,
        projected_total_cost_cents: centsFromUsdString(receipt.decision_output.total_cost_usd),
        allowed_cost_cents: centsFromUsdString(receipt.decision_output.allowed_cost_usd),
        prevented_cost_cents: centsFromUsdString(receipt.decision_output.prevented_cost_usd)
    });
}

export function usdStringToMicroUsd(value) {
    if (typeof value !== "string") {
        throw new Error("money_must_be_string");
    }
    const match = /^(\d+)\.(\d{2})$/.exec(value);
    if (!match) {
        throw new Error("money_malformed_usd_string");
    }
    const dollars = Number(match[1]);
    const cents = Number(match[2]);
    if (!Number.isSafeInteger(dollars) || !Number.isSafeInteger(cents)) {
        throw new Error("money_not_safe_integer");
    }
    const microUsd = dollars * 1000000 + cents * 10000;
    if (!Number.isSafeInteger(microUsd)) {
        throw new Error("money_micro_usd_overflow");
    }
    return microUsd;
}

export function microUsdToUsdString(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error("micro_usd_must_be_integer");
    }
    if (value % 10000 !== 0) {
        throw new Error("micro_usd_not_cent_aligned");
    }
    const cents = value / 10000;
    const dollars = Math.floor(cents / 100);
    const remainder = cents % 100;
    return `${dollars}.${String(remainder).padStart(2, "0")}`;
}

export function writeJsonLine(value) {
    return `${canonicalizeJson(value)}\n`;
}

export function deterministicError(error, fallback = "ERR_RECEIPTS_COMMAND") {
    return {
        schema_version: "mnde.receipts_error.v1",
        error: error instanceof Error ? error.message : fallback
    };
}
