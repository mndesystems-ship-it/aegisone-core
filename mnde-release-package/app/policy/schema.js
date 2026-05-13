import { canonicalizeJson, parseStrictJson } from "../shared/json.js";
import { canonicalPolicyPayload, deriveKeyId, policyHash, verifyPolicySignature } from "../shared/policy-trust.js";

const POLICY_RULE_KEYS = [
    "allow_auto_scale",
    "max_gpu_count",
    "max_hours",
    "max_retry_count",
    "max_total_cost_cents",
    "require_manual_approval_above_cents"
];
const POLICY_KEYS = ["policy_version", "rules", "schema_version", "trust"];
const TRUST_KEYS = ["key_id", "key_version", "public_key", "signature"];
const CHANGE_REQUEST_KEYS = ["base_policy_version", "change_id", "created_at", "proposed_policy", "reason", "schema_version"];
const TRANSACTION_KEYS = ["authority", "change_request", "policy_hash", "schema_version", "signature", "transaction_id", "transaction_type"];
const RECEIPT_KEYS = ["active_policy_hash", "active_policy_version", "event_hash", "policy_hash", "policy_version", "receipt_hash", "schema_version", "signature", "transaction_id"];
const AUTHORITY_KEYS = ["authority_id", "authority_type", "delegated_by", "expires_at", "key_id", "limits", "not_before", "public_key", "revoked", "schema_version", "scope"];
const EXCEPTION_KEYS = ["authority", "exception_id", "expires_at", "limits", "policy_version", "schema_version", "scope", "signature", "single_use", "used_at"];

export function parseStrictJsonFileText(text) {
    const parsed = parseStrictJson(text);
    if (!parsed.ok) {
        throw new Error(parsed.reason);
    }
    return parsed.value;
}

function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(value, keys, label) {
    if (!isRecord(value)) {
        throw new Error(`${label}_must_be_object`);
    }
    const allowed = new Set(keys);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new Error(`${label}_unknown_field_${key}`);
        }
    }
}

function stringField(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label}_must_be_string`);
    }
}

function boolField(value, label) {
    if (typeof value !== "boolean") {
        throw new Error(`${label}_must_be_boolean`);
    }
}

function integerField(value, label, minimum) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) {
        throw new Error(`${label}_must_be_integer`);
    }
}

function timestampField(value, label) {
    stringField(value, label);
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
        throw new Error(`${label}_must_be_iso8601_utc`);
    }
}

export function validatePolicyDocument(policy, options = {}) {
    rejectUnknown(policy, POLICY_KEYS, "policy_document");
    if (policy.schema_version !== "ecs.policy.v1") {
        throw new Error("policy_document_bad_schema_version");
    }
    stringField(policy.policy_version, "policy_version");
    rejectUnknown(policy.rules, POLICY_RULE_KEYS, "policy_rules");
    integerField(policy.rules.max_total_cost_cents, "max_total_cost_cents", 1);
    boolField(policy.rules.allow_auto_scale, "allow_auto_scale");
    integerField(policy.rules.max_gpu_count, "max_gpu_count", 1);
    integerField(policy.rules.max_hours, "max_hours", 1);
    integerField(policy.rules.require_manual_approval_above_cents, "require_manual_approval_above_cents", 0);
    integerField(policy.rules.max_retry_count, "max_retry_count", 0);
    if (options.requireTrust && policy.trust === undefined) {
        throw new Error("policy_trust_required");
    }
    if (policy.trust !== undefined) {
        rejectUnknown(policy.trust, TRUST_KEYS, "policy_trust");
        if (policy.trust.key_version !== "ed25519.v1") {
            throw new Error("policy_trust_bad_key_version");
        }
        stringField(policy.trust.key_id, "policy_trust.key_id");
        if (typeof policy.trust.public_key !== "string" || !/^[0-9a-fA-F]{64}$/.test(policy.trust.public_key)) {
            throw new Error("policy_trust_bad_public_key");
        }
        if (deriveKeyId(policy.trust.public_key) !== policy.trust.key_id) {
            throw new Error("policy_trust_key_id_mismatch");
        }
        if (!verifyPolicySignature(policy.trust.public_key, canonicalPolicyPayload(policy), policy.trust.signature)) {
            throw new Error("policy_signature_invalid");
        }
    }
    return {
        ok: true,
        policy_hash: policyHash(policy),
        canonical: canonicalizeJson({
            schema_version: policy.schema_version,
            policy_version: policy.policy_version,
            rules: policy.rules
        })
    };
}

export function validatePolicyChangeRequest(value) {
    rejectUnknown(value, CHANGE_REQUEST_KEYS, "policy_change_request");
    if (value.schema_version !== "mnde.policy_change_request.v1") {
        throw new Error("policy_change_request_bad_schema_version");
    }
    stringField(value.change_id, "change_id");
    stringField(value.base_policy_version, "base_policy_version");
    timestampField(value.created_at, "created_at");
    stringField(value.reason, "reason");
    validatePolicyDocument(value.proposed_policy, { requireTrust: true });
    return { ok: true };
}

export function validatePolicyChangeTransaction(value) {
    rejectUnknown(value, TRANSACTION_KEYS, "policy_change_transaction");
    if (value.schema_version !== "mnde.policy_change_transaction.v1") {
        throw new Error("policy_change_transaction_bad_schema_version");
    }
    stringField(value.transaction_id, "transaction_id");
    if (!["PUBLISH", "ROLLBACK"].includes(value.transaction_type)) {
        throw new Error("policy_change_transaction_bad_type");
    }
    validatePolicyChangeRequest(value.change_request);
    validatePolicyAuthorityDocument(value.authority);
    if (typeof value.policy_hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(value.policy_hash)) {
        throw new Error("policy_change_transaction_bad_policy_hash");
    }
    rejectUnknown(value.signature, ["algorithm", "key_id", "value"], "policy_change_transaction_signature");
    if (value.signature.algorithm !== "ed25519.v1") {
        throw new Error("policy_change_transaction_bad_signature_algorithm");
    }
    stringField(value.signature.key_id, "signature.key_id");
    stringField(value.signature.value, "signature.value");
    return { ok: true };
}

export function validatePolicyUpdateReceipt(value) {
    rejectUnknown(value, RECEIPT_KEYS, "policy_update_receipt");
    if (value.schema_version !== "mnde.policy_update_receipt.v1") {
        throw new Error("policy_update_receipt_bad_schema_version");
    }
    for (const key of ["transaction_id", "policy_version", "policy_hash", "event_hash", "active_policy_version", "active_policy_hash", "receipt_hash"]) {
        stringField(value[key], key);
    }
    rejectUnknown(value.signature, ["algorithm", "key_id", "value"], "policy_update_receipt_signature");
    return { ok: true };
}

export function validatePolicyAuthorityDocument(value) {
    rejectUnknown(value, AUTHORITY_KEYS, "policy_authority_document");
    if (value.schema_version !== "mnde.policy_authority.v1") {
        throw new Error("policy_authority_bad_schema_version");
    }
    if (!["root", "org", "environment", "team"].includes(value.authority_type)) {
        throw new Error("policy_authority_bad_type");
    }
    for (const key of ["authority_id", "key_id", "public_key", "scope", "not_before", "expires_at"]) {
        stringField(value[key], key);
    }
    boolField(value.revoked, "revoked");
    if (value.delegated_by !== null) {
        stringField(value.delegated_by, "delegated_by");
    }
    if (!/^[0-9a-fA-F]{64}$/.test(value.public_key)) {
        throw new Error("policy_authority_bad_public_key");
    }
    if (deriveKeyId(value.public_key) !== value.key_id) {
        throw new Error("policy_authority_key_id_mismatch");
    }
    timestampField(value.not_before, "not_before");
    timestampField(value.expires_at, "expires_at");
    rejectUnknown(value.limits, POLICY_RULE_KEYS, "policy_authority_limits");
    validatePolicyDocument({ schema_version: "ecs.policy.v1", policy_version: "limits", rules: value.limits });
    return { ok: true };
}

export function validatePolicyExceptionDocument(value) {
    rejectUnknown(value, EXCEPTION_KEYS, "policy_exception_document");
    if (value.schema_version !== "mnde.policy_exception.v1") {
        throw new Error("policy_exception_bad_schema_version");
    }
    for (const key of ["exception_id", "policy_version", "scope", "expires_at"]) {
        stringField(value[key], key);
    }
    timestampField(value.expires_at, "expires_at");
    boolField(value.single_use, "single_use");
    if (value.used_at !== null) {
        timestampField(value.used_at, "used_at");
    }
    validatePolicyAuthorityDocument(value.authority);
    rejectUnknown(value.signature, ["algorithm", "key_id", "value"], "policy_exception_signature");
    if (value.signature.algorithm !== "ed25519.v1") {
        throw new Error("policy_exception_bad_signature_algorithm");
    }
    stringField(value.signature.key_id, "signature.key_id");
    stringField(value.signature.value, "signature.value");
    rejectUnknown(value.limits, POLICY_RULE_KEYS, "policy_exception_limits");
    return { ok: true };
}
