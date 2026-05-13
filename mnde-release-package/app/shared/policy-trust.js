import { createHash, createPublicKey, verify } from "crypto";
import { canonicalizeJson } from "./json.js";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export function deriveKeyId(publicKeyHex) {
    return createHash("sha256").update(Buffer.from(publicKeyHex, "hex")).digest("hex").slice(0, 16);
}
export function canonicalPolicyPayload(policy) {
    return canonicalizeJson({
        schema_version: policy.schema_version,
        policy_version: policy.policy_version,
        rules: policy.rules
    });
}
export function policyHash(policy) {
    return createHash("sha256").update(canonicalPolicyPayload(policy)).digest("hex");
}
export function verifyPolicySignature(publicKeyHex, payload, signatureHex) {
    const rawKey = Buffer.from(publicKeyHex, "hex");
    const publicKey = createPublicKey({
        key: Buffer.concat([
            ED25519_SPKI_PREFIX,
            rawKey
        ]),
        format: "der",
        type: "spki"
    });
    return verify(null, Buffer.from(payload, "utf8"), publicKey, Buffer.from(signatureHex, "hex"));
}
