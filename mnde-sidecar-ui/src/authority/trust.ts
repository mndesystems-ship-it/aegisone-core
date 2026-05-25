import type { AppMode, AuthorityScope, TelemetryState, TrustVerdict } from "../types";
import type { AuthSession } from "../auth/model";

type ProtectedAction =
  | "policy_activation"
  | "runtime_enablement"
  | "signer_changes"
  | "authority_changes"
  | "receipt_sealing_changes"
  | "replay_approval_override";

interface TrustInput {
  telemetry: TelemetryState;
  session?: AuthSession;
  mode: AppMode;
  now?: number;
}

export interface AuthorityScopeState {
  currentScope: AuthorityScope;
  scopes: AuthorityScope[];
  source: string;
  assurance: "ENTERPRISE_OIDC" | "LOCAL_ONLY" | "EXPIRED" | "UNAUTHENTICATED";
  mfa: "PRESENT" | "ABSENT" | "NOT_REPORTED";
  sessionFreshness: "FRESH" | "STALE" | "EXPIRED" | "MISSING";
  tokenExpiryMs?: number;
}

export interface TrustState {
  verdict: TrustVerdict;
  causes: string[];
  staleProofs: string[];
  freshness: Array<{ label: string; value: string; state: "fresh" | "stale" | "missing" }>;
  integrity: Array<{ label: string; value: string; state: "valid" | "degraded" | "unverified" }>;
}

const FRESHNESS_LIMIT_MS = 30_000;
const AUTH_STALE_MS = 15 * 60 * 1000;

export function deriveAuthorityScope(session?: AuthSession, now = Date.now()): AuthorityScopeState {
  if (!session) {
    return {
      currentScope: "LOCAL_ONLY",
      scopes: ["LOCAL_ONLY"],
      source: "no enterprise session",
      assurance: "UNAUTHENTICATED",
      mfa: "NOT_REPORTED",
      sessionFreshness: "MISSING"
    };
  }
  if (isSessionExpired(session, now)) {
    return {
      currentScope: "LOCAL_ONLY",
      scopes: ["LOCAL_ONLY"],
      source: session.provider,
      assurance: "EXPIRED",
      mfa: "NOT_REPORTED",
      sessionFreshness: "EXPIRED",
      tokenExpiryMs: 0
    };
  }

  const scopesByRole: Record<string, AuthorityScope[]> = {
    ADMIN: ["ORG_ADMIN", "POLICY_ADMIN", "RUNTIME_CONTROL", "OPERATOR", "AUDITOR", "READ_ONLY"],
    OPERATOR: ["OPERATOR", "RUNTIME_CONTROL", "READ_ONLY"],
    AUDITOR: ["AUDITOR", "READ_ONLY"],
    VIEWER: ["READ_ONLY"]
  };
  const scopes = scopesByRole[session.role] ?? ["READ_ONLY"];
  const loginAge = readSessionTime(session.login_time) ? now - readSessionTime(session.login_time)! : Number.POSITIVE_INFINITY;
  const expiry = readSessionTime(session.session_expiry);
  return {
    currentScope: scopes[0],
    scopes,
    source: session.provider,
    assurance: session.provider === "microsoft_entra" || session.provider === "okta" ? "ENTERPRISE_OIDC" : "LOCAL_ONLY",
    mfa: "NOT_REPORTED",
    sessionFreshness: loginAge <= AUTH_STALE_MS ? "FRESH" : "STALE",
    tokenExpiryMs: expiry ? Math.max(0, expiry - now) : undefined
  };
}

export function deriveTrustState({ telemetry, session, mode, now = Date.now() }: TrustInput): TrustState {
  const authority = deriveAuthorityScope(session, now);
  const causes: string[] = [];
  const staleProofs: string[] = [];
  const proof = telemetry.proof;
  const connected = telemetry.liveConnectionState === "CONNECTED";

  if (mode !== "live") causes.push("demo mode has no live authority");
  if (!connected) causes.push(telemetry.liveConnectionState === "DISCONNECTED" ? "disconnected sidecar" : `sidecar ${telemetry.liveConnectionState.toLowerCase()}`);
  if (authority.assurance !== "ENTERPRISE_OIDC") causes.push("enterprise authority unavailable");
  if (authority.sessionFreshness === "STALE") causes.push("stale authority session");
  if (authority.sessionFreshness === "EXPIRED" || authority.sessionFreshness === "MISSING") causes.push("missing or expired authority session");
  if (telemetry.metrics.signerStatus !== "Healthy") causes.push("signer unavailable or degraded");
  if (telemetry.metrics.replayDrift > 0) causes.push("replay drift detected");
  if (telemetry.metrics.queuePressure >= 85) causes.push("queue overflow threshold exceeded");
  if (telemetry.metrics.workerSaturation >= 85) causes.push("runtime saturation exceeded");
  if (telemetry.metrics.policyName === "unavailable" || telemetry.metrics.policyHash === "unavailable") causes.push("policy state unavailable");
  if (telemetry.events.some((event) => event.signature_status === "INVALID" || event.signature_status === "SIGNATURE_FAIL")) causes.push("receipt signature invalid");
  if (telemetry.events.some((event) => event.replay_status === "DRIFT" || event.replay_status === "SIGNATURE_FAIL")) causes.push("replay reproducibility unsafe");

  const freshness = [
    freshnessItem("last signer heartbeat", proof?.lastSignerHeartbeatMs, now, staleProofs),
    freshnessItem("last policy verification", proof?.lastPolicyVerificationMs, now, staleProofs),
    freshnessItem("last replay verification", proof?.lastReplayVerificationMs, now, staleProofs),
    freshnessItem("last sidecar contact", proof?.lastSidecarContactMs, now, staleProofs),
    lagItem("receipt persistence lag", proof?.receiptPersistenceLagMs, staleProofs),
    ageItem("runtime telemetry age", proof?.runtimeTelemetryAgeMs, staleProofs),
    authFreshnessItem(authority, now)
  ];
  causes.push(...staleProofs);

  const integrity = deriveIntegrityIndicators(telemetry);
  const hasMissingProof = freshness.some((item) => item.state === "missing") || integrity.some((item) => item.state === "unverified");
  const hasStaleProof = freshness.some((item) => item.state === "stale");

  let verdict: TrustVerdict = "TRUSTED";
  if (telemetry.liveConnectionState === "DISCONNECTED" || telemetry.liveConnectionState === "UNSUPPORTED_ENDPOINT") verdict = "DISCONNECTED";
  else if (causes.some((cause) => cause === "policy state unavailable" || cause === "policy signature invalid")) verdict = "POLICY_INVALID";
  else if (causes.some((cause) => cause === "replay drift detected" || cause === "replay reproducibility unsafe")) verdict = "REPLAY_UNSAFE";
  else if (causes.some((cause) => cause === "signer unavailable or degraded")) verdict = "SIGNER_DEGRADED";
  else if (causes.some((cause) => cause.includes("authority"))) verdict = "PARTIAL_AUTHORITY";
  else if (hasStaleProof || hasMissingProof) verdict = "UNVERIFIED";
  else if (causes.length > 0) verdict = "DEGRADED";

  if (telemetry.systemState === "REFUSING" && verdict === "TRUSTED") verdict = "FAIL_CLOSED";
  return { verdict, causes: unique(causes), staleProofs: unique(staleProofs), freshness, integrity };
}

export function gateProtectedAction(action: ProtectedAction, trust: TrustState, authority: AuthorityScopeState) {
  const requiredScopes: Record<ProtectedAction, AuthorityScope[]> = {
    policy_activation: ["ORG_ADMIN", "POLICY_ADMIN"],
    runtime_enablement: ["ORG_ADMIN", "RUNTIME_CONTROL"],
    signer_changes: ["ORG_ADMIN"],
    authority_changes: ["ORG_ADMIN"],
    receipt_sealing_changes: ["ORG_ADMIN", "POLICY_ADMIN"],
    replay_approval_override: ["ORG_ADMIN", "AUDITOR"]
  };
  const blockedTrust = trust.verdict !== "TRUSTED";
  const hasScope = requiredScopes[action].some((scope) => authority.scopes.includes(scope));
  if (!hasScope) return { allowed: false, reason: `requires ${requiredScopes[action].join(" or ")}` };
  if (blockedTrust) return { allowed: false, reason: `blocked by ${trust.verdict}: ${trust.causes[0] ?? trust.staleProofs[0] ?? "unverified proof"}` };
  return { allowed: true, reason: "allowed by current trusted authority" };
}

export function buildOperationalTimeline(telemetry: TelemetryState, session?: AuthSession, trust?: TrustState) {
  const actor = session?.email ?? "local";
  const scope = deriveAuthorityScope(session).currentScope;
  const events = telemetry.events.slice(0, 8).map((event) => ({
    timestamp: event.timestamp,
    actor,
    authorityScope: scope,
    event: event.verdict === "REFUSE" ? "runtime refusal" : "decision receipt",
    runtimeImpact: event.prevented_impact,
    receipt: event.receipt_id
  }));
  if (trust && trust.verdict !== "TRUSTED") {
    events.unshift({
      timestamp: new Date().toLocaleTimeString(),
      actor,
      authorityScope: scope,
      event: `trust ${trust.verdict.toLowerCase()}`,
      runtimeImpact: trust.causes[0] ?? trust.staleProofs[0] ?? "unverified authority proof",
      receipt: "not linked"
    });
  }
  return events;
}

function deriveIntegrityIndicators(telemetry: TelemetryState): TrustState["integrity"] {
  const latest = telemetry.events[0];
  const receiptSignature = aggregateVerification(telemetry.events.map((event) => event.signature_status));
  const replay = aggregateVerification(telemetry.events.map((event) => event.replay_status));
  const chain = aggregateVerification(telemetry.events.map((event) => event.receipt_chain_status ?? "UNAVAILABLE"));
  return [
    indicator("active key-set fingerprint", telemetry.integrity?.activeKeySetFingerprint ?? "not reported", "unverified"),
    indicator("signer key id", telemetry.integrity?.signerKeyId ?? latest?.signer_key_id ?? "not reported", latest?.signer_key_id ? "valid" : "unverified"),
    indicator("receipt chain continuity", telemetry.integrity?.receiptChainContinuity ?? chain, stateForVerification(chain)),
    indicator("policy signature status", telemetry.integrity?.policySignatureStatus ?? "NOT_REPORTED", stateForVerification(telemetry.integrity?.policySignatureStatus ?? "NOT_REPORTED")),
    indicator("receipt signature validity", telemetry.integrity?.receiptSignatureValidity ?? receiptSignature, stateForVerification(receiptSignature)),
    indicator("replay reproducibility state", telemetry.integrity?.replayReproducibilityState ?? replay, stateForVerification(replay)),
    indicator("JWKS/key freshness", telemetry.integrity?.jwksFreshnessMs === undefined ? "not reported" : `${Math.round(telemetry.integrity.jwksFreshnessMs / 1000)}s`, telemetry.integrity?.jwksFreshnessMs === undefined ? "unverified" : "valid"),
    indicator("signer latency posture", telemetry.integrity?.signerLatencyPosture ?? telemetry.metrics.signerStatus, telemetry.metrics.signerStatus === "Healthy" ? "valid" : "degraded")
  ];
}

function freshnessItem(label: string, timestamp: number | undefined, now: number, staleProofs: string[]): { label: string; value: string; state: "fresh" | "stale" | "missing" } {
  if (!timestamp) return { label, value: "not reported", state: "missing" as const };
  const age = Math.max(0, now - timestamp);
  const state: "fresh" | "stale" = age > FRESHNESS_LIMIT_MS ? "stale" : "fresh";
  if (state === "stale") staleProofs.push(`stale ${label.replace(/^last /, "")}`);
  return { label, value: `${Math.round(age / 1000)}s ago`, state };
}

function lagItem(label: string, lag: number | undefined, staleProofs: string[]): { label: string; value: string; state: "fresh" | "stale" | "missing" } {
  if (lag === undefined) return { label, value: "not reported", state: "missing" as const };
  const state: "fresh" | "stale" = lag > FRESHNESS_LIMIT_MS ? "stale" : "fresh";
  if (state === "stale") staleProofs.push(`stale ${label}`);
  return { label, value: `${Math.round(lag / 1000)}s`, state };
}

function ageItem(label: string, age: number | undefined, staleProofs: string[]): { label: string; value: string; state: "fresh" | "stale" | "missing" } {
  if (age === undefined) return { label, value: "not reported", state: "missing" as const };
  const state: "fresh" | "stale" = age > FRESHNESS_LIMIT_MS ? "stale" : "fresh";
  if (state === "stale") staleProofs.push(`stale ${label}`);
  return { label, value: `${Math.round(age / 1000)}s`, state };
}

function authFreshnessItem(authority: AuthorityScopeState, now: number): { label: string; value: string; state: "fresh" | "stale" | "missing" } {
  const value = authority.tokenExpiryMs === undefined ? authority.sessionFreshness.toLowerCase() : `${Math.round(authority.tokenExpiryMs / 1000)}s token TTL`;
  return { label: "auth session freshness", value, state: authority.sessionFreshness === "FRESH" ? "fresh" as const : authority.sessionFreshness === "MISSING" ? "missing" as const : "stale" as const };
}

function indicator(label: string, value: string, state: "valid" | "degraded" | "unverified") {
  return { label, value, state };
}

function aggregateVerification(values: Array<string | undefined>) {
  if (values.length === 0) return "NOT_REPORTED";
  if (values.some((value) => value === "SIGNATURE_FAIL" || value === "INVALID")) return "INVALID";
  if (values.some((value) => value === "DRIFT")) return "DRIFT";
  if (values.every((value) => value === "VALID")) return "VALID";
  return "NOT_REPORTED";
}

function stateForVerification(value: string) {
  if (value === "VALID") return "valid";
  if (value === "INVALID" || value === "DRIFT" || value === "SIGNATURE_FAIL") return "degraded";
  return "unverified";
}

function readSessionTime(value: string) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isSessionExpired(session: AuthSession, now: number) {
  const expiry = readSessionTime(session.session_expiry);
  return !expiry || expiry <= now;
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
