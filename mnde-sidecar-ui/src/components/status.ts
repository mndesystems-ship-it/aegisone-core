import type { HealthState, LiveConnectionState, RiskLevel, SystemState, Verdict } from "../types";

export function verdictClass(verdict: Verdict) {
  switch (verdict) {
    case "ALLOW":
      return "border-safe/30 bg-safe/10 text-safe";
    case "REFUSE":
      return "border-danger/40 bg-danger/10 text-danger";
    case "POLICY WARN":
      return "border-warn/40 bg-warn/10 text-warn";
    case "REPLAY":
      return "border-signal/35 bg-signal/10 text-signal";
  }
}

export function riskClass(risk: RiskLevel) {
  switch (risk) {
    case "LOW":
      return "text-safe border-safe/25 bg-safe/10";
    case "MEDIUM":
      return "text-warn border-warn/30 bg-warn/10";
    case "HIGH":
      return "text-danger border-danger/30 bg-danger/10";
    case "CRITICAL":
      return "text-white border-danger/50 bg-danger/30";
  }
}

export function healthClass(state: HealthState) {
  switch (state) {
    case "Healthy":
      return "text-safe";
    case "Warning":
      return "text-warn";
    case "Failed":
      return "text-danger";
  }
}

export function systemClass(state: SystemState) {
  switch (state) {
    case "ACTIVE":
      return "text-safe border-safe/30 bg-safe/10";
    case "DEGRADED":
      return "text-warn border-warn/35 bg-warn/10";
    case "REFUSING":
      return "text-danger border-danger/40 bg-danger/10";
    case "DISCONNECTED":
      return "text-idle border-idle/30 bg-idle/10";
  }
}

export function connectionClass(state: LiveConnectionState | "DEMO_MODE") {
  switch (state) {
    case "CONNECTED":
      return "text-safe border-safe/30 bg-safe/10";
    case "DEGRADED":
    case "UNSUPPORTED_ENDPOINT":
      return "text-warn border-warn/35 bg-warn/10";
    case "REFUSING":
      return "text-danger border-danger/40 bg-danger/10";
    case "DISCONNECTED":
      return "text-danger border-danger/35 bg-danger/10";
    case "DEMO_MODE":
      return "text-warn border-warn/35 bg-warn/10";
  }
}
