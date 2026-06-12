import type { DecisionEvent, VerificationState } from "../types";

export type LiveDemoStatus = "idle" | "starting" | "running" | "complete" | "failed";
export type LiveDemoVerdict = "PENDING" | "PASS" | "FAIL";

export interface LiveDemoAuthority {
  issuer: string;
  audience: string;
  role: string;
  capabilities: string[];
  nonce: string;
  expires_at: string;
  replay_state: string;
  signature_verification: VerificationState;
}

export interface LiveDemoEvent {
  id: string;
  name?: string;
  timestamp: string;
  endpoint: string;
  decision: "ALLOW" | "REFUSE" | "REPLAY";
  reason_code: string;
  request_hash: string;
  decision_hash: string;
  source: "http" | "receipt" | "replay" | "startup";
  real: boolean;
  status?: number;
  receipt_id?: string;
  replay_status?: string;
  actor_role?: string;
  capability?: string;
}

export interface LiveDemoReplay {
  status: string;
  drift: number;
  deterministic_parity: boolean;
  signature_validation: VerificationState;
  receipt_verification: VerificationState;
}

export interface LiveDemoFinal {
  hostile_verification: LiveDemoVerdict;
  rbac_enforcement: LiveDemoVerdict;
  replay_protection: LiveDemoVerdict;
  signature_verification: LiveDemoVerdict;
  deterministic_replay: LiveDemoVerdict;
  verdict: LiveDemoVerdict;
}

export interface LiveDemoEvidence {
  mode: "live-demo";
  status: LiveDemoStatus;
  verdict: LiveDemoVerdict;
  updated_at?: string;
  authority?: LiveDemoAuthority;
  events: LiveDemoEvent[];
  replay?: LiveDemoReplay;
  final?: LiveDemoFinal;
}

export interface LiveDemoOverlay {
  evidence?: LiveDemoEvidence;
  events: DecisionEvent[];
  authority?: LiveDemoAuthority;
  replay?: LiveDemoReplay;
  final?: LiveDemoFinal;
}

export function isLiveDemoRequested(locationSearch = globalThis.location?.search ?? ""): boolean {
  return new URLSearchParams(locationSearch).get("liveDemo") === "1";
}

export async function fetchLiveDemoEvidence(): Promise<LiveDemoEvidence | undefined> {
  const response = await fetch(`http://127.0.0.1:8789/live-demo-events.json?ts=${Date.now()}`, { cache: "no-store" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`live demo evidence HTTP ${response.status}`);
  return normalizeLiveDemoEvidence(await response.json());
}

export function normalizeLiveDemoEvidence(input: unknown): LiveDemoEvidence {
  const source = object(input);
  const events = Array.isArray(source.events) ? source.events.map(normalizeLiveDemoEvent).filter(Boolean) as LiveDemoEvent[] : [];
  return {
    mode: "live-demo",
    status: normalizeStatus(stringValue(source.status) ?? "idle"),
    verdict: normalizeVerdict(stringValue(source.verdict) ?? "PENDING"),
    updated_at: stringValue(source.updated_at),
    authority: normalizeAuthority(source.authority),
    events,
    replay: normalizeReplay(source.replay),
    final: normalizeFinal(source.final)
  };
}

export function buildLiveDemoOverlay(evidence?: LiveDemoEvidence): LiveDemoOverlay {
  if (!evidence) return { events: [] };
  return {
    evidence,
    events: evidence.events.map(demoEventToDecisionEvent),
    authority: evidence.authority,
    replay: evidence.replay,
    final: evidence.final
  };
}

function demoEventToDecisionEvent(event: LiveDemoEvent): DecisionEvent {
  const verdict = event.decision === "REPLAY" ? "REPLAY" : event.decision;
  const label = scenarioLabel(event.id, event.endpoint);
  return {
    id: `live-demo-${event.id}`,
    timestamp: normalizeTimestamp(event.timestamp),
    verdict,
    action: label.title,
    reason_code: event.reason_code,
    explanation: `${label.detail} - ${event.endpoint}`,
    risk_level: event.decision === "ALLOW" || event.decision === "REPLAY" ? "LOW" : "HIGH",
    receipt_id: event.receipt_id ?? "not reported",
    policy: "live-demo-policy",
    policy_hash: "reported by runtime",
    prevented_impact: event.decision === "REFUSE" ? "protected endpoint refused" : "not applicable",
    signer_latency_ms: 0,
    queue_pressure: 0,
    replay_drift: 0,
    worker_saturation: 0,
    command_preview: event.endpoint,
    request_hash: event.request_hash,
    decision_hash: event.decision_hash,
    canonical_payload_hash: event.request_hash,
    signature_status: event.decision === "REPLAY" ? "VALID" : event.reason_code === "ERR_AUTH_SIGNATURE_INVALID" ? "SIGNATURE_FAIL" : "VALID",
    replay_status: event.replay_status === "PASS" ? "VALID" : event.decision === "REPLAY" ? normalizeVerification(event.replay_status ?? "VALID") : "NOT_REPORTED",
    policy_source: event.real ? "live-demo://real-runtime" : "invalid",
    raw_receipt: event,
    receipt_chain_status: "NOT_REPORTED"
  };
}

function scenarioLabel(id: string, endpoint: string): { title: string; detail: string } {
  const labels: Record<string, { title: string; detail: string }> = {
    "forged-admin": { title: "Forged admin blocked", detail: "Caller-supplied admin context was ignored" },
    "unsigned-assertion": { title: "Unsigned assertion blocked", detail: "Authority without a valid signature was refused" },
    "tampered-capability": { title: "Tampered capability blocked", detail: "Changed claims failed signature verification" },
    "wrong-issuer": { title: "Wrong issuer blocked", detail: "Assertion issuer did not match MNDe desktop" },
    "wrong-audience": { title: "Wrong audience blocked", detail: "Assertion audience did not match MNDe sidecar" },
    "expired-assertion": { title: "Expired assertion blocked", detail: "Expired authority failed closed" },
    "replay-first-use": { title: "Replay cache primed", detail: "Valid nonce was accepted once" },
    "replay-attack": { title: "Replay attack blocked", detail: "Reused nonce was refused" },
    "recursive-delete": { title: "Recursive delete refused", detail: "Destructive filesystem request was stopped" },
    "runaway-retry": { title: "Runaway retry refused", detail: "Unbounded retry behavior was contained" },
    "unauthorized-outbound": { title: "Outbound action refused", detail: "Unauthorized external action was stopped" },
    "viewer-admin": { title: "Viewer admin attempt blocked", detail: "Viewer role lacked admin capability" },
    "valid-admin": { title: "Valid admin allowed", detail: "Signed admin authority reached protected action" },
    "decision-allow-receipt": { title: "Signed allow receipt", detail: "Runtime allowed a safe execution request" },
    "decision-refuse-receipt": { title: "Signed refusal receipt", detail: "Runtime refused a risky execution request" },
    "deterministic-replay": { title: "Replay verified", detail: "Replay completed with zero drift" }
  };
  return labels[id] ?? { title: endpoint, detail: "Live runtime evidence" };
}

function normalizeLiveDemoEvent(input: unknown): LiveDemoEvent | undefined {
  const source = object(input);
  const id = stringValue(source.id);
  const endpoint = stringValue(source.endpoint);
  const decision = stringValue(source.decision)?.toUpperCase();
  const reasonCode = stringValue(source.reason_code);
  if (!id || !endpoint || !reasonCode || !["ALLOW", "REFUSE", "REPLAY"].includes(decision ?? "")) return undefined;
  if (source.real !== true) return undefined;
  return {
    id,
    name: stringValue(source.name),
    timestamp: stringValue(source.timestamp) ?? new Date().toISOString(),
    endpoint,
    decision: decision as LiveDemoEvent["decision"],
    reason_code: reasonCode,
    request_hash: stringValue(source.request_hash) ?? "not reported",
    decision_hash: stringValue(source.decision_hash) ?? "not reported",
    source: normalizeSource(stringValue(source.source)),
    real: true,
    status: numberValue(source.status),
    receipt_id: stringValue(source.receipt_id),
    replay_status: stringValue(source.replay_status),
    actor_role: stringValue(source.actor_role),
    capability: stringValue(source.capability)
  };
}

function normalizeAuthority(input: unknown): LiveDemoAuthority | undefined {
  const source = object(input);
  const issuer = stringValue(source.issuer);
  const audience = stringValue(source.audience);
  const role = stringValue(source.role);
  if (!issuer || !audience || !role) return undefined;
  return {
    issuer,
    audience,
    role,
    capabilities: Array.isArray(source.capabilities) ? source.capabilities.filter((item): item is string => typeof item === "string") : [],
    nonce: stringValue(source.nonce) ?? "not reported",
    expires_at: stringValue(source.expires_at) ?? "not reported",
    replay_state: stringValue(source.replay_state) ?? "not reported",
    signature_verification: normalizeVerification(stringValue(source.signature_verification) ?? "NOT_REPORTED")
  };
}

function normalizeReplay(input: unknown): LiveDemoReplay | undefined {
  const source = object(input);
  const status = stringValue(source.status);
  if (!status) return undefined;
  return {
    status,
    drift: numberValue(source.drift) ?? 0,
    deterministic_parity: source.deterministic_parity === true,
    signature_validation: normalizeVerification(stringValue(source.signature_validation) ?? "NOT_REPORTED"),
    receipt_verification: normalizeVerification(stringValue(source.receipt_verification) ?? "NOT_REPORTED")
  };
}

function normalizeFinal(input: unknown): LiveDemoFinal | undefined {
  const source = object(input);
  if (!source.verdict) return undefined;
  return {
    hostile_verification: normalizeVerdict(stringValue(source.hostile_verification) ?? "PENDING"),
    rbac_enforcement: normalizeVerdict(stringValue(source.rbac_enforcement) ?? "PENDING"),
    replay_protection: normalizeVerdict(stringValue(source.replay_protection) ?? "PENDING"),
    signature_verification: normalizeVerdict(stringValue(source.signature_verification) ?? "PENDING"),
    deterministic_replay: normalizeVerdict(stringValue(source.deterministic_replay) ?? "PENDING"),
    verdict: normalizeVerdict(stringValue(source.verdict) ?? "PENDING")
  };
}

function object(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function stringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function normalizeStatus(value: string): LiveDemoStatus {
  const upper = value.toUpperCase();
  if (upper === "STARTING") return "starting";
  if (upper === "RUNNING") return "running";
  if (upper === "COMPLETE") return "complete";
  if (upper === "FAILED") return "failed";
  return "idle";
}

function normalizeVerdict(value: string): LiveDemoVerdict {
  const upper = value.toUpperCase();
  if (upper === "PASS") return "PASS";
  if (upper === "FAIL") return "FAIL";
  return "PENDING";
}

function normalizeVerification(value: string): VerificationState {
  const upper = value.toUpperCase();
  if (upper === "VALID") return "VALID";
  if (upper === "INVALID") return "INVALID";
  if (upper === "DRIFT") return "DRIFT";
  if (upper === "SIGNATURE_FAIL") return "SIGNATURE_FAIL";
  if (upper === "UNKNOWN") return "UNKNOWN";
  if (upper === "PENDING") return "PENDING";
  if (upper === "UNAVAILABLE") return "UNAVAILABLE";
  return "NOT_REPORTED";
}

function normalizeSource(value?: string): LiveDemoEvent["source"] {
  if (value === "receipt" || value === "replay" || value === "startup") return value;
  return "http";
}

function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}
