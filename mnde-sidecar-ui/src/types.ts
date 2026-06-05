export type AppMode = "demo" | "live";
export type SystemState = "ACTIVE" | "DEGRADED" | "REFUSING" | "DISCONNECTED";
export type LiveConnectionState = "CONNECTED" | "DEGRADED" | "REFUSING" | "DISCONNECTED" | "UNSUPPORTED_ENDPOINT";
export type Verdict = "ALLOW" | "REFUSE" | "POLICY WARN" | "REPLAY";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type HealthState = "Healthy" | "Warning" | "Failed";
export type VerificationState = "VALID" | "INVALID" | "DRIFT" | "SIGNATURE_FAIL" | "UNKNOWN" | "NOT_REPORTED" | "UNAVAILABLE" | "PENDING";
export type LogSeverity = "info" | "warning" | "error";
export type TrustVerdict = "TRUSTED" | "DEGRADED" | "PARTIAL_AUTHORITY" | "UNVERIFIED" | "FAIL_CLOSED" | "SIGNER_DEGRADED" | "REPLAY_UNSAFE" | "POLICY_INVALID" | "DISCONNECTED";
export type AuthorityScope = "ORG_ADMIN" | "POLICY_ADMIN" | "OPERATOR" | "AUDITOR" | "READ_ONLY" | "LOCAL_ONLY" | "RUNTIME_CONTROL";

export interface DecisionEvent {
  id: string;
  timestamp: string;
  verdict: Verdict;
  action: string;
  reason_code: string;
  explanation: string;
  risk_level: RiskLevel;
  receipt_id: string;
  policy: string;
  policy_hash: string;
  prevented_impact: string;
  prevented_cost_usd?: number | null;
  signer_latency_ms: number;
  queue_pressure: number;
  replay_drift: number;
  worker_saturation: number;
  command_preview: string;
  request_hash: string;
  decision_hash: string;
  canonical_payload_hash: string;
  signature_status: VerificationState;
  replay_status: VerificationState;
  policy_source: string;
  raw_receipt: unknown;
  signer_key_id?: string;
  receipt_chain_status?: VerificationState;
}

export interface TopMetrics {
  policyName: string;
  policyHash: string;
  signerStatus: HealthState;
  signerLatencyMs: number;
  uptime: string;
  decisionsPerSecond: number;
  allows: number;
  refuses: number;
  replayDrift: number;
  queuePressure: number;
  workerSaturation: number;
  sidecarConnectionState: LiveConnectionState | "DEMO_MODE";
}

export interface ResourceMetrics {
  cpu: number;
  memory: number;
  diskIo: number;
  decisionThroughput: number;
}

export interface HealthItem {
  name: "API" | "Parser (MCJ-1)" | "Policy Engine" | "Signer" | "Storage";
  state: HealthState;
  latencyMs: number;
}

export interface TelemetryState {
  mode: AppMode;
  systemState: SystemState;
  liveConnectionState: LiveConnectionState | "DEMO_MODE";
  connectionState: string;
  metrics: TopMetrics;
  resources: ResourceMetrics;
  health: HealthItem[];
  events: DecisionEvent[];
  latestRefusal?: DecisionEvent;
  statusMessage: string;
  nextRetryMs?: number;
  proof?: OperationalProof;
  integrity?: IntegrityEvidence;
}

export interface OperationalProof {
  lastSignerHeartbeatMs?: number;
  lastPolicyVerificationMs?: number;
  lastReplayVerificationMs?: number;
  lastSidecarContactMs?: number;
  receiptPersistenceLagMs?: number;
  runtimeTelemetryAgeMs?: number;
  healthEndpointOk?: boolean;
  readyEndpointOk?: boolean;
  metricsEndpointOk?: boolean;
  receiptsEndpointOk?: boolean;
}

export interface IntegrityEvidence {
  activeKeySetFingerprint?: string;
  signerKeyId?: string;
  receiptChainContinuity?: VerificationState;
  policySignatureStatus?: VerificationState;
  receiptSignatureValidity?: VerificationState;
  replayReproducibilityState?: VerificationState;
  jwksFreshnessMs?: number;
  signerLatencyPosture?: HealthState;
}

export interface AppSettings {
  mode: AppMode;
  sidecarEndpoint: string;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  receiptLimit: number;
  enableNativeNotifications: boolean;
  enableAutoReconnect: boolean;
  demoEventRateMs: number;
}

export interface AppLog {
  id: string;
  timestamp: string;
  severity: LogSeverity;
  source: string;
  message: string;
}

export interface VerifyResult {
  state: VerificationState;
  message: string;
  checkedAt: string;
}
