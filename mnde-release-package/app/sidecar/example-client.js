import http from "http";
import { createHash, createPrivateKey, randomBytes, sign } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { canonicalizeJson } from "../shared/index.js";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const privateKeyPath = process.env.MNDE_CLIENT_PRIVATE_KEY ?? path.join(PACKAGE_ROOT, "sidecar-local", "client_ed25519_private.pem");
const keyId = process.env.MNDE_CLIENT_KEY_ID ?? "local-client-1";
const target = new URL(process.env.MNDE_URL ?? "http://127.0.0.1:8787/v1/decisions");
const mode = process.argv.includes("--refuse") ? "refuse" : "allow";
const printRaw = process.argv.includes("--raw");
function flagValue(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? null : process.argv[index + 1] ?? null;
}
const fixedNonce = flagValue("--nonce");
const fixedTimestamp = flagValue("--timestamp");
const invalidSchema = process.argv.includes("--invalid-schema");

const executionRequest = {
    request_id: `example-${mode}-${Date.now()}`,
    submitted_region: "us-west-2",
    actor: {
        user_id: "example-app"
    },
    resources: {
        gpu_type: "a10g",
        gpu_count: mode === "refuse" ? 99 : 2,
        hours: 4
    },
    execution: {
        auto_scale: false,
        max_scale_multiplier: 1,
        retry_on_fail: false,
        max_retries: 0
    },
    tool_calls: [
        {
            tool: "provision-gpu-job",
            priority: 1
        }
    ],
    orbit_intent: {
        orbit_version: "2.0",
        action: "execute",
        boundary: "example-sidecar",
        payload: {
            tool_calls: [
                {
                    tool: "provision-gpu-job",
                    priority: 1
                }
            ]
        },
        lifecycle_state: "ARMED",
        signatures: [
            {
                alg: "ed25519.v1",
                sig: "example-action-signature"
            }
        ]
    },
    release_request: {
        execution_id: `exec-example-${mode}-${Date.now()}`,
        hold_state: "APPROVED",
        already_consumed: false
    },
    runtime_observation: {
        kill_switch_active: false,
        actual_gpu_count: mode === "refuse" ? 99 : 2,
        actual_hours: 4,
        actual_total_cost_cents: mode === "refuse" ? 198000 : 4000
    }
};

const body = invalidSchema ? canonicalizeJson({ invalid_request: true }) : canonicalizeJson({
    execution_request: executionRequest,
    pricing_data: {
        gpu_hour_cents: 500
    }
});
const bodyHash = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
const timestamp = fixedTimestamp ?? new Date().toISOString();
const nonce = fixedNonce ?? randomBytes(16).toString("hex");
const signingPayload = [
    "MNDE-REQUEST-V1",
    "POST",
    target.pathname,
    timestamp,
    nonce,
    bodyHash
].join("\n");
const privateKey = createPrivateKey(readFileSync(privateKeyPath, "utf8"));
const signature = sign(null, Buffer.from(signingPayload, "utf8"), privateKey).toString("hex");

const req = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: "POST",
    headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-mnde-key-id": keyId,
        "x-mnde-timestamp": timestamp,
        "x-mnde-nonce": nonce,
        "x-mnde-body-sha256": bodyHash,
        "x-mnde-signature-alg": "ed25519.v1",
        "x-mnde-signature": signature
    }
}, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
        const responseText = Buffer.concat(chunks).toString("utf8");
        if (printRaw) {
            process.stdout.write(JSON.stringify({
                request: {
                    method: "POST",
                    url: target.toString(),
                    headers: {
                        "content-type": "application/json",
                        "x-mnde-key-id": keyId,
                        "x-mnde-timestamp": timestamp,
                        "x-mnde-nonce": nonce,
                        "x-mnde-body-sha256": bodyHash,
                        "x-mnde-signature-alg": "ed25519.v1",
                        "x-mnde-signature": signature
                    },
                    body: JSON.parse(body)
                },
                response: {
                    status: res.statusCode,
                    body: JSON.parse(responseText)
                }
            }, null, 2) + "\n");
            return;
        }
        process.stdout.write(`HTTP ${res.statusCode}\n${JSON.stringify(JSON.parse(responseText), null, 2)}\n`);
    });
});

req.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
});
req.end(body);
