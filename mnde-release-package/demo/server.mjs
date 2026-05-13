import http from "http";
import { createHash, createPrivateKey, randomBytes, sign } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { canonicalizeJson } from "../app/shared/index.js";
import { verifyReceiptPublicSignature, verifyReceiptSignature } from "../app/ramona/engine.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, "demo", "public");
const PORT = Number(process.env.DEMO_PORT ?? "3000");
const MNDE_URL = new URL(process.env.MNDE_URL ?? "http://127.0.0.1:8787/v1/decisions");
const CLIENT_KEY_ID = process.env.MNDE_CLIENT_KEY_ID ?? "local-client-1";
const CLIENT_PRIVATE_KEY_PATH = process.env.MNDE_CLIENT_PRIVATE_KEY ?? path.join(ROOT, "sidecar-local", "client_ed25519_private.pem");
const PRIVATE_KEY = createPrivateKey(readFileSync(CLIENT_PRIVATE_KEY_PATH, "utf8"));
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 20;

let lastReceipt = null;
const rateLimit = new Map();

function sha256Hex(value) {
    return createHash("sha256").update(value).digest("hex");
}

function jsonResponse(res, status, body) {
    const bytes = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": bytes.byteLength,
        "cache-control": "no-store"
    });
    res.end(bytes);
}

function textResponse(res, status, contentType, body) {
    const bytes = Buffer.from(body, "utf8");
    res.writeHead(status, {
        "content-type": `${contentType}; charset=utf-8`,
        "content-length": bytes.byteLength,
        "cache-control": "no-store"
    });
    res.end(bytes);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.byteLength;
            if (size > 16 * 1024) {
                reject(new Error("request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
            } catch {
                reject(new Error("invalid JSON"));
            }
        });
        req.on("error", reject);
    });
}

function checkRateLimit(req) {
    const ip = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const bucket = rateLimit.get(ip) ?? { resetAt: now + RATE_LIMIT_WINDOW_MS, count: 0 };
    if (now > bucket.resetAt) {
        bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
        bucket.count = 0;
    }
    bucket.count += 1;
    rateLimit.set(ip, bucket);
    return bucket.count <= RATE_LIMIT_MAX;
}

function parseInteger(value, name, min, max) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}`);
    }
    return value;
}

function buildMndeBody(options) {
    const { gpuCount, hours, gpuHourCents, retryOnFail, maxRetries, autoScale, maxScaleMultiplier, killSwitchActive, observedGpuCount } = options;
    const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const toolCall = { tool: "demo-gpu-job", priority: 1 };
    const projectedCost = gpuCount * hours * gpuHourCents * (autoScale ? maxScaleMultiplier : 1) * (retryOnFail ? maxRetries + 1 : 1);
    const runtimeCost = observedGpuCount * hours * gpuHourCents * (retryOnFail ? maxRetries + 1 : 1);
    return {
        execution_request: {
            request_id: `demo-${id}`,
            submitted_region: "us-west-2",
            actor: { user_id: "browser-demo" },
            resources: {
                gpu_type: "a10g",
                gpu_count: gpuCount,
                hours
            },
            execution: {
                auto_scale: autoScale,
                max_scale_multiplier: maxScaleMultiplier,
                retry_on_fail: retryOnFail,
                max_retries: maxRetries
            },
            tool_calls: [toolCall],
            orbit_intent: {
                orbit_version: "2.0",
                action: "execute",
                boundary: "browser-demo",
                payload: { tool_calls: [toolCall] },
                lifecycle_state: "ARMED",
                signatures: [{ alg: "ed25519.v1", sig: "browser-demo-action" }]
            },
            release_request: {
                execution_id: `exec-demo-${id}`,
                hold_state: "APPROVED",
                already_consumed: false
            },
            runtime_observation: {
                kill_switch_active: killSwitchActive,
                actual_gpu_count: observedGpuCount,
                actual_hours: hours,
                actual_total_cost_cents: runtimeCost
            }
        },
        pricing_data: {
            gpu_hour_cents: gpuHourCents
        }
    };
}

function signHeaders(method, pathname, body) {
    const bodyHash = sha256Hex(Buffer.from(body, "utf8"));
    const timestamp = new Date().toISOString();
    const nonce = randomBytes(16).toString("hex");
    const signingPayload = [
        "MNDE-REQUEST-V1",
        method,
        pathname,
        timestamp,
        nonce,
        bodyHash
    ].join("\n");
    const signature = sign(null, Buffer.from(signingPayload, "utf8"), PRIVATE_KEY).toString("hex");
    return {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-mnde-key-id": CLIENT_KEY_ID,
        "x-mnde-timestamp": timestamp,
        "x-mnde-nonce": nonce,
        "x-mnde-body-sha256": bodyHash,
        "x-mnde-signature-alg": "ed25519.v1",
        "x-mnde-signature": signature
    };
}

function callMnde(rawBody, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            protocol: MNDE_URL.protocol,
            hostname: MNDE_URL.hostname,
            port: MNDE_URL.port,
            path: MNDE_URL.pathname,
            method: "POST",
            headers
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                try {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: JSON.parse(text)
                    });
                } catch {
                    reject(new Error(`MNDe returned non-JSON response: ${text}`));
                }
            });
        });
        req.on("error", reject);
        req.end(rawBody);
    });
}

async function handleDemo(req, res) {
    if (!checkRateLimit(req)) {
        jsonResponse(res, 429, { error: "rate_limited" });
        return;
    }
    try {
        const input = await readJsonBody(req);
        const gpuCount = parseInteger(input.gpu_count, "gpu_count", 1, 1000);
        const hours = parseInteger(input.hours, "hours", 1, 1000);
        const gpuHourCents = parseInteger(input.gpu_hour_cents ?? 500, "gpu_hour_cents", 1, 100000);
        const maxRetries = parseInteger(input.max_retries ?? 0, "max_retries", 0, 999);
        const maxScaleMultiplier = parseInteger(input.max_scale_multiplier ?? 1, "max_scale_multiplier", 1, 100);
        const observedGpuCount = parseInteger(input.observed_gpu_count ?? gpuCount, "observed_gpu_count", 1, 1000);
        const bodyObject = buildMndeBody({
            gpuCount,
            hours,
            gpuHourCents,
            retryOnFail: Boolean(input.retry_on_fail),
            maxRetries,
            autoScale: Boolean(input.auto_scale),
            maxScaleMultiplier,
            killSwitchActive: Boolean(input.kill_switch_active),
            observedGpuCount
        });
        const rawBody = canonicalizeJson(bodyObject);
        const headers = signHeaders("POST", MNDE_URL.pathname, rawBody);
        const mndeResponse = await callMnde(rawBody, headers);
        if (mndeResponse.body?.receipt) {
            lastReceipt = mndeResponse.body.receipt;
        }
        jsonResponse(res, 200, {
            mnde_request: {
                url: MNDE_URL.toString(),
                method: "POST",
                headers: {
                    ...headers,
                    "x-mnde-signature": `${headers["x-mnde-signature"].slice(0, 16)}...${headers["x-mnde-signature"].slice(-16)}`
                },
                body: bodyObject
            },
            mnde_response: mndeResponse.body
        });
    } catch (error) {
        jsonResponse(res, 400, {
            error: "invalid_demo_request",
            message: error.message
        });
    }
}

function handleVerifyLastReceipt(res) {
    if (!lastReceipt) {
        jsonResponse(res, 404, { error: "no_receipt" });
        return;
    }
    jsonResponse(res, 200, {
        request_hash: lastReceipt.request_hash,
        decision: lastReceipt.decision_output?.decision ?? null,
        reason_code: lastReceipt.decision_output?.reason_code ?? null,
        legacy_signature_valid: verifyReceiptSignature(lastReceipt),
        public_signature_valid: verifyReceiptPublicSignature(lastReceipt)
    });
}

function serveStatic(req, res, pathname) {
    const filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname.slice(1));
    if (!filePath.startsWith(PUBLIC_DIR)) {
        textResponse(res, 403, "text/plain", "forbidden");
        return;
    }
    try {
        const body = readFileSync(filePath, "utf8");
        const contentType = filePath.endsWith(".css") ? "text/css" : filePath.endsWith(".js") ? "application/javascript" : "text/html";
        textResponse(res, 200, contentType, body);
    } catch {
        textResponse(res, 404, "text/plain", "not found");
    }
}

const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && pathname === "/demo") {
        await handleDemo(req, res);
        return;
    }
    if (req.method === "POST" && pathname === "/verify-last-receipt") {
        handleVerifyLastReceipt(res);
        return;
    }
    if (req.method === "GET") {
        serveStatic(req, res, pathname);
        return;
    }
    jsonResponse(res, 405, { error: "method_not_allowed" });
});

server.listen(PORT, "127.0.0.1", () => {
    process.stdout.write(`MNDe browser demo listening on http://127.0.0.1:${PORT}\n`);
});
