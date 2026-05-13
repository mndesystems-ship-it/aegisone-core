import { existsSync, readFileSync } from "fs";
import path from "path";
import { canonicalizeJson } from "../shared/json.js";
import { canonicalPolicyPayload, policyHash } from "../shared/policy-trust.js";
import { keyIdFromRawPublicKey, verifyCanonicalPayload } from "../policy/crypto.js";
import { validatePolicyDocument } from "../policy/schema.js";
import { canonicalHash, parseStrictJsonText } from "../receipts/format.js";
import { validateProofManifest } from "./manifest_schema.js";
import { validateKeySet, validateSignatureEnvelope } from "./signature_envelope_schema.js";

function fail(code, message) {
    const error = new Error(message ?? code);
    error.code = code;
    throw error;
}

function readStrict(filePath, code) {
    if (!existsSync(filePath)) {
        fail(code, `${code}_missing`);
    }
    try {
        return parseStrictJsonText(readFileSync(filePath, "utf8"));
    } catch (error) {
        fail(code, error.message);
    }
}

function manifestPayload(manifest) {
    const { manifest_hash: _manifestHash, ...payload } = manifest;
    return payload;
}

function keyById(keySet) {
    return Object.fromEntries(keySet.keys.map((key) => [key.key_id, key.public_key]));
}

export function resolvePolicyProof(receipt, proofRoot) {
    const policyHashExpected = receipt?.policy_hash ?? receipt?.decision_output?.policy_hash;
    if (typeof policyHashExpected !== "string") {
        fail("ERR_POLICY_PROOF_UNRESOLVED", "receipt_policy_hash_missing");
    }
    const root = path.resolve(proofRoot);
    const manifestPath = path.join(root, "manifest.json");
    const manifest = readStrict(manifestPath, "ERR_POLICY_MANIFEST_INVALID");
    try {
        validateProofManifest(manifest);
        if (canonicalHash(manifestPayload(manifest)) !== manifest.manifest_hash) {
            fail("ERR_POLICY_MANIFEST_INVALID", "policy_manifest_hash_mismatch");
        }
    } catch (error) {
        fail(error.code ?? "ERR_POLICY_MANIFEST_INVALID", error.message);
    }
    const matches = manifest.entries.filter((entry) => entry.policy_hash === policyHashExpected);
    if (matches.length === 0) {
        fail("ERR_POLICY_PROOF_UNRESOLVED", "policy_hash_not_found");
    }
    if (matches.length > 1) {
        fail("ERR_POLICY_MULTIPLE_MATCHES", "policy_hash_multiple_matches");
    }
    const entry = matches[0];
    const policyPath = path.join(root, entry.policy_path);
    const envelopePath = path.join(root, entry.signature_envelope_path);
    const keySetPath = path.join(root, entry.key_set_path);
    const policy = readStrict(policyPath, "ERR_POLICY_PROOF_UNRESOLVED");
    const envelope = readStrict(envelopePath, "ERR_POLICY_ENVELOPE_INVALID");
    const keySet = readStrict(keySetPath, "ERR_POLICY_KEYSET_MISSING");
    try {
        validatePolicyDocument(policy, { requireTrust: true });
    } catch (error) {
        fail("ERR_POLICY_SIGNATURE_INVALID", error.message);
    }
    if (policyHash(policy) !== policyHashExpected || entry.policy_hash !== policyHashExpected || envelope.policy_hash !== policyHashExpected) {
        fail("ERR_POLICY_HASH_MISMATCH", "policy_hash_mismatch");
    }
    if (policy.policy_version !== entry.policy_version || envelope.policy_version !== entry.policy_version) {
        fail("ERR_POLICY_HASH_MISMATCH", "policy_version_mismatch");
    }
    try {
        validateSignatureEnvelope(envelope);
    } catch (error) {
        fail("ERR_POLICY_ENVELOPE_INVALID", error.message);
    }
    try {
        validateKeySet(keySet);
    } catch (error) {
        fail("ERR_POLICY_KEYSET_MISSING", error.message);
    }
    if (envelope.key_set_version !== keySet.key_set_version) {
        fail("ERR_POLICY_KEYSET_MISSING", "policy_key_set_version_mismatch");
    }
    const publicKeys = keyById(keySet);
    let validSignatures = 0;
    for (const signature of envelope.signatures) {
        if (!keySet.allowed_key_ids.includes(signature.key_id)) {
            fail("ERR_POLICY_SIGNATURE_INVALID", "policy_signature_key_not_allowed");
        }
        const publicKey = publicKeys[signature.key_id];
        if (!publicKey || keyIdFromRawPublicKey(publicKey) !== signature.key_id) {
            fail("ERR_POLICY_SIGNATURE_INVALID", "policy_signature_key_missing");
        }
        if (verifyCanonicalPayload(canonicalPolicyPayload(policy), signature.value, publicKey)) {
            validSignatures += 1;
        }
    }
    if (validSignatures < envelope.required_signatures) {
        fail("ERR_POLICY_SIGNATURE_INVALID", "policy_required_signatures_not_met");
    }
    return {
        schema_version: "mnde.policy_proof_resolution.v1",
        status: "RESOLVED",
        policy_hash: policyHashExpected,
        policy_version: entry.policy_version,
        policy_path: policyPath,
        signature_envelope_path: envelopePath,
        key_set_path: keySetPath,
        manifest_path: manifestPath,
        key_set_version: keySet.key_set_version,
        required_signatures: envelope.required_signatures,
        valid_signatures: validSignatures,
        resolution_hash: canonicalHash({
            policy_hash: policyHashExpected,
            policy_version: entry.policy_version,
            policy_path: path.resolve(policyPath),
            signature_envelope_path: path.resolve(envelopePath),
            key_set_path: path.resolve(keySetPath),
            manifest_path: path.resolve(manifestPath),
            key_set_version: keySet.key_set_version,
            required_signatures: envelope.required_signatures,
            valid_signatures: validSignatures
        })
    };
}

export function resolvePolicyProofReport(receipt, proofRoot) {
    try {
        return resolvePolicyProof(receipt, proofRoot);
    } catch (error) {
        return {
            schema_version: "mnde.policy_proof_resolution.v1",
            status: "FAILED",
            reason_code: error.code ?? "ERR_POLICY_PROOF_UNRESOLVED",
            error: error.message
        };
    }
}
