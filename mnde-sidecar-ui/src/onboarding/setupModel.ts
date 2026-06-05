import type { AppMode, AppSettings, TelemetryState } from "../types";
import type { TrustState } from "../authority/trust";
import type { SidecarLaunchState } from "../desktop/sidecarControl";

const starterSettings: AppSettings = {
  mode: "live",
  sidecarEndpoint: "http://127.0.0.1:8787",
  pollIntervalMs: 2500,
  requestTimeoutMs: 1200,
  receiptLimit: 50,
  enableNativeNotifications: false,
  enableAutoReconnect: true,
  demoEventRateMs: 1450
};

export type SetupStepId =
  | "detect_sidecar"
  | "start_sidecar"
  | "verify_policy"
  | "verify_signer"
  | "verify_replay"
  | "verify_receipts"
  | "run_protection_demo"
  | "operational_ready";

export type SetupStepState = "pass" | "fail" | "running" | "blocked";
export type ProtectionTarget = "ai_workloads" | "local_automation" | "ci_cd_pipelines" | "developer_workstation" | "scripts_executables" | "custom_runtime";
export type ProtectionPosture = "monitor_only" | "balanced_protection" | "strict_enforcement";

export interface SetupStep {
  id: SetupStepId;
  label: string;
  state: SetupStepState;
  summary: string;
  remediation?: string;
  technical?: string;
  action?: "start_sidecar" | "reconnect" | "reload_policy" | "verify_replay" | "rerun_diagnostics" | "open_demo";
}

export interface SetupModel {
  operationalReady: boolean;
  steps: SetupStep[];
  primaryIssue?: string;
}

export function buildSetupModel(input: { telemetry: TelemetryState; trust: TrustState; mode: AppMode; sidecarLaunchState: SidecarLaunchState }): SetupModel {
  const { telemetry, trust, mode, sidecarLaunchState } = input;
  const live = mode === "live";
  const connected = live && telemetry.liveConnectionState === "CONNECTED";
  const sidecarFailure = telemetry.liveConnectionState === "DISCONNECTED" || telemetry.liveConnectionState === "UNSUPPORTED_ENDPOINT" || sidecarLaunchState === "failed";
  const policyOk = connected && reported(telemetry.metrics.policyName) && reported(telemetry.metrics.policyHash) && !trust.causes.some((cause) => cause.includes("policy"));
  const signerOk = connected && telemetry.metrics.signerStatus === "Healthy" && !trust.causes.some((cause) => cause.includes("signer"));
  const replayOk = connected && telemetry.metrics.replayDrift === 0 && !trust.causes.some((cause) => cause.includes("replay"));
  const receiptsOk = connected && telemetry.proof?.receiptsEndpointOk === true;
  const runtimeOk = connected && telemetry.metrics.queuePressure < 85 && telemetry.metrics.workerSaturation < 85 && !trust.causes.some((cause) => cause.includes("runtime") || cause.includes("queue"));
  const operationalReady = live && connected && policyOk && signerOk && replayOk && receiptsOk && runtimeOk && trust.verdict === "TRUSTED";

  const steps: SetupStep[] = [
    {
      id: "detect_sidecar",
      label: "Detect Sidecar",
      state: connected || telemetry.liveConnectionState === "REFUSING" || telemetry.liveConnectionState === "DEGRADED" ? "pass" : sidecarFailure ? "fail" : "blocked",
      summary: connected ? "Local sidecar responded." : sidecarFailure ? "The local sidecar did not respond." : "Waiting for live sidecar evidence.",
      remediation: sidecarFailure ? "Use Start Sidecar or Reconnect. If the sidecar is not installed, install MNDe Sidecar first." : undefined,
      technical: telemetry.liveConnectionState,
      action: sidecarFailure ? "start_sidecar" : undefined
    },
    {
      id: "start_sidecar",
      label: "Start Sidecar",
      state: sidecarLaunchState === "starting" ? "running" : connected ? "pass" : sidecarFailure ? "fail" : "blocked",
      summary: connected ? "Sidecar is running and reachable." : sidecarLaunchState === "starting" ? "Starting local sidecar." : "Sidecar is not confirmed running.",
      remediation: connected ? undefined : "Start or reconnect the local sidecar from this screen.",
      action: connected ? undefined : "start_sidecar"
    },
    {
      id: "verify_policy",
      label: "Verify Policy",
      state: policyOk ? "pass" : connected ? "fail" : "blocked",
      summary: policyOk ? "Active policy state is reported by the sidecar." : connected ? "Active policy state is unavailable or invalid." : "Policy cannot be verified until the sidecar is connected.",
      remediation: policyOk ? undefined : "Reload policy state or activate a signed policy through Policy controls.",
      technical: `${telemetry.metrics.policyName} / ${telemetry.metrics.policyHash}`,
      action: policyOk ? undefined : "reload_policy"
    },
    {
      id: "verify_signer",
      label: "Verify Signer",
      state: signerOk ? "pass" : connected ? "fail" : "blocked",
      summary: signerOk ? "Signer health is currently healthy." : connected ? "Signer health is degraded or unavailable." : "Signer cannot be verified until sidecar telemetry is available.",
      remediation: signerOk ? undefined : "Restart sidecar or inspect signer configuration in enterprise controls.",
      technical: telemetry.metrics.signerStatus,
      action: signerOk ? undefined : "rerun_diagnostics"
    },
    {
      id: "verify_replay",
      label: "Verify Replay",
      state: replayOk ? "pass" : connected ? "fail" : "blocked",
      summary: replayOk ? "No replay drift is reported." : connected ? "Replay drift or replay verification failure is reported." : "Replay cannot be verified until the sidecar is connected.",
      remediation: replayOk ? undefined : "Run replay diagnostics and inspect the replay store before enabling operational use.",
      technical: `drift=${telemetry.metrics.replayDrift}`,
      action: replayOk ? undefined : "verify_replay"
    },
    {
      id: "verify_receipts",
      label: "Verify Receipt Storage",
      state: receiptsOk ? "pass" : connected ? "fail" : "blocked",
      summary: receiptsOk ? "Receipt history endpoint is available." : connected ? "Receipt persistence or history endpoint is unavailable." : "Receipt storage cannot be verified until the sidecar is connected.",
      remediation: receiptsOk ? undefined : "Re-run diagnostics or repair sidecar configuration before relying on audit evidence.",
      technical: `receiptsEndpointOk=${String(telemetry.proof?.receiptsEndpointOk)}`,
      action: receiptsOk ? undefined : "rerun_diagnostics"
    },
    {
      id: "run_protection_demo",
      label: "Run Protection Demo",
      state: live ? telemetry.latestRefusal ? "pass" : "blocked" : "pass",
      summary: live ? telemetry.latestRefusal ? "A real refusal receipt is visible." : "No live refusal evidence is currently reported." : "Demo examples are simulated and clearly labeled.",
      remediation: live && !telemetry.latestRefusal ? "Use Demo Mode to learn the flow, or run an approved safe dry-check from the sidecar tooling." : undefined,
      action: live && !telemetry.latestRefusal ? "open_demo" : undefined
    },
    {
      id: "operational_ready",
      label: "Operational Ready",
      state: operationalReady ? "pass" : "blocked",
      summary: operationalReady ? "Live readiness is backed by current sidecar evidence and trust evaluation." : "Readiness is blocked until all live evidence checks pass.",
      remediation: operationalReady ? undefined : trust.causes[0] ?? trust.staleProofs[0] ?? "Complete the failed setup checks.",
      technical: trust.verdict
    }
  ];

  const primaryIssue = steps.find((step) => step.state === "fail")?.summary ?? steps.find((step) => step.state === "blocked")?.summary;
  return { operationalReady, steps, primaryIssue };
}

export function mapReadableReason(code: string) {
  const mapped: Record<string, string> = {
    ERR_ORBIT_MULTIPLE_ACTIONS: "Request blocked because multiple execution actions were attempted in a single request.",
    ERR_NOT_FOUND: "The sidecar could not find the requested operational evidence.",
    ERR_AUTH_REQUIRED: "The request needs authenticated MNDe authority before it can run.",
    ERR_REPLAY_DRIFT: "Replay verification found a mismatch between the receipt and reproduced decision.",
    ERR_POLICY_INVALID: "The active policy could not be verified as valid.",
    ERR_SIGNER_UNAVAILABLE: "The signer is unavailable, so receipt integrity cannot be confirmed."
  };
  return {
    summary: mapped[code] ?? code.replace(/^ERR_/, "").replace(/_/g, " ").toLowerCase(),
    technicalCode: code
  };
}

export function generateGuidedSettings(target: ProtectionTarget, posture: ProtectionPosture): AppSettings {
  const strict = posture === "strict_enforcement";
  const monitor = posture === "monitor_only";
  const highVolume = target === "ci_cd_pipelines" || target === "ai_workloads";
  return {
    ...starterSettings,
    mode: "live",
    enableAutoReconnect: true,
    pollIntervalMs: strict ? 1000 : monitor ? 3500 : 2500,
    requestTimeoutMs: highVolume ? 1800 : starterSettings.requestTimeoutMs,
    receiptLimit: highVolume || strict ? 100 : 50,
    demoEventRateMs: starterSettings.demoEventRateMs
  };
}

function reported(value: string) {
  const normalized = value.trim().toLowerCase();
  return Boolean(normalized) && normalized !== "unavailable" && normalized !== "not reported";
}
