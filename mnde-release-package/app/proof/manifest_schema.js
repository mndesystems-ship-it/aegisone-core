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

export function validateProofManifest(manifest) {
    rejectUnknown(manifest, ["entries", "manifest_hash", "schema_version"], "proof_manifest");
    if (manifest.schema_version !== "mnde.proof_manifest.v1") {
        throw new Error("proof_manifest_bad_schema_version");
    }
    if (!Array.isArray(manifest.entries)) {
        throw new Error("proof_manifest_entries_must_be_array");
    }
    for (const entry of manifest.entries) {
        rejectUnknown(entry, ["key_set_path", "policy_hash", "policy_path", "policy_version", "signature_envelope_path"], "proof_manifest_entry");
        hashField(entry.policy_hash, "proof_manifest_entry.policy_hash");
        for (const field of ["key_set_path", "policy_path", "policy_version", "signature_envelope_path"]) {
            stringField(entry[field], `proof_manifest_entry.${field}`);
        }
    }
    hashField(manifest.manifest_hash, "manifest_hash");
    return { ok: true };
}
