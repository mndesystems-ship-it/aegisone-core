const RECEIPT_KEYS = ["canonical_request", "decision_output", "key_set_version", "manifest_ref", "pipeline_trace", "policy_hash", "request_hash", "schema_version", "signature", "translation_version", "verifiable_signature"];
const DECISION_KEYS = ["allowed_cost_usd", "decision", "decision_hash", "execution_id", "policy_hash", "policy_version", "prevented_cost_usd", "reason_code", "request_hash", "total_cost_usd"];
const SIGNATURE_KEYS = ["algorithm", "key_id", "value"];
const PUBLIC_SIGNATURE_KEYS = ["algorithm", "key_id", "public_key_fingerprint", "value"];
const PIPELINE_KEYS = ["arm", "orbit", "preflight", "ramona"];

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

function hashField(value, label) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
        throw new Error(`${label}_must_be_sha256_hex`);
    }
}

export function validateReceiptShape(receipt) {
    rejectUnknown(receipt, RECEIPT_KEYS, "receipt");
    if (receipt.schema_version !== "ecs.receipt.v2") {
        throw new Error("receipt_bad_schema_version");
    }
    stringField(receipt.canonical_request, "canonical_request");
    hashField(receipt.request_hash, "request_hash");
    hashField(receipt.policy_hash, "policy_hash");
    stringField(receipt.key_set_version, "key_set_version");
    stringField(receipt.manifest_ref, "manifest_ref");
    if (receipt.translation_version !== "mnde.reason_translation.v1") {
        throw new Error("receipt_bad_translation_version");
    }
    rejectUnknown(receipt.decision_output, DECISION_KEYS, "decision_output");
    if (!["ALLOW", "REFUSE"].includes(receipt.decision_output.decision)) {
        throw new Error("decision_output_bad_decision");
    }
    for (const key of ["decision_hash", "request_hash", "policy_hash"]) {
        hashField(receipt.decision_output[key], `decision_output.${key}`);
    }
    if (receipt.decision_output.request_hash !== receipt.request_hash) {
        throw new Error("receipt_request_hash_mismatch");
    }
    if (receipt.decision_output.policy_hash !== receipt.policy_hash) {
        throw new Error("receipt_policy_hash_mismatch");
    }
    for (const key of ["reason_code", "total_cost_usd", "allowed_cost_usd", "prevented_cost_usd", "policy_version", "execution_id"]) {
        stringField(receipt.decision_output[key], `decision_output.${key}`);
    }
    rejectUnknown(receipt.signature, SIGNATURE_KEYS, "receipt_signature");
    stringField(receipt.signature.algorithm, "signature.algorithm");
    stringField(receipt.signature.key_id, "signature.key_id");
    stringField(receipt.signature.value, "signature.value");
    rejectUnknown(receipt.verifiable_signature, PUBLIC_SIGNATURE_KEYS, "receipt_public_signature");
    stringField(receipt.verifiable_signature.algorithm, "verifiable_signature.algorithm");
    stringField(receipt.verifiable_signature.key_id, "verifiable_signature.key_id");
    stringField(receipt.verifiable_signature.public_key_fingerprint, "verifiable_signature.public_key_fingerprint");
    stringField(receipt.verifiable_signature.value, "verifiable_signature.value");
    rejectUnknown(receipt.pipeline_trace, PIPELINE_KEYS, "pipeline_trace");
    return { ok: true };
}
