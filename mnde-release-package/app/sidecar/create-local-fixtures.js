import { generateKeyPairSync, sign } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { canonicalPolicyPayload, deriveKeyId } from "../shared/index.js";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_DIR = path.join(PACKAGE_ROOT, "sidecar-local");
const dir = path.resolve(process.argv[2] ?? DEFAULT_DIR);
const policyPath = path.join(dir, "policy.v1.signed.json");
const clientKeysPath = path.join(dir, "client_keys.json");
const clientPrivateKeyPath = path.join(dir, "client_ed25519_private.pem");
const policyPrivateKeyPath = path.join(dir, "policy_ed25519_private.pem");

function rawPublicKeyHex(publicKey) {
    const der = publicKey.export({ format: "der", type: "spki" });
    return Buffer.from(der).subarray(-32).toString("hex");
}

function ensureFixtures() {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(policyPath) || !existsSync(clientKeysPath) || !existsSync(clientPrivateKeyPath)) {
        const policyKeys = generateKeyPairSync("ed25519");
        const clientKeys = generateKeyPairSync("ed25519");
        const policyPublicKey = rawPublicKeyHex(policyKeys.publicKey);
        const policy = {
            schema_version: "ecs.policy.v1",
            policy_version: "policy.v1",
            rules: {
                max_total_cost_cents: 10000,
                allow_auto_scale: false,
                max_gpu_count: 4,
                max_hours: 8,
                require_manual_approval_above_cents: 5000,
                max_retry_count: 1
            }
        };
        const signature = sign(null, Buffer.from(canonicalPolicyPayload(policy), "utf8"), policyKeys.privateKey).toString("hex");
        const signedPolicy = {
            ...policy,
            trust: {
                key_version: "ed25519.v1",
                key_id: deriveKeyId(policyPublicKey),
                public_key: policyPublicKey,
                signature
            }
        };
        writeFileSync(policyPath, `${JSON.stringify(signedPolicy, null, 2)}\n`, "utf8");
        writeFileSync(clientKeysPath, `${JSON.stringify({
            keys: [
                {
                    key_id: "local-client-1",
                    public_key: rawPublicKeyHex(clientKeys.publicKey),
                    status: "active"
                }
            ]
        }, null, 2)}\n`, "utf8");
        writeFileSync(clientPrivateKeyPath, clientKeys.privateKey.export({ format: "pem", type: "pkcs8" }), "utf8");
        writeFileSync(policyPrivateKeyPath, policyKeys.privateKey.export({ format: "pem", type: "pkcs8" }), "utf8");
    }
    process.stdout.write(JSON.stringify({
        policy: policyPath,
        client_keys: clientKeysPath,
        client_private_key: clientPrivateKeyPath
    }, null, 2) + "\n");
}

ensureFixtures();

