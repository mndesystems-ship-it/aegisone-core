import type { LiveDemoEvent, LiveDemoFinal, LiveDemoReplay, LiveDemoVerdict } from "../liveDemo/evidence";

export type ControlledDemoStatus = "idle" | "ready" | "running" | "complete" | "failed";

export interface ControlledDemoStep {
  id: string;
  name: string;
  purpose: string;
  endpoint: string;
  expected: string;
  result?: LiveDemoEvent;
  state: "pending" | "running" | "pass" | "fail";
}

export interface ControlledDemoState {
  mode: "controlled-live-demo";
  status: ControlledDemoStatus;
  selected_demo: string;
  current_index: number;
  running: boolean;
  message: string;
  steps: ControlledDemoStep[];
  replay?: LiveDemoReplay;
  final?: LiveDemoFinal;
  verdict: LiveDemoVerdict;
  updated_at?: string;
}

export interface DemoControlGate {
  canStart: boolean;
  canNext: boolean;
  canReset: boolean;
  label: string;
  reason: string;
}

export function normalizeControlledDemoState(input: unknown): ControlledDemoState {
  const source = object(input);
  const steps = Array.isArray(source.steps) ? source.steps.map(normalizeStep).filter(Boolean) as ControlledDemoStep[] : [];
  const status = normalizeStatus(stringValue(source.status) ?? "idle");
  const running = source.running === true || status === "running";
  return {
    mode: "controlled-live-demo",
    status,
    selected_demo: stringValue(source.selected_demo) ?? "live-authority",
    current_index: numberValue(source.current_index) ?? 0,
    running,
    message: stringValue(source.message) ?? "Choose a demo and start the controlled run.",
    steps,
    replay: normalizeReplay(source.replay),
    final: normalizeFinal(source.final),
    verdict: normalizeVerdict(stringValue(source.verdict) ?? "PENDING"),
    updated_at: stringValue(source.updated_at)
  };
}

export function currentControlledStep(state?: ControlledDemoState): ControlledDemoStep | undefined {
  if (!state) return undefined;
  return state.steps[state.current_index] ?? state.steps.find((step) => step.state === "pending" || step.state === "running") ?? state.steps[state.steps.length - 1];
}

export function deriveDemoControlGate(state?: ControlledDemoState): DemoControlGate {
  if (!state) {
    return { canStart: true, canNext: false, canReset: false, label: "Start Demo", reason: "demo service is not attached" };
  }
  if (state.running) {
    return { canStart: false, canNext: false, canReset: false, label: "Running...", reason: "step is running" };
  }
  if (state.status === "failed") {
    return { canStart: false, canNext: false, canReset: true, label: "Reset Required", reason: "demo stopped on a failed step" };
  }
  if (state.status === "complete") {
    return { canStart: false, canNext: false, canReset: true, label: "Complete", reason: "all steps have run" };
  }
  if (state.status === "idle") {
    return { canStart: true, canNext: false, canReset: false, label: "Start Demo", reason: "demo has not started" };
  }
  return { canStart: false, canNext: true, canReset: true, label: "Next Step", reason: "ready for operator-controlled advance" };
}

function normalizeStep(input: unknown): ControlledDemoStep | undefined {
  const source = object(input);
  const id = stringValue(source.id);
  const name = stringValue(source.name);
  const endpoint = stringValue(source.endpoint);
  if (!id || !name || !endpoint) return undefined;
  return {
    id,
    name,
    purpose: stringValue(source.purpose) ?? "Show live MNDe authority enforcement.",
    endpoint,
    expected: stringValue(source.expected) ?? "MNDe returns the expected protected decision.",
    result: normalizeEvent(source.result),
    state: normalizeStepState(stringValue(source.state) ?? "pending")
  };
}

function normalizeEvent(input: unknown): LiveDemoEvent | undefined {
  const source = object(input);
  const id = stringValue(source.id);
  const endpoint = stringValue(source.endpoint);
  const reasonCode = stringValue(source.reason_code);
  const decision = stringValue(source.decision)?.toUpperCase();
  if (!id || !endpoint || !reasonCode || !["ALLOW", "REFUSE", "REPLAY"].includes(decision ?? "")) return undefined;
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
    real: source.real === true,
    status: numberValue(source.status),
    receipt_id: stringValue(source.receipt_id),
    replay_status: stringValue(source.replay_status),
    actor_role: stringValue(source.actor_role),
    capability: stringValue(source.capability)
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

function normalizeStatus(value: string): ControlledDemoStatus {
  const lower = value.toLowerCase();
  if (lower === "ready" || lower === "running" || lower === "complete" || lower === "failed") return lower;
  return "idle";
}

function normalizeStepState(value: string): ControlledDemoStep["state"] {
  const lower = value.toLowerCase();
  if (lower === "running" || lower === "pass" || lower === "fail") return lower;
  return "pending";
}

function normalizeVerdict(value: string): LiveDemoVerdict {
  const upper = value.toUpperCase();
  if (upper === "PASS") return "PASS";
  if (upper === "FAIL") return "FAIL";
  return "PENDING";
}

function normalizeVerification(value: string): LiveDemoReplay["signature_validation"] {
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
