import type { AppSettings, DecisionEvent, HealthItem, ResourceMetrics, TelemetryState, TopMetrics, VerificationState, VerifyResult } from "../types";

export class EndpointUnsupportedError extends Error {
  constructor(path: string) {
    super(`Unsupported endpoint: ${path}`);
    this.name = "EndpointUnsupportedError";
  }
}

export class EndpointUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointUnavailableError";
  }
}

export interface SidecarSnapshot {
  telemetry: TelemetryState;
  logs: string[];
}

export interface LiveEndpointStatus {
  healthOk: boolean;
  readyOk: boolean;
  metricsOk: boolean;
  receiptsOk: boolean;
  hasRefusal: boolean;
}

export function deriveLiveConnectionState(status: LiveEndpointStatus): TelemetryState["liveConnectionState"] {
  if (status.healthOk && status.readyOk && status.metricsOk) return "CONNECTED";
  if (status.healthOk || status.readyOk || status.metricsOk || status.receiptsOk) return "DEGRADED";
  return "DISCONNECTED";
}

export async function fetchLiveSnapshot(settings: AppSettings): Promise<SidecarSnapshot> {
  const logs: string[] = [];
  const observedAt = Date.now();
  const [health, ready, metrics, receipts] = await Promise.allSettled([
    getJson(settings, "/healthz"),
    getJson(settings, "/readyz"),
    getJson(settings, "/metrics"),
    getJson(settings, `/receipts/recent?limit=${settings.receiptLimit}`)
  ]);

  const healthOk = health.status === "fulfilled";
  const readyOk = ready.status === "fulfilled";
  const metricsOk = metrics.status === "fulfilled";
  const receiptsOk = receipts.status === "fulfilled";
  const unsupported = [health, ready, metrics, receipts].some((result) => result.status === "rejected" && result.reason instanceof EndpointUnsupportedError);

  for (const [name, result] of [["healthz", health], ["readyz", ready], ["metrics", metrics], ["receipts", receipts]] as const) {
    if (result.status === "rejected") logs.push(`${name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  }

  if (!healthOk && !readyOk && !metricsOk && !receiptsOk) {
    throw unsupported ? new EndpointUnsupportedError("/healthz /readyz /metrics /receipts/recent") : new EndpointUnavailableError("MNDe sidecar disconnected.");
  }

  const events = receiptsOk ? normalizeReceipts(receipts.value) : [];
  const latestRefusal = events.find((event) => event.verdict === "REFUSE");
  const metricsPayload = metricsOk ? metrics.value : undefined;
  const metricValues = metricsOk ? normalizeMetrics(metricsPayload, events) : fallbackMetrics(events);
  const healthItems = normalizeHealth(healthOk ? health.value : undefined, readyOk ? ready.value : undefined, metricsOk);
  const liveConnectionState = deriveLiveConnectionState({ healthOk, readyOk, metricsOk, receiptsOk, hasRefusal: Boolean(latestRefusal) });
  const statusMessage = liveConnectionState === "CONNECTED"
    ? receiptsOk
      ? "MNDe sidecar connected."
      : "MNDe sidecar connected. Receipt history endpoint unavailable."
    : "Some sidecar endpoints are unavailable.";

  return {
    logs,
    telemetry: {
      mode: "live",
      systemState: liveConnectionState === "REFUSING" ? "REFUSING" : liveConnectionState === "CONNECTED" ? "ACTIVE" : "DEGRADED",
      liveConnectionState,
      connectionState: liveConnectionState === "CONNECTED" ? "MNDe sidecar connected." : "MNDe sidecar connected with unavailable endpoints.",
      metrics: { ...metricValues, sidecarConnectionState: liveConnectionState },
      resources: normalizeResources(metricsOk ? metrics.value : undefined, events.length),
      health: healthItems,
      events,
      latestRefusal,
      statusMessage,
      proof: {
        lastSidecarContactMs: observedAt,
        lastSignerHeartbeatMs: metricsOk ? observedAt : undefined,
        lastPolicyVerificationMs: readyOk ? observedAt : undefined,
        lastReplayVerificationMs: receiptsOk && events.some((event) => event.replay_status !== "UNAVAILABLE" && event.replay_status !== "NOT_REPORTED") ? observedAt : undefined,
        receiptPersistenceLagMs: receiptsOk ? 0 : undefined,
        runtimeTelemetryAgeMs: 0,
        healthEndpointOk: healthOk,
        readyEndpointOk: readyOk,
        metricsEndpointOk: metricsOk,
        receiptsEndpointOk: receiptsOk
      },
      integrity: {
        activeKeySetFingerprint: readString(metricsPayload, ["active_key_set_fingerprint", "jwks_fingerprint"]),
        signerKeyId: readString(metricsPayload, ["signer_key_id", "kid"]) ?? events.find((event) => event.signer_key_id)?.signer_key_id,
        receiptChainContinuity: aggregateVerification(events.map((event) => event.receipt_chain_status ?? "UNAVAILABLE")),
        policySignatureStatus: normalizeVerificationState(readString(metricsPayload, ["policy_signature_status"]) ?? "NOT_REPORTED"),
        receiptSignatureValidity: aggregateVerification(events.map((event) => event.signature_status)),
        replayReproducibilityState: aggregateVerification(events.map((event) => event.replay_status)),
        jwksFreshnessMs: metricsPayload && typeof metricsPayload === "object" ? readNumber(metricsPayload as Record<string, unknown>, ["jwks_freshness_ms", "key_freshness_ms"]) : undefined,
        signerLatencyPosture: metricValues.signerStatus
      }
    }
  };
}

export async function verifyReceipt(settings: AppSettings, receipt: DecisionEvent): Promise<VerifyResult> {
  try {
    const response = await postJson(settings, "/receipts/verify", { receipt: receipt.raw_receipt ?? { receipt_id: receipt.receipt_id } });
    const state = normalizeVerificationState(readString(response, ["state", "status", "result"]) ?? "VALID");
    return { state, message: state === "UNAVAILABLE" ? "Verification endpoint unavailable." : `Verification result: ${state}`, checkedAt: new Date().toLocaleTimeString() };
  } catch (error) {
    if (error instanceof EndpointUnsupportedError) {
      return { state: "UNAVAILABLE", message: "Verification endpoint unavailable.", checkedAt: new Date().toLocaleTimeString() };
    }
    return { state: "UNAVAILABLE", message: error instanceof Error ? error.message : "Verification unavailable.", checkedAt: new Date().toLocaleTimeString() };
  }
}

export async function replayRecent(settings: AppSettings, limit = 100): Promise<Record<string, unknown>> {
  return await postJson(settings, "/replay/recent", { limit }) as Record<string, unknown>;
}

export async function getCurrentPolicy(settings: AppSettings): Promise<Record<string, unknown>> {
  return await getJson(settings, "/policy/current") as Record<string, unknown>;
}

export async function activatePolicy(settings: AppSettings, policyPath: string): Promise<Record<string, unknown>> {
  return await postJson(settings, "/policy/activate", { policy_path: policyPath }) as Record<string, unknown>;
}

export async function generateAuditBundle(settings: AppSettings): Promise<Record<string, unknown>> {
  return await postJson(settings, "/audit/bundle", {}) as Record<string, unknown>;
}

async function getJson(settings: AppSettings, path: string): Promise<unknown> {
  return requestJson(settings, path, { method: "GET" });
}

async function postJson(settings: AppSettings, path: string, body: unknown): Promise<unknown> {
  return requestJson(settings, path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

async function requestJson(settings: AppSettings, path: string, init: RequestInit): Promise<unknown> {
  if (isTauriRuntime()) {
    return requestJsonViaDesktop(settings, path, init);
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), settings.requestTimeoutMs);
  try {
    const response = await fetch(`${settings.sidecarEndpoint}${path}`, { ...init, signal: controller.signal });
    if (response.status === 404 || response.status === 405) throw new EndpointUnsupportedError(path);
    if (!response.ok) throw new EndpointUnavailableError(`${path} returned HTTP ${response.status}`);
    const text = await response.text();
    return parseResponsePayload(path, text);
  } catch (error) {
    if (error instanceof EndpointUnsupportedError || error instanceof EndpointUnavailableError) throw error;
    throw new EndpointUnavailableError(`${path} unavailable`);
  } finally {
    window.clearTimeout(timeout);
  }
}

async function requestJsonViaDesktop(settings: AppSettings, path: string, init: RequestInit): Promise<unknown> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const response = await invoke<{ status: number; body: string }>("sidecar_request", {
      endpoint: settings.sidecarEndpoint,
      path,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : ""
    });
    if (response.status === 404 || response.status === 405) throw new EndpointUnsupportedError(path);
    if (response.status < 200 || response.status >= 300) throw new EndpointUnavailableError(`${path} returned HTTP ${response.status}`);
    return parseResponsePayload(path, response.body);
  } catch (error) {
    if (error instanceof EndpointUnsupportedError || error instanceof EndpointUnavailableError) throw error;
    throw new EndpointUnavailableError(`${path} unavailable`);
  }
}

function parseResponsePayload(path: string, text: string): unknown {
  if (!text.trim()) return {};
  if (path === "/metrics") return normalizePrometheusMetrics(text);
  return JSON.parse(text);
}

export function normalizeReceipts(input: unknown): DecisionEvent[] {
  const list = Array.isArray(input) ? input : Array.isArray((input as { receipts?: unknown })?.receipts) ? (input as { receipts: unknown[] }).receipts : [];
  return list.map((raw, index) => normalizeReceipt(raw, index)).filter(Boolean) as DecisionEvent[];
}

function normalizeReceipt(raw: unknown, index: number): DecisionEvent {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const verdict = normalizeVerdict(readString(source, ["verdict", "decision", "result"]) ?? "ALLOW");
  return {
    id: readString(source, ["id", "receipt_id"]) ?? `live-${index}`,
    timestamp: normalizeTimestamp(readString(source, ["timestamp", "time", "created_at"])),
    verdict,
    action: readString(source, ["action", "action_summary", "command"]) ?? "unreported action",
    reason_code: readString(source, ["reason_code", "reason", "code"]) ?? "UNREPORTED",
    explanation: readString(source, ["explanation", "summary", "message"]) ?? "No explanation reported by sidecar.",
    risk_level: normalizeRisk(readString(source, ["risk_level", "risk"])),
    receipt_id: readString(source, ["receipt_id", "id"]) ?? `live-${index}`,
    policy: readString(source, ["policy", "policy_source"]) ?? "not reported",
    policy_hash: readString(source, ["policy_hash"]) ?? "not reported",
    prevented_impact: readString(source, ["prevented_impact", "impact_estimate", "impact"]) ?? (readNumber(source, ["prevented_cost_usd"]) !== undefined ? `$${readNumber(source, ["prevented_cost_usd"])?.toFixed(2)}` : "not reported"),
    prevented_cost_usd: readNumber(source, ["prevented_cost_usd"]),
    signer_latency_ms: readNumber(source, ["signer_latency_ms"]) ?? 0,
    queue_pressure: readNumber(source, ["queue_pressure"]) ?? 0,
    replay_drift: readNumber(source, ["replay_drift"]) ?? 0,
    worker_saturation: readNumber(source, ["worker_saturation"]) ?? 0,
    command_preview: readString(source, ["command_preview", "command", "action"]) ?? "not reported",
    request_hash: readString(source, ["request_hash"]) ?? "not reported",
    decision_hash: readString(source, ["decision_hash"]) ?? "not reported",
    canonical_payload_hash: readString(source, ["canonical_payload_hash", "canonical_hash"]) ?? "not reported",
    signature_status: normalizeVerificationState(readString(source, ["signature_status"]) ?? "UNAVAILABLE"),
    replay_status: normalizeVerificationState(readString(source, ["replay_status"]) ?? "UNAVAILABLE"),
    policy_source: readString(source, ["policy_source"]) ?? "not reported",
    raw_receipt: (source.raw && typeof source.raw === "object") ? source.raw : raw,
    signer_key_id: readString(source, ["signer_key_id", "kid"]),
    receipt_chain_status: normalizeVerificationState(readString(source, ["receipt_chain_status", "chain_status"]) ?? "UNAVAILABLE")
  };
}

function aggregateVerification(values: VerificationState[]): VerificationState {
  if (values.length === 0) return "NOT_REPORTED";
  if (values.some((value) => value === "SIGNATURE_FAIL" || value === "INVALID")) return "INVALID";
  if (values.some((value) => value === "DRIFT")) return "DRIFT";
  if (values.every((value) => value === "VALID")) return "VALID";
  return "NOT_REPORTED";
}

export function normalizePrometheusMetrics(input: string): TopMetrics {
  const values = new Map<string, number>();
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [name, value] = trimmed.split(/\s+/, 2);
    const numeric = Number(value);
    if (name && Number.isFinite(numeric)) values.set(name, numeric);
  }

  const decisions = values.get("mnde_decisions_total") ?? 0;
  return {
    policyName: "policy.v1",
    policyHash: "reported by /readyz",
    signerStatus: "Healthy",
    signerLatencyMs: 0,
    uptime: "not reported",
    decisionsPerSecond: decisions,
    allows: values.get("mnde_decisions_allowed_total") ?? 0,
    refuses: values.get("mnde_decisions_refused_total") ?? 0,
    replayDrift: 0,
    queuePressure: 0,
    workerSaturation: 0,
    sidecarConnectionState: "CONNECTED"
  };
}

function normalizeMetrics(input: unknown, events: DecisionEvent[]): TopMetrics {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    policyName: readString(source, ["policy_name", "policyName"]) ?? "not reported",
    policyHash: readString(source, ["policy_hash", "policyHash"]) ?? "not reported",
    signerStatus: normalizeHealthState(readString(source, ["signer_status", "signerStatus"])),
    signerLatencyMs: readNumber(source, ["signer_latency_ms", "signerLatencyMs"]) ?? 0,
    uptime: readString(source, ["uptime"]) ?? "not reported",
    decisionsPerSecond: readNumber(source, ["decisions_per_second", "decisionsPerSecond"]) ?? events.length,
    allows: readNumber(source, ["allows"]) ?? events.filter((event) => event.verdict === "ALLOW").length,
    refuses: readNumber(source, ["refuses"]) ?? events.filter((event) => event.verdict === "REFUSE").length,
    replayDrift: readNumber(source, ["replay_drift", "replayDrift"]) ?? 0,
    queuePressure: readNumber(source, ["queue_pressure", "queuePressure"]) ?? 0,
    workerSaturation: readNumber(source, ["worker_saturation", "workerSaturation"]) ?? 0,
    sidecarConnectionState: "CONNECTED"
  };
}

function fallbackMetrics(events: DecisionEvent[]): TopMetrics {
  return {
    policyName: "unavailable",
    policyHash: "unavailable",
    signerStatus: "Warning",
    signerLatencyMs: 0,
    uptime: "unavailable",
    decisionsPerSecond: 0,
    allows: events.filter((event) => event.verdict === "ALLOW").length,
    refuses: events.filter((event) => event.verdict === "REFUSE").length,
    replayDrift: 0,
    queuePressure: 0,
    workerSaturation: 0,
    sidecarConnectionState: "DEGRADED"
  };
}

function normalizeHealth(health: unknown, ready: unknown, metricsOk: boolean): HealthItem[] {
  const healthy = Boolean((health as { ok?: unknown })?.ok ?? health);
  const readyOk = Boolean((ready as { ok?: unknown })?.ok ?? ready);
  return [
    { name: "API", state: healthy ? "Healthy" : "Warning", latencyMs: 0 },
    { name: "Parser (MCJ-1)", state: readyOk ? "Healthy" : "Warning", latencyMs: 0 },
    { name: "Policy Engine", state: readyOk ? "Healthy" : "Warning", latencyMs: 0 },
    { name: "Signer", state: metricsOk ? "Healthy" : "Warning", latencyMs: 0 },
    { name: "Storage", state: readyOk ? "Healthy" : "Warning", latencyMs: 0 }
  ];
}

function normalizeResources(metrics: unknown, throughput: number): ResourceMetrics {
  const source = (metrics && typeof metrics === "object" ? metrics : {}) as Record<string, unknown>;
  return {
    cpu: readNumber(source, ["cpu"]) ?? 0,
    memory: readNumber(source, ["memory"]) ?? 0,
    diskIo: readNumber(source, ["disk_io", "diskIo"]) ?? 0,
    decisionThroughput: readNumber(source, ["decision_throughput", "decisionThroughput"]) ?? throughput
  };
}

function readString(source: Record<string, unknown> | unknown, keys: string[]): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const object = source as Record<string, unknown>;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function readNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeVerdict(value: string): DecisionEvent["verdict"] {
  const upper = value.toUpperCase();
  if (upper.includes("REFUSE") || upper.includes("DENY") || upper.includes("BLOCK")) return "REFUSE";
  if (upper.includes("WARN")) return "POLICY WARN";
  if (upper.includes("REPLAY")) return "REPLAY";
  return "ALLOW";
}

function normalizeRisk(value?: string) {
  const upper = value?.toUpperCase();
  if (upper === "CRITICAL") return "CRITICAL";
  if (upper === "HIGH") return "HIGH";
  if (upper === "MEDIUM") return "MEDIUM";
  return "LOW";
}

function normalizeVerificationState(value: string): VerificationState {
  const upper = value.toUpperCase();
  if (upper === "VALID") return "VALID";
  if (upper === "INVALID") return "INVALID";
  if (upper === "DRIFT") return "DRIFT";
  if (upper === "SIGNATURE_FAIL") return "SIGNATURE_FAIL";
  if (upper === "UNKNOWN") return "UNKNOWN";
  if (upper === "NOT_REPORTED") return "NOT_REPORTED";
  return "UNAVAILABLE";
}

function normalizeHealthState(value?: string) {
  const upper = value?.toUpperCase();
  if (upper === "FAILED") return "Failed";
  if (upper === "WARNING" || upper === "DEGRADED") return "Warning";
  return "Healthy";
}

function normalizeTimestamp(value?: string) {
  if (!value) return new Date().toLocaleTimeString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
