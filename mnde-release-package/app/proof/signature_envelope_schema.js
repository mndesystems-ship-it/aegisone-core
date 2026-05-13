function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(value, allowed, label) {
    if (!isRecord(value)) {
        throw new Error(`${label}_must_be_object`);
    }
    const keys = new Set(allowed);
    for (const key of Object.keys(value)) {
        if (!keys.has(key)) {
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

export function validateSignatureEnvelope(envelope) {
    rejectUnknown(envelope, ["key_set_version", "policy_hash", "policy_version", "required_signatures", "schema_version", "signatures"], "policy_signature_envelope");
    if (envelope.schema_version !== "mnde.policy_signature_envelope.v1") {
        throw new Error("policy_signature_envelope_bad_schema_version");
    }
    hashField(envelope.policy_hash, "policy_hash");
    stringField(envelope.policy_version, "policy_version");
    stringField(envelope.key_set_version, "key_set_version");
    if (typeof envelope.required_signatures !== "number" || !Number.isSafeInteger(envelope.required_signatures) || envelope.required_signatures < 1) {
        throw new Error("required_signatures_must_be_positive_integer");
    }
    if (!Array.isArray(envelope.signatures) || envelope.signatures.length < envelope.required_signatures) {
        throw new Error("policy_signature_envelope_insufficient_signatures");
    }
    for (const signature of envelope.signatures) {
        rejectUnknown(signature, ["algorithm", "key_id", "value"], "policy_signature");
        if (signature.algorithm !== "ed25519.v1") {
            throw new Error("policy_signature_bad_algorithm");
        }
        stringField(signature.key_id, "signature.key_id");
        stringField(signature.value, "signature.value");
    }
    return { ok: true };
}

export function validateKeySet(keySet) {
    rejectUnknown(keySet, ["allowed_key_ids", "key_set_version", "keys", "schema_version"], "policy_key_set");
    if (keySet.schema_version !== "mnde.policy_key_set.v1") {
        throw new Error("policy_key_set_bad_schema_version");
    }
    stringField(keySet.key_set_version, "key_set_version");
    if (!Array.isArray(keySet.allowed_key_ids) || !Array.isArray(keySet.keys)) {
        throw new Error("policy_key_set_arrays_required");
    }
    const allowed = new Set();
    for (const keyId of keySet.allowed_key_ids) {
        stringField(keyId, "allowed_key_id");
        allowed.add(keyId);
    }
    for (const key of keySet.keys) {
        rejectUnknown(key, ["key_id", "public_key"], "policy_key");
        stringField(key.key_id, "key.key_id");
        if (typeof key.public_key !== "string" || !/^[0-9a-fA-F]{64}$/.test(key.public_key)) {
            throw new Error("policy_key_bad_public_key");
        }
        if (!allowed.has(key.key_id)) {
            throw new Error("policy_key_not_allow_listed");
        }
    }
    return { ok: true };
}
