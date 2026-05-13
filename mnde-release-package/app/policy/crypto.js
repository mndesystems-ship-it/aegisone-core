import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function sha256HexBytes(value) {
    return createHash("sha256").update(value).digest("hex");
}

export function publicKeyRawHexFromPem(publicKeyPem) {
    const publicKey = createPublicKey(publicKeyPem);
    const der = publicKey.export({ format: "der", type: "spki" });
    return Buffer.from(der).subarray(-32).toString("hex");
}

export function publicKeyRawHexFromPrivatePem(privateKeyPem) {
    return publicKeyRawHexFromPem(createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "pem", type: "spki" }));
}

export function keyIdFromRawPublicKey(publicKeyHex) {
    return createHash("sha256").update(Buffer.from(publicKeyHex, "hex")).digest("hex").slice(0, 16);
}

export function publicKeyObjectFromRawHex(publicKeyHex) {
    return createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
        format: "der",
        type: "spki"
    });
}

export function signCanonicalPayload(canonicalPayload, privateKeyPem) {
    return sign(null, Buffer.from(canonicalPayload, "utf8"), createPrivateKey(privateKeyPem)).toString("hex");
}

export function verifyCanonicalPayload(canonicalPayload, signatureHex, publicKeyHex) {
    if (typeof signatureHex !== "string" || !/^[0-9a-fA-F]+$/.test(signatureHex)) {
        return false;
    }
    if (typeof publicKeyHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
        return false;
    }
    return verify(null, Buffer.from(canonicalPayload, "utf8"), publicKeyObjectFromRawHex(publicKeyHex), Buffer.from(signatureHex, "hex"));
}

export function generateEd25519KeyPair() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const private_key_pem = privateKey.export({ format: "pem", type: "pkcs8" });
    const public_key = publicKeyRawHexFromPem(publicKey.export({ format: "pem", type: "spki" }));
    return {
        private_key_pem,
        public_key,
        key_id: keyIdFromRawPublicKey(public_key)
    };
}
