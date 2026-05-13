import http from "http";
import { createHash, createPublicKey, verify } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { executeDeterministicPipeline } from "../audit/node_runtime.js";
import { canonicalizeJson, canonicalPolicyPayload, deriveKeyId, parseStrictJson, policyHash, verifyPolicySignature } from "../shared/index.js";
import { verifyManifest } from "../release/verify_manifest.js";
import { loadActivePolicy, paths as policyStorePaths } from "../policy/lifecycle.js";
import { authorize } from "../authz/lifecycle.js";
import { MemoryNonceStore } from "./nonce-store.js";

const DEFAULT_BIND_ADDR = "127.0.0.1:8787";
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const STARTUP_STATE = {
    INIT: "INIT",
    POLICY_LOADED: "POLICY_LOADED",
    READY: "READY",
    FAIL_CLOSED: "FAIL_CLOSED"
};

const REASONS = {
    requestSignatureInvalid: "ERR_REQUEST_SIGNATURE_INVALID",
    requestTimestampInvalid: "ERR_REQUEST_TIMESTAMP_SKEW",
    requestReplay: "ERR_REQUEST_NONCE_REPLAY",
    requestBodyHashMismatch: "ERR_REQUEST_BODY_HASH_MISMATCH",
    requestSchemaInvalid: "ERR_REQUEST_SCHEMA_INVALID",
    authzDenied: "ERR_AUTHZ_DENIED",
    policyUnavailable: "ERR_POLICY_UNAVAILABLE",
    policyInvalid: "ERR_POLICY_INVALID",
    receiptPersistence: "ERR_RECEIPT_PERSISTENCE",
    runtimeError: "ERR_RUNTIME_ERROR",
    methodNotAllowed: "ERR_METHOD_NOT_ALLOWED",
    notFound: "ERR_NOT_FOUND",
    manifestInvalid: "ERR_MANIFEST_INVALID",
    portBindFailed: "ERR_PORT_BIND_FAILED",
    bodyTooLarge: "ERR_BODY_TOO_LARGE"
};

let state = STARTUP_STATE.INIT;
let logFilePath = null;
let logMaxBytes = DEFAULT_LOG_MAX_BYTES;

function nowIso() {
    return new Date().toISOString();
}

function rotateLogIfNeeded(filePath, maxBytes) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    if (existsSync(filePath) && statSync(filePath).size >= maxBytes) {
        const rotatedPath = `${filePath}.1`;
        if (existsSync(rotatedPath)) {
            renameSync(rotatedPath, `${rotatedPath}.${Date.now()}`);
        }
        renameSync(filePath, rotatedPath);
    }
}

function log(event) {
    const line = `${JSON.stringify({ ts: nowIso(), state, ...event })}\n`;
    process.stdout.write(line);
    if (!logFilePath) {
        return;
    }
    try {
        rotateLogIfNeeded(logFilePath, logMaxBytes);
        appendFileSync(logFilePath, line, { encoding: "utf8", flag: "a" });
    } catch (error) {
        process.stderr.write(`${JSON.stringify({ ts: nowIso(), state, event: "mnde.log_error", error: error.message })}\n`);
    }
}

function sha256Hex(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function readRawBody(req, maxBytes = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.byteLength;
            if (size > maxBytes) {
                const error = new Error("request body too large");
                error.code = REASONS.bodyTooLarge;
                reject(error);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function publicKeyFromRawHex(publicKeyHex) {
    return createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
        format: "der",
        type: "spki"
    });
}

function normalizeClientKey(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("client key entry must be an object");
    }
    if (typeof item.key_id !== "string" || item.key_id.length === 0) {
        throw new Error("client key entry missing key_id");
    }
    if (typeof item.public_key !== "string" || !/^[0-9a-fA-F]{64}$/.test(item.public_key)) {
        throw new Error(`client key ${item.key_id} has invalid public_key`);
    }
    if (item.status !== undefined && item.status !== "active") {
        return null;
    }
    return {
        key_id: item.key_id,
        public_key_object: publicKeyFromRawHex(item.public_key),
        not_before: item.not_before ? Date.parse(item.not_before) : null,
        not_after: item.not_after ? Date.parse(item.not_after) : null
    };
}

function loadClientKeys(filePath) {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const entries = Array.isArray(parsed) ? parsed : parsed.keys;
    if (!Array.isArray(entries)) {
        throw new Error("client keys file must contain an array or {keys: []}");
    }
    const keys = new Map();
    for (const entry of entries) {
        const normalized = normalizeClientKey(entry);
        if (normalized) {
            keys.set(normalized.key_id, normalized);
        }
    }
    if (keys.size === 0) {
        throw new Error("no active client keys loaded");
    }
    return keys;
}

function loadAndValidatePolicy(filePath, pinnedVersion) {
    const raw = readFileSync(filePath, "utf8");
    const parsed = parseStrictJson(raw);
    if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
        throw new Error("policy is not strict JSON object");
    }
    const policy = parsed.value;
    if (policy.schema_version !== "ecs.policy.v1") {
        throw new Error("policy schema_version must be ecs.policy.v1");
    }
    if (pinnedVersion && policy.policy_version !== pinnedVersion) {
        throw new Error(`policy_version ${policy.policy_version} does not match pinned ${pinnedVersion}`);
    }
    if (!policy.trust || typeof policy.trust !== "object" || Array.isArray(policy.trust)) {
        throw new Error("signed policy trust block is required");
    }
    if (policy.trust.key_version !== "ed25519.v1") {
        throw new Error("policy trust key_version must be ed25519.v1");
    }
    if (typeof policy.trust.public_key !== "string" || !/^[0-9a-fA-F]{64}$/.test(policy.trust.public_key)) {
        throw new Error("policy trust public_key must be 32-byte hex");
    }
    if (deriveKeyId(policy.trust.public_key) !== policy.trust.key_id) {
        throw new Error("policy trust key_id does not match public key");
    }
    if (typeof policy.trust.signature !== "string" || !/^[0-9a-fA-F]+$/.test(policy.trust.signature)) {
        throw new Error("policy trust signature must be hex");
    }
    if (!verifyPolicySignature(policy.trust.public_key, canonicalPolicyPayload(policy), policy.trust.signature)) {
        throw new Error("policy signature verification failed");
    }
    return {
        policy,
        policy_hash: policyHash(policy)
    };
}

function loadPolicyState(config) {
    if (config.policyStore) {
        const loaded = loadActivePolicy(config.policyStore);
        return {
            policy: loaded.policy,
            policy_hash: policyHash(loaded.policy),
            active_index_mtime: statSync(policyStorePaths(config.policyStore).active).mtimeMs
        };
    }
    return loadAndValidatePolicy(config.policyFile, config.pinnedPolicyVersion);
}

function maybeReloadPolicy(config, currentPolicyState) {
    if (!config.policyStore) {
        return currentPolicyState;
    }
    const activePath = policyStorePaths(config.policyStore).active;
    const mtime = statSync(activePath).mtimeMs;
    if (mtime === currentPolicyState.active_index_mtime) {
        return currentPolicyState;
    }
    return loadPolicyState(config);
}

function parseBindAddr(value) {
    const [host, portText] = value.split(":");
    const port = Number(portText);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`invalid MNDE_BIND_ADDR ${value}`);
    }
    return { host, port };
}

function buildSigningPayload(req, timestamp, nonce, bodyHash) {
    return [
        "MNDE-REQUEST-V1",
        req.method,
        new URL(req.url, "http://127.0.0.1").pathname,
        timestamp,
        nonce,
        bodyHash
    ].join("\n");
}

function verifyRequestSignature(req, bodyBytes, clientKeys, nonceStore) {
    const headers = req.headers;
    const keyId = headers["x-mnde-key-id"];
    const timestamp = headers["x-mnde-timestamp"];
    const nonce = headers["x-mnde-nonce"];
    const bodyHash = headers["x-mnde-body-sha256"];
    const signatureAlg = headers["x-mnde-signature-alg"];
    const signatureHex = headers["x-mnde-signature"];
    if ([keyId, timestamp, nonce, bodyHash, signatureAlg, signatureHex].some((value) => typeof value !== "string" || value.length === 0)) {
        return { ok: false, reason_code: REASONS.requestSignatureInvalid };
    }
    if (signatureAlg !== "ed25519.v1" || !/^[0-9a-fA-F]+$/.test(signatureHex) || !/^[0-9a-fA-F]{64}$/.test(bodyHash)) {
        return { ok: false, reason_code: REASONS.requestSignatureInvalid };
    }
    const clientKey = clientKeys.get(keyId);
    if (!clientKey) {
        return { ok: false, reason_code: REASONS.requestSignatureInvalid };
    }
    const timestampMs = Date.parse(timestamp);
    const currentMs = Date.now();
    if (!Number.isFinite(timestampMs) || Math.abs(currentMs - timestampMs) > AUTH_WINDOW_MS) {
        return { ok: false, reason_code: REASONS.requestTimestampInvalid };
    }
    if ((clientKey.not_before !== null && timestampMs < clientKey.not_before) || (clientKey.not_after !== null && timestampMs > clientKey.not_after)) {
        return { ok: false, reason_code: REASONS.requestSignatureInvalid };
    }
    const normalizedBodyHash = bodyHash.toLowerCase();
    if (sha256Hex(bodyBytes) !== normalizedBodyHash) {
        return { ok: false, reason_code: REASONS.requestBodyHashMismatch };
    }
    if (!nonceStore.reserve(keyId, nonce, currentMs)) {
        return { ok: false, reason_code: REASONS.requestReplay };
    }
    try {
        const payload = buildSigningPayload(req, timestamp, nonce, normalizedBodyHash);
        const valid = verify(null, Buffer.from(payload, "utf8"), clientKey.public_key_object, Buffer.from(signatureHex, "hex"));
        return valid ? { ok: true, key_id: keyId } : { ok: false, reason_code: REASONS.requestSignatureInvalid };
    } catch {
        return { ok: false, reason_code: REASONS.requestSignatureInvalid };
    }
}

function refusal(reasonCode, statusCode = 200, extra = {}) {
    return {
        statusCode,
        body: {
            schema_version: "mnde.api.response.v1",
            request_id: extra.request_id ?? null,
            decision: "REFUSE",
            reason_code: reasonCode,
            request_hash: extra.request_hash ?? null,
            decision_hash: extra.decision_hash ?? null,
            total_cost_usd: "0.00",
            allowed_cost_usd: "0.00",
            prevented_cost_usd: "0.00",
            receipt: null
        }
    };
}

function apiResponseFromReceipt(receipt) {
    const decision = receipt.decision_output;
    return {
        schema_version: "mnde.api.response.v1",
        request_id: JSON.parse(receipt.canonical_request).execution_request.request_id,
        decision: decision.decision,
        reason_code: decision.reason_code,
        request_hash: decision.request_hash,
        decision_hash: decision.decision_hash,
        total_cost_usd: decision.total_cost_usd,
        allowed_cost_usd: decision.allowed_cost_usd,
        prevented_cost_usd: decision.prevented_cost_usd,
        policy_version: decision.policy_version,
        policy_hash: decision.policy_hash,
        receipt
    };
}

function writeJson(res, statusCode, body) {
    const bytes = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
    res.writeHead(statusCode, {
        "content-type": "application/json; charset=utf-8",
        "content-length": bytes.byteLength,
        "cache-control": "no-store"
    });
    res.end(bytes);
}

function appendReceipt(receiptLogPath, receipt) {
    mkdirSync(path.dirname(receiptLogPath), { recursive: true });
    appendFileSync(receiptLogPath, `${canonicalizeJson(receipt)}\n`, { encoding: "utf8", flag: "a" });
}

function createMetrics() {
    return {
        decisions_total: 0,
        allowed_total: 0,
        refused_total: 0,
        refusals_by_reason: new Map()
    };
}

function recordDecision(metrics, decision, reasonCode) {
    metrics.decisions_total += 1;
    if (decision === "ALLOW") {
        metrics.allowed_total += 1;
        return;
    }
    metrics.refused_total += 1;
    metrics.refusals_by_reason.set(reasonCode, (metrics.refusals_by_reason.get(reasonCode) ?? 0) + 1);
}

function renderMetrics(metrics) {
    const lines = [
        "# TYPE mnde_decisions_total counter",
        `mnde_decisions_total ${metrics.decisions_total}`,
        "# TYPE mnde_decisions_allowed_total counter",
        `mnde_decisions_allowed_total ${metrics.allowed_total}`,
        "# TYPE mnde_decisions_refused_total counter",
        `mnde_decisions_refused_total ${metrics.refused_total}`,
        "# TYPE mnde_refusals_by_reason_total counter"
    ];
    for (const [reason, count] of metrics.refusals_by_reason.entries()) {
        lines.push(`mnde_refusals_by_reason_total{reason_code="${reason}"} ${count}`);
    }
    return `${lines.join("\n")}\n`;
}

function loadConfig() {
    const bindAddr = process.env.MNDE_BIND_ADDR ?? DEFAULT_BIND_ADDR;
    const policyFile = process.env.MNDE_POLICY_FILE;
    const policyStore = process.env.MNDE_POLICY_STORE;
    const authzStore = process.env.MNDE_AUTHZ_STORE;
    const authzReceiptPrivateKeyFile = process.env.MNDE_AUTHZ_RECEIPT_PRIVATE_KEY;
    const clientKeysFile = process.env.MNDE_CLIENT_KEYS;
    const receiptLog = process.env.MNDE_RECEIPT_LOG ?? path.join(PACKAGE_ROOT, "receipts", "receipts.jsonl");
    const sidecarLog = process.env.MNDE_SIDECAR_LOG ?? path.join(PACKAGE_ROOT, "logs", "sidecar.jsonl");
    const configuredLogMaxBytes = Number(process.env.MNDE_LOG_MAX_BYTES ?? DEFAULT_LOG_MAX_BYTES);
    const pinnedPolicyVersion = process.env.MNDE_PINNED_POLICY_VERSION ?? "policy.v1";
    if (!policyFile && !policyStore) {
        throw new Error("MNDE_POLICY_FILE is required");
    }
    if (!clientKeysFile) {
        throw new Error("MNDE_CLIENT_KEYS is required");
    }
    if (!authzStore || !authzReceiptPrivateKeyFile) {
        throw new Error("MNDE_AUTHZ_STORE and MNDE_AUTHZ_RECEIPT_PRIVATE_KEY are required");
    }
    return {
        bind: parseBindAddr(bindAddr),
        policyFile: policyFile ? path.resolve(policyFile) : null,
        policyStore: policyStore ? path.resolve(policyStore) : null,
        authzStore: path.resolve(authzStore),
        authzReceiptPrivateKeyPem: readFileSync(path.resolve(authzReceiptPrivateKeyFile), "utf8"),
        clientKeysFile: path.resolve(clientKeysFile),
        receiptLog: path.resolve(receiptLog),
        sidecarLog: path.resolve(sidecarLog),
        logMaxBytes: Number.isSafeInteger(configuredLogMaxBytes) && configuredLogMaxBytes > 0 ? configuredLogMaxBytes : DEFAULT_LOG_MAX_BYTES,
        pinnedPolicyVersion
    };
}

async function main() {
    const config = loadConfig();
    logFilePath = config.sidecarLog;
    logMaxBytes = config.logMaxBytes;
    state = STARTUP_STATE.INIT;
    log({ event: "mnde.startup_state", startup_state: state, decision: "REFUSE", reason_code: "OK_INIT" });
    const manifest = verifyManifest();
    if (!manifest.ok) {
        state = STARTUP_STATE.FAIL_CLOSED;
        log({ event: "mnde.startup", decision: "REFUSE", reason_code: REASONS.manifestInvalid, mismatches: manifest.mismatches });
        process.exit(1);
    }

    let policyState;
    let clientKeys;
    try {
        policyState = loadPolicyState(config);
        state = STARTUP_STATE.POLICY_LOADED;
        log({ event: "mnde.startup_state", startup_state: state, decision: "REFUSE", reason_code: "OK_POLICY_LOADED", policy_hash: policyState.policy_hash });
        clientKeys = loadClientKeys(config.clientKeysFile);
        state = STARTUP_STATE.READY;
    } catch (error) {
        state = STARTUP_STATE.FAIL_CLOSED;
        log({ event: "mnde.startup", decision: "REFUSE", reason_code: REASONS.policyInvalid, error: error.message });
        process.exit(1);
    }

    const nonceStore = new MemoryNonceStore(AUTH_WINDOW_MS);
    const metrics = createMetrics();
    const server = http.createServer(async (req, res) => {
        const pathname = new URL(req.url, "http://127.0.0.1").pathname;
        if (req.method === "GET" && pathname === "/healthz") {
            writeJson(res, 200, {
                ok: true,
                startup_state: state,
                manifest_ok: true,
                active_policy_version: policyState.policy.policy_version
            });
            return;
        }
        if (req.method === "GET" && pathname === "/readyz") {
            writeJson(res, 200, {
                ok: state === STARTUP_STATE.READY,
                startup_state: state,
                active_policy_version: policyState.policy.policy_version,
                policy_hash: policyState.policy_hash
            });
            return;
        }
        if (req.method === "GET" && pathname === "/metrics") {
            const body = Buffer.from(renderMetrics(metrics), "utf8");
            res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "content-length": body.byteLength });
            res.end(body);
            return;
        }
        if (pathname !== "/v1/decisions") {
            const result = refusal(REASONS.notFound, 404);
            writeJson(res, result.statusCode, result.body);
            return;
        }
        if (req.method !== "POST") {
            const result = refusal(REASONS.methodNotAllowed, 405);
            writeJson(res, result.statusCode, result.body);
            return;
        }

        let requestId = null;
        let response;
        try {
            if (state !== STARTUP_STATE.READY) {
                response = refusal(REASONS.policyUnavailable, 503);
            } else {
                try {
                    policyState = maybeReloadPolicy(config, policyState);
                } catch (error) {
                    log({ event: "mnde.policy_reload_failed", decision: "REFUSE", reason_code: REASONS.policyInvalid, error: error.message });
                }
                const bodyBytes = await readRawBody(req);
                const auth = verifyRequestSignature(req, bodyBytes, clientKeys, nonceStore);
                if (!auth.ok) {
                    response = refusal(auth.reason_code, auth.reason_code === REASONS.requestReplay ? 409 : 401);
                } else {
                    const parsed = parseStrictJson(bodyBytes.toString("utf8"));
                    if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
                        response = refusal(REASONS.requestSchemaInvalid, 400);
                    } else {
                        requestId = parsed.value.execution_request?.request_id ?? null;
                        const authz = authorize(config.authzStore, {
                            actor_key_id: auth.key_id,
                            requested_scope: "decision:submit",
                            resource_scope: {},
                            timestamp: new Date().toISOString(),
                            action: {
                                type: "EXECUTION_SUBMISSION",
                                request_id: requestId,
                                request_hash: sha256Hex(canonicalizeJson(parsed.value))
                            }
                        }, config.authzReceiptPrivateKeyPem);
                        if (!authz.ok) {
                            response = refusal(REASONS.authzDenied, 403, { request_id: requestId });
                            recordDecision(metrics, response.body.decision, response.body.reason_code);
                            log({
                                event: "mnde.decision",
                                request_id: response.body.request_id ?? requestId,
                                decision: response.body.decision,
                                reason_code: response.body.reason_code,
                                request_hash: response.body.request_hash,
                                prevented_cost: response.body.prevented_cost_usd
                            });
                            writeJson(res, response.statusCode, response.body);
                            return;
                        }
                        const runtimeInput = {
                            ...parsed.value,
                            policy_document: policyState.policy
                        };
                        const result = executeDeterministicPipeline(canonicalizeJson(runtimeInput));
                        if ("parse_boundary" in result) {
                            response = refusal(result.reason_code, 200, {
                                request_id: requestId,
                                request_hash: result.request_hash,
                                decision_hash: result.decision_hash
                            });
                        } else {
                            appendReceipt(config.receiptLog, result.receipt);
                            response = { statusCode: 200, body: apiResponseFromReceipt(result.receipt) };
                        }
                    }
                }
            }
        } catch (error) {
            const reasonCode = error.code === REASONS.bodyTooLarge ? REASONS.bodyTooLarge : error.code === "ENOENT" ? REASONS.receiptPersistence : REASONS.runtimeError;
            response = refusal(reasonCode, 500, { request_id: requestId });
            log({ event: "mnde.error", request_id: requestId, decision: "REFUSE", reason_code: response.body.reason_code, error: error.message });
        }

        recordDecision(metrics, response.body.decision, response.body.reason_code);
        log({
            event: "mnde.decision",
            request_id: response.body.request_id ?? requestId,
            decision: response.body.decision,
            reason_code: response.body.reason_code,
            request_hash: response.body.request_hash,
            prevented_cost: response.body.prevented_cost_usd
        });
        writeJson(res, response.statusCode, response.body);
    });

    server.on("error", (error) => {
        state = STARTUP_STATE.FAIL_CLOSED;
        const reasonCode = error.code === "EADDRINUSE" || error.code === "EACCES" ? REASONS.portBindFailed : REASONS.runtimeError;
        log({ event: "mnde.startup", decision: "REFUSE", reason_code: reasonCode, bind_addr: `${config.bind.host}:${config.bind.port}`, error: error.message });
        process.exit(1);
    });

    const shutdown = (signal) => {
        state = STARTUP_STATE.FAIL_CLOSED;
        log({ event: "mnde.shutdown", decision: "REFUSE", reason_code: "OK_SHUTDOWN", signal });
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    server.listen(config.bind.port, config.bind.host, () => {
        log({
            event: "mnde.startup",
            decision: "ALLOW",
            reason_code: "OK_READY",
            bind_addr: `${config.bind.host}:${config.bind.port}`,
            policy_hash: policyState.policy_hash,
            receipt_log: config.receiptLog,
            sidecar_log: config.sidecarLog
        });
    });
}

void main().catch((error) => {
    state = STARTUP_STATE.FAIL_CLOSED;
    log({ event: "mnde.fatal", decision: "REFUSE", reason_code: REASONS.runtimeError, error: error.message });
    process.exit(1);
});
