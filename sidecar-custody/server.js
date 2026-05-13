import http from "node:http";
import { createHash, createPublicKey, verify } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanForbiddenContent } from "../shared/forbidden_content.js";
import { assertReleaseIntegrity } from "../release/verify-release.js";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_BIND = "127.0.0.1:8787";
const DEFAULT_RUNTIME_DIR = "C:\\mnde-runtime";
const POLICY = Object.freeze({
  version: "sidecar-custody-policy.v1",
  max_gpu_count: 4,
  max_hours: 8,
  max_total_cost_cents: 50000,
  max_retries: 2
});
const SUPPORTED_SIGNER_MODES = new Set(["external_http", "aws_kms", "azure_key_vault", "gcp_cloud_kms", "offline_operator"]);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const ERR_INTERNAL_SIGNING_DISABLED = "ERR_INTERNAL_SIGNING_DISABLED";

function parseFlag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 || index === argv.length - 1 ? null : argv[index + 1];
}

function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return "null";
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");
}

function publicKeyObjectFromRawHex(publicKeyHex) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
    format: "der",
    type: "spki"
  });
}

function parseBind(bind) {
  const [host, portText] = String(bind).split(":");
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("runtime.bind must be host:port");
  return { host, port };
}

function typedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function internalSigningDisabled() {
  throw typedError(ERR_INTERNAL_SIGNING_DISABLED, ERR_INTERNAL_SIGNING_DISABLED);
}

function readJsonNoBom(filePath) {
  const text = readFileSync(filePath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) throw typedError("ERR_CUSTODY_SIGNER_CONFIG_MALFORMED", "BOM is not allowed");
  return JSON.parse(text);
}

export function validateCustodySignerConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw typedError("ERR_CUSTODY_SIGNER_CONFIG_MALFORMED", "config must be an object");
  if (typeof config.key_set_version !== "string" || config.key_set_version.length === 0) throw typedError("ERR_UNKNOWN_KEY_SET_VERSION", "key_set_version is required");
  if (!Array.isArray(config.signers)) throw typedError("ERR_CUSTODY_SIGNER_CONFIG_MALFORMED", "signers must be an array");
  if (!Number.isSafeInteger(config.threshold) || config.threshold < 1) throw typedError("ERR_CUSTODY_SIGNER_CONFIG_MALFORMED", "threshold must be >= 1");

  const ids = new Set();
  const keys = new Set();
  let enabled = 0;
  for (const signer of config.signers) {
    if (!signer || typeof signer !== "object") throw typedError("ERR_CUSTODY_SIGNER_CONFIG_MALFORMED", "signer must be an object");
    if (typeof signer.id !== "string" || signer.id.length === 0) throw typedError("ERR_UNKNOWN_SIGNER", "signer id is required");
    if (ids.has(signer.id)) throw typedError("ERR_DUPLICATE_SIGNER_ID", "signer ids must be unique");
    ids.add(signer.id);
    if (!SUPPORTED_SIGNER_MODES.has(signer.mode)) throw typedError("ERR_UNKNOWN_SIGNER_MODE", "unknown signer mode");
    if (typeof signer.public_key !== "string" || !/^[0-9a-fA-F]{64}$/.test(signer.public_key)) throw typedError("ERR_MISSING_PUBLIC_KEY", "valid public_key is required");
    const key = signer.public_key.toLowerCase();
    if (keys.has(key)) throw typedError("ERR_DUPLICATE_PUBLIC_KEY", "duplicate public keys are not allowed");
    keys.add(key);
    if (signer.mode === "external_http" && (typeof signer.endpoint !== "string" || signer.endpoint.length === 0)) throw typedError("ERR_MISSING_SIGNER_ENDPOINT", "external_http endpoint is required");
    if (!Number.isSafeInteger(signer.timeout_ms) || !Number.isSafeInteger(signer.latency_slo_ms) || !Number.isSafeInteger(signer.latency_target_ms)) {
      throw typedError("ERR_CUSTODY_SIGNER_CONFIG_MALFORMED", "latency and timeout fields must be integers");
    }
    if (!(signer.timeout_ms > signer.latency_slo_ms)) throw typedError("ERR_CUSTODY_SIGNER_CONFIG_MALFORMED", "timeout_ms must be greater than latency_slo_ms");
    if (!(signer.latency_slo_ms > signer.latency_target_ms)) throw typedError("ERR_CUSTODY_SIGNER_CONFIG_MALFORMED", "latency_slo_ms must be greater than latency_target_ms");
    if (signer.enabled === true) enabled += 1;
  }
  if (enabled < config.threshold) throw typedError("ERR_CUSTODY_SIGNER_THRESHOLD_UNMET", "enabled signers must be >= threshold");
  return config;
}

function loadCustodySignerConfig(configPath) {
  if (!configPath || !existsSync(configPath)) throw typedError("ERR_CUSTODY_SIGNER_CONFIG_MISSING", "customer custody signer config is required");
  const parsed = validateCustodySignerConfig(readJsonNoBom(configPath));
  return { config: parsed, hash: sha256(parsed), path: path.resolve(configPath) };
}

function enabledSigner(config, signerId = null) {
  const signer = config.signers.find((candidate) => candidate.enabled === true && (!signerId || candidate.id === signerId));
  if (!signer) throw typedError("ERR_UNKNOWN_SIGNER", "no enabled signer resolved");
  return signer;
}

function ensureRuntime(runtimeDir) {
  for (const child of ["receipts", "logs"]) mkdirSync(path.join(runtimeDir, child), { recursive: true });
  return {
    runtimeDir,
    receiptsPath: path.join(runtimeDir, "receipts", "receipts.jsonl"),
    logPath: path.join(runtimeDir, "logs", "sidecar.log")
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).byteLength > 1024 * 1024) throw typedError("ERR_BODY_TOO_LARGE", "body too large");
  }
  return Buffer.concat(chunks).toString("utf8");
}

function numberFrom(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function decide(request) {
  const resources = request.resources ?? request.execution_request?.resources ?? {};
  const execution = request.execution ?? request.execution_request?.execution ?? {};
  const runtime = request.runtime_observation ?? request.execution_request?.runtime_observation ?? {};
  const pricing = request.pricing_data ?? {};
  const gpuCount = numberFrom(resources.gpu_count, request.gpu_count, runtime.actual_gpu_count);
  const hours = numberFrom(resources.hours, request.hours, runtime.actual_hours);
  const retries = numberFrom(execution.max_retries, request.max_retries);
  const totalCost = numberFrom(runtime.actual_total_cost_cents, request.total_cost_cents, gpuCount * hours * numberFrom(pricing.gpu_hour_cents, 500));
  if (gpuCount > POLICY.max_gpu_count) return { decision: "REFUSE", reason: "ERR_GPU_LIMIT" };
  if (hours > POLICY.max_hours) return { decision: "REFUSE", reason: "ERR_HOURS_LIMIT" };
  if (retries > POLICY.max_retries) return { decision: "REFUSE", reason: "ERR_RETRY_LIMIT" };
  if (totalCost > POLICY.max_total_cost_cents) return { decision: "REFUSE", reason: "ERR_TOTAL_COST_LIMIT" };
  return { decision: "ALLOW", reason: "OK_ALLOW" };
}

function buildUnsignedReceipt({ requestHash, decisionHash, outcome, configState, signer }) {
  return {
    receipt_schema_version: "mnde.sidecar_custody.receipt.v1",
    request_hash: requestHash,
    decision_hash: decisionHash,
    decision: outcome.decision,
    reason: outcome.reason,
    policy_version: POLICY.version,
    key_set_version: configState.config.key_set_version,
    signer_id: signer.id,
    signer_mode: signer.mode,
    custody_config_hash: configState.hash,
    signature_algorithm: "ED25519"
  };
}

function verifySignature(publicKey, payload, signatureHex) {
  return verify(null, Buffer.from(canonicalize(payload), "utf8"), publicKeyObjectFromRawHex(publicKey), Buffer.from(signatureHex, "hex"));
}

async function callExternalSigner(signer, payload, context) {
  if (signer.mode !== "external_http") throw typedError("ERR_CUSTODY_SIGNER_UNAVAILABLE", `${signer.mode} signing is not available in this sidecar runtime`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), signer.timeout_ms);
  try {
    const response = await fetch(signer.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload,
        canonical_payload: canonicalize(payload),
        signer_id: signer.id,
        key_set_version: context.key_set_version,
        custody_config_hash: context.custody_config_hash
      }),
      signal: controller.signal
    });
    if (!response.ok) throw typedError("ERR_CUSTODY_SIGNER_UNAVAILABLE", `signer status ${response.status}`);
    const body = await response.json();
    if (body.signer_id !== signer.id) throw typedError("ERR_UNKNOWN_SIGNER", "signer response id mismatch");
    if (body.key_set_version !== context.key_set_version) throw typedError("ERR_UNKNOWN_KEY_SET_VERSION", "signer key set mismatch");
    if (body.signature_algorithm !== "ED25519") throw typedError("ERR_CUSTODY_SIGNATURE_INVALID", "unsupported signature algorithm");
    if (typeof body.signature !== "string" || !/^[0-9a-fA-F]+$/.test(body.signature)) throw typedError("ERR_CUSTODY_SIGNATURE_INVALID", "signature missing or malformed");
    if (!verifySignature(signer.public_key, payload, body.signature)) throw typedError("ERR_CUSTODY_SIGNATURE_VERIFY_FAILED", "signature verification failed");
    return body.signature;
  } catch (error) {
    if (error.name === "AbortError") throw typedError("ERR_CUSTODY_SIGNER_TIMEOUT", "custody signer timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function signCustomerReceipt(configState, payload, signerId = null) {
  const signer = enabledSigner(configState.config, signerId);
  const signature = await callExternalSigner(signer, payload, {
    key_set_version: configState.config.key_set_version,
    custody_config_hash: configState.hash
  });
  return { ...payload, signer_id: signer.id, signer_mode: signer.mode, signature };
}

function appendReceipt(runtime, receipt) {
  appendFileSync(runtime.receiptsPath, `${JSON.stringify(receipt)}\n`, "utf8");
}

function appendLog(runtime, event) {
  appendFileSync(runtime.logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, "utf8");
}

function startup({ runtimeDir, signerConfigPath }) {
  const integrity = assertReleaseIntegrity();
  const forbidden = scanForbiddenContent(PACKAGE_ROOT);
  if (forbidden.length > 0) throw typedError("ERR_FORBIDDEN_ARTIFACT_PRESENT", "forbidden artifact present");
  try {
    internalSigningDisabled();
  } catch (error) {
    if (error.code !== ERR_INTERNAL_SIGNING_DISABLED) throw error;
  }
  const runtime = ensureRuntime(runtimeDir);
  const configState = loadCustodySignerConfig(signerConfigPath);
  appendLog(runtime, { event: "startup", decision: "ALLOW", integrity: integrity.verdict, custody_config_hash: configState.hash });
  return { runtime, configState };
}

function sendJson(res, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  res.writeHead(status, { "content-type": "application/json", "content-length": body.byteLength });
  res.end(body);
}

async function handleDecision(request, state) {
  const outcome = decide(request);
  const requestHash = sha256(request);
  const decisionHash = sha256({ request_hash: requestHash, decision: outcome.decision, reason: outcome.reason, policy_version: POLICY.version });
  const signer = enabledSigner(state.configState.config, request.signer_id ?? null);
  const unsigned = buildUnsignedReceipt({ requestHash, decisionHash, outcome, configState: state.configState, signer });
  const receipt = await signCustomerReceipt(state.configState, unsigned, signer.id);
  appendReceipt(state.runtime, receipt);
  return {
    decision: outcome.decision,
    reason: outcome.reason,
    policy_version: POLICY.version,
    request_hash: requestHash,
    decision_hash: decisionHash,
    custody_config_hash: state.configState.hash,
    receipt,
    receipt_log: state.runtime.receiptsPath,
    signer_config: state.configState.path
  };
}

async function handleSignerFailure(request, state, error) {
  const requestHash = sha256(request);
  const outcome = { decision: "REFUSE", reason: error.code ?? "ERR_CUSTODY_SIGNER_UNAVAILABLE" };
  const decisionHash = sha256({ request_hash: requestHash, decision: outcome.decision, reason: outcome.reason, policy_version: POLICY.version });
  const receipt = {
    receipt_schema_version: "mnde.sidecar_custody.receipt.v1",
    request_hash: requestHash,
    decision_hash: decisionHash,
    decision: "REFUSE",
    reason: outcome.reason,
    policy_version: POLICY.version,
    key_set_version: state.configState.config.key_set_version,
    signer_id: null,
    signer_mode: null,
    custody_config_hash: state.configState.hash,
    signature_algorithm: "ED25519",
    signature: null
  };
  appendReceipt(state.runtime, receipt);
  appendLog(state.runtime, { event: "custody.signer_failure", reason: outcome.reason });
  return { ...outcome, request_hash: requestHash, decision_hash: decisionHash, custody_config_hash: state.configState.hash, receipt };
}

export function startServer(options = {}) {
  const runtimeDir = options.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const signerConfigPath = options.signerConfigPath ?? process.env.MNDE_CUSTODY_SIGNER_CONFIG ?? path.join(runtimeDir, "custody.signers.json");
  const bind = parseBind(options.bind ?? DEFAULT_BIND);
  const state = startup({ runtimeDir, signerConfigPath });
  const startedAt = new Date().toISOString();
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && (pathname === "/healthz" || pathname === "/readyz")) {
      sendJson(res, 200, {
        ok: true,
        ready: true,
        startup_state: "READY",
        started_at: startedAt,
        runtime_dir: state.runtime.runtimeDir,
        custody_config_hash: state.configState.hash
      });
      return;
    }
    if (req.method === "POST" && pathname === "/v1/decisions") {
      let request = {};
      try {
        const raw = await readBody(req);
        request = raw.trim().length === 0 ? {} : JSON.parse(raw);
        sendJson(res, 200, await handleDecision(request, state));
      } catch (error) {
        sendJson(res, 200, await handleSignerFailure(request, state, error));
      }
      return;
    }
    sendJson(res, 404, { ok: false, reason: "ERR_NOT_FOUND" });
  });
  server.on("error", (error) => {
    process.stderr.write(`${JSON.stringify({ verdict: "REFUSE", code: error.code ?? "ERR_SERVICE_START_FAILED", error: error.message })}\n`);
    process.exit(1);
  });
  server.listen(bind.port, bind.host);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const runtimeDir = parseFlag(process.argv, "--runtime-dir") ?? process.env.MNDE_RUNTIME_DIR ?? DEFAULT_RUNTIME_DIR;
    const bind = parseFlag(process.argv, "--bind") ?? process.env.MNDE_BIND_ADDR ?? DEFAULT_BIND;
    const signerConfigPath = parseFlag(process.argv, "--signer-config") ?? process.env.MNDE_CUSTODY_SIGNER_CONFIG ?? path.join(runtimeDir, "custody.signers.json");
    startServer({ runtimeDir, bind, signerConfigPath });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ verdict: "REFUSE", code: error.code ?? "ERR_STARTUP_REFUSED", error: error.message })}\n`);
    process.exit(1);
  }
}
