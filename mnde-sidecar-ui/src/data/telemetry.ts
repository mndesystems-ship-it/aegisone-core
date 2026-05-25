import type { DecisionEvent, HealthItem, HealthState, ResourceMetrics, RiskLevel, TelemetryState, TopMetrics, Verdict } from "../types";

const receiptSeeds = [
  "7c1e8d2af09c4b91a2b4",
  "a81d0f39c5ed4026b117",
  "0d2b9a77f2b44ec18caa",
  "f4a9c102884c4d4f9e31",
  "23cd0a8ed29148debb04",
  "b7d22a5190af476189c3"
];

const eventTemplates: Array<Omit<DecisionEvent, "id" | "timestamp" | "receipt_id" | "signer_latency_ms" | "queue_pressure" | "replay_drift" | "worker_saturation" | "request_hash" | "decision_hash" | "canonical_payload_hash" | "raw_receipt">> = [
  {
    verdict: "ALLOW",
    action: "git status",
    reason_code: "ALLOW_READ_ONLY_WORKSPACE",
    explanation: "Read-only repository inspection inside approved workspace.",
    risk_level: "LOW",
    policy: "filesystem.read.workspace",
    policy_hash: "f42c88a0...13bd",
    prevented_impact: "No mutation requested",
    command_preview: "git status --short",
    signature_status: "VALID",
    replay_status: "VALID",
    policy_source: "demo://enterprise.guardrails.strict"
  },
  {
    verdict: "ALLOW",
    action: "npm test",
    reason_code: "ALLOW_TEST_RUNNER",
    explanation: "Test execution allowed with bounded process scope.",
    risk_level: "LOW",
    policy: "runtime.test.allowlist",
    policy_hash: "f42c88a0...13bd",
    prevented_impact: "Execution logged",
    command_preview: "cmd /c npm test",
    signature_status: "VALID",
    replay_status: "VALID",
    policy_source: "demo://enterprise.guardrails.strict"
  },
  {
    verdict: "REFUSE",
    action: "recursive delete outside approved path",
    reason_code: "REFUSE_PATH_PROTECTION",
    explanation: "Blocked recursive filesystem deletion targeting protected root.",
    risk_level: "HIGH",
    policy: "filesystem.protect",
    policy_hash: "f42c88a0...13bd",
    prevented_impact: "412 files protected",
    command_preview: "powershell.exe -Command Remove-Item -Recurse C:\\*",
    signature_status: "VALID",
    replay_status: "VALID",
    policy_source: "demo://filesystem.protect"
  },
  {
    verdict: "REFUSE",
    action: "outbound unsigned binary execution",
    reason_code: "REFUSE_UNSIGNED_OUTBOUND_BINARY",
    explanation: "Unsigned executable attempted network-capable process launch.",
    risk_level: "CRITICAL",
    policy: "runtime.binary.signature",
    policy_hash: "f42c88a0...13bd",
    prevented_impact: "Outbound execution prevented",
    command_preview: "Start-Process .\\artifact.exe -ArgumentList --post https://unknown",
    signature_status: "VALID",
    replay_status: "VALID",
    policy_source: "demo://runtime.binary.signature"
  },
  {
    verdict: "ALLOW",
    action: "cargo build --release",
    reason_code: "ALLOW_APPROVED_BUILD_TOOL",
    explanation: "Build command matched approved toolchain profile.",
    risk_level: "LOW",
    policy: "runtime.build.rust",
    policy_hash: "f42c88a0...13bd",
    prevented_impact: "Build receipt sealed",
    command_preview: "cargo build --release",
    signature_status: "VALID",
    replay_status: "VALID",
    policy_source: "demo://runtime.build.rust"
  },
  {
    verdict: "POLICY WARN",
    action: "signer latency elevated",
    reason_code: "WARN_SIGNER_LATENCY",
    explanation: "Signer remains healthy but latency crossed warning threshold.",
    risk_level: "MEDIUM",
    policy: "signer.latency.slo",
    policy_hash: "a91d0f39...8c2e",
    prevented_impact: "Queue held below refusal threshold",
    command_preview: "sidecar signer latency check",
    signature_status: "VALID",
    replay_status: "VALID",
    policy_source: "demo://signer.latency.slo"
  },
  {
    verdict: "REFUSE",
    action: "blocked multi-action chain",
    reason_code: "REFUSE_CHAIN_EXECUTION",
    explanation: "Install, execute, and exfiltrate pattern required operator approval.",
    risk_level: "HIGH",
    policy: "chain.execution.guard",
    policy_hash: "f42c88a0...13bd",
    prevented_impact: "$1,840 estimated spend avoided",
    command_preview: "npm install remote-tool && node remote-tool.js --upload",
    signature_status: "VALID",
    replay_status: "VALID",
    policy_source: "demo://chain.execution.guard"
  },
  {
    verdict: "REFUSE",
    action: "runaway retry chain",
    reason_code: "REFUSE_RETRY_STORM",
    explanation: "Repeated agent retries crossed cost guard threshold.",
    risk_level: "HIGH",
    policy: "runtime.cost_guard",
    policy_hash: "f42c88a0...13bd",
    prevented_impact: "$47.22 estimated spend avoided",
    command_preview: "agent run --retry-until-success --max-attempts 9999",
    signature_status: "VALID",
    replay_status: "VALID",
    policy_source: "demo://runtime.cost_guard"
  },
  {
    verdict: "REPLAY",
    action: "receipt replay check",
    reason_code: "REPLAY_HASH_MATCH",
    explanation: "Canonical bytes matched prior receipt; no replay drift detected.",
    risk_level: "LOW",
    policy: "mcj.replay.verify",
    policy_hash: "f42c88a0...13bd",
    prevented_impact: "Replay accepted with hash match",
    command_preview: "mcj verify receipt-7c1e8d2a.json",
    signature_status: "VALID",
    replay_status: "VALID",
    policy_source: "demo://mcj.replay.verify"
  }
];

export function makeInitialTelemetry(): TelemetryState {
  const events = Array.from({ length: 18 }, (_, index) => makeEvent(index, 18 - index));
  const latestRefusal = events.find((event) => event.verdict === "REFUSE") ?? events[0];

  return {
    mode: "demo",
    systemState: "ACTIVE",
    liveConnectionState: "DEMO_MODE",
    connectionState: "Demo Mode. Events are simulated.",
    metrics: makeMetrics(0, events),
    resources: makeResources(0),
    health: makeHealth(0),
    events,
    latestRefusal,
    statusMessage: "Demo Mode. Events are simulated."
  };
}

export function advanceTelemetry(previous: TelemetryState, tick: number): TelemetryState {
  const incoming = makeEvent(tick + 19, 0);
  const events = [incoming, ...previous.events].slice(0, 42);
  const latestRefusal = incoming.verdict === "REFUSE" ? incoming : previous.latestRefusal;
  const metrics = makeMetrics(tick, events);
  const resources = makeResources(tick);
  const health = makeHealth(tick);

  return {
    mode: "demo",
    systemState: stateFrom(metrics, health, incoming.verdict),
    liveConnectionState: "DEMO_MODE",
    connectionState: "Demo Mode. Events are simulated.",
    metrics,
    resources,
    health,
    events,
    latestRefusal,
    statusMessage: "Demo Mode. Events are simulated."
  };
}

export function makeDisconnectedLiveTelemetry(previous: TelemetryState, unsupported: boolean): TelemetryState {
  const sidecarConnectionState = unsupported ? "UNSUPPORTED_ENDPOINT" : "DISCONNECTED";
  const connectionState = unsupported ? "Sidecar endpoint unsupported." : "MNDe sidecar disconnected. No live protection status available.";
  const statusMessage = unsupported ? "Endpoint unsupported. Live telemetry unavailable." : "MNDe sidecar disconnected. No live protection status available.";

  return {
    ...previous,
    mode: "live",
    systemState: "DISCONNECTED",
    liveConnectionState: sidecarConnectionState,
    connectionState,
    statusMessage,
    events: [],
    latestRefusal: undefined,
    metrics: {
      policyName: "unavailable",
      policyHash: "unavailable",
      signerStatus: "Failed",
      signerLatencyMs: 0,
      uptime: "unavailable",
      decisionsPerSecond: 0,
      allows: 0,
      refuses: 0,
      replayDrift: 0,
      queuePressure: 0,
      workerSaturation: 0,
      sidecarConnectionState
    },
    resources: {
      cpu: 0,
      memory: 0,
      diskIo: 0,
      decisionThroughput: 0
    },
    health: previous.health.map((item) => ({ ...item, state: "Failed" as const, latencyMs: 0 }))
  };
}

function makeEvent(seed: number, ageSeconds: number): DecisionEvent {
  const template = eventTemplates[seed % eventTemplates.length];
  const timestamp = new Date(Date.now() - ageSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  return {
    ...template,
    id: `${seed}-${receiptSeeds[seed % receiptSeeds.length]}`,
    timestamp,
    receipt_id: `${receiptSeeds[seed % receiptSeeds.length].slice(0, 8)}...${receiptSeeds[(seed + 2) % receiptSeeds.length].slice(-4)}`,
    signer_latency_ms: 16 + ((seed * 7) % 54),
    queue_pressure: Math.min(98, 22 + ((seed * 11) % 67)),
    replay_drift: 0,
    worker_saturation: Math.min(96, 31 + ((seed * 13) % 59)),
    request_hash: `${receiptSeeds[(seed + 1) % receiptSeeds.length]}req`.slice(0, 24),
    decision_hash: `${receiptSeeds[(seed + 2) % receiptSeeds.length]}dec`.slice(0, 24),
    canonical_payload_hash: `${receiptSeeds[(seed + 3) % receiptSeeds.length]}mcj`.slice(0, 24),
    raw_receipt: {
      mode: "demo",
      seed,
      verdict: template.verdict,
      action: template.action,
      policy: template.policy,
      policy_hash: template.policy_hash
    }
  };
}

function makeMetrics(tick: number, events: DecisionEvent[]): TopMetrics {
  const refuses = events.filter((event) => event.verdict === "REFUSE").length;
  const allows = events.filter((event) => event.verdict === "ALLOW").length;
  const warningPhase = tick % 31 > 24;

  return {
    policyName: warningPhase ? "enterprise.guardrails.degraded" : "enterprise.guardrails.strict",
    policyHash: warningPhase ? "a91d0f39...8c2e" : "f42c88a0...13bd",
    signerStatus: warningPhase ? "Warning" : "Healthy",
    signerLatencyMs: warningPhase ? 84 + (tick % 12) : 19 + (tick % 15),
    uptime: "14d 06h 22m",
    decisionsPerSecond: 128 + ((tick * 7) % 39),
    allows,
    refuses,
    replayDrift: 0,
    queuePressure: warningPhase ? 78 + (tick % 13) : 28 + ((tick * 5) % 28),
    workerSaturation: warningPhase ? 83 + (tick % 9) : 44 + ((tick * 3) % 26),
    sidecarConnectionState: "DEMO_MODE"
  };
}

function makeResources(tick: number): ResourceMetrics {
  return {
    cpu: 28 + ((tick * 9) % 42),
    memory: 46 + ((tick * 4) % 24),
    diskIo: 11 + ((tick * 7) % 36),
    decisionThroughput: 118 + ((tick * 5) % 52)
  };
}

function makeHealth(tick: number): HealthItem[] {
  const signerState: HealthState = tick % 31 > 24 ? "Warning" : "Healthy";
  const storageState: HealthState = tick % 59 === 0 ? "Warning" : "Healthy";
  return [
    { name: "API", state: "Healthy", latencyMs: 9 + (tick % 8) },
    { name: "Parser (MCJ-1)", state: "Healthy", latencyMs: 3 + (tick % 3) },
    { name: "Policy Engine", state: "Healthy", latencyMs: 12 + (tick % 7) },
    { name: "Signer", state: signerState, latencyMs: signerState === "Warning" ? 86 : 24 },
    { name: "Storage", state: storageState, latencyMs: storageState === "Warning" ? 61 : 17 }
  ];
}

function stateFrom(metrics: TopMetrics, health: HealthItem[], verdict: Verdict) {
  if (verdict === "REFUSE") return "REFUSING";
  if (metrics.queuePressure > 82 || health.some((item) => item.state === "Warning")) return "DEGRADED";
  return "ACTIVE";
}

export function riskWeight(risk: RiskLevel): number {
  return { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[risk];
}
