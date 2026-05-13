import { createPrivateKey, sign } from "crypto";

export const BUNDLE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICWe8yJMfTdHyBVYMPAyeUYav4APtN2SMUsEaVuZLM+E
-----END PRIVATE KEY-----
`;

export function signBundleRoot(rootHash) {
    return {
        algorithm: "Ed25519",
        key_id: "bundle-signing-key",
        root_hash: rootHash,
        signature: sign(null, Buffer.from(rootHash, "utf8"), createPrivateKey(BUNDLE_PRIVATE_KEY)).toString("base64")
    };
}
