import { useMemo, useState } from "react";
import type { AppSettings } from "../types";
import { generateGuidedSettings, type ProtectionPosture, type ProtectionTarget, type SetupModel, type SetupStep } from "../onboarding/setupModel";

const targetOptions: Array<{ value: ProtectionTarget; label: string }> = [
  { value: "ai_workloads", label: "AI workloads" },
  { value: "local_automation", label: "Local automation" },
  { value: "ci_cd_pipelines", label: "CI/CD pipelines" },
  { value: "developer_workstation", label: "Developer workstation" },
  { value: "scripts_executables", label: "Scripts/executables" },
  { value: "custom_runtime", label: "Custom runtime" }
];

const postureOptions: Array<{ value: ProtectionPosture; label: string; detail: string }> = [
  { value: "monitor_only", label: "Monitor Only", detail: "Observe decisions with slower polling and lower setup pressure." },
  { value: "balanced_protection", label: "Balanced Protection", detail: "Production-oriented defaults for local operation." },
  { value: "strict_enforcement", label: "Strict Enforcement", detail: "Faster polling and more receipt history for high-control use." }
];

interface OnboardingPanelProps {
  setup: SetupModel;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  onStartSidecar: () => void;
  onReconnect: () => void;
  onReloadPolicy: () => void;
  onVerifyReplay: () => void;
  onRerunDiagnostics: () => void;
  onOpenDemo: () => void;
}

export function OnboardingPanel({ setup, settings, onSettingsChange, onStartSidecar, onReconnect, onReloadPolicy, onVerifyReplay, onRerunDiagnostics, onOpenDemo }: OnboardingPanelProps) {
  const [target, setTarget] = useState<ProtectionTarget>("developer_workstation");
  const [posture, setPosture] = useState<ProtectionPosture>("balanced_protection");
  const generated = useMemo(() => generateGuidedSettings(target, posture), [target, posture]);

  function applyGuidedSettings() {
    onSettingsChange({ ...settings, ...generated });
  }

  function runAction(step: SetupStep) {
    if (step.action === "start_sidecar") onStartSidecar();
    if (step.action === "reconnect") onReconnect();
    if (step.action === "reload_policy") onReloadPolicy();
    if (step.action === "verify_replay") onVerifyReplay();
    if (step.action === "rerun_diagnostics") onRerunDiagnostics();
    if (step.action === "open_demo") onOpenDemo();
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] gap-3">
      <section className="min-w-0 border border-line bg-panel">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-signal">First-Run Operational Setup</div>
            <h2 className="mt-1 text-base font-semibold text-ink">{setup.operationalReady ? "Operational Ready" : "Readiness Checks Required"}</h2>
          </div>
          <div className={`border px-3 py-1.5 text-xs font-semibold ${setup.operationalReady ? "border-safe/35 bg-safe/10 text-safe" : "border-danger/35 bg-danger/10 text-danger"}`}>
            {setup.operationalReady ? "READY" : "BLOCKED"}
          </div>
        </header>
        <div className="grid gap-2 p-4">
          {setup.steps.map((step, index) => (
            <SetupStepRow key={step.id} index={index + 1} step={step} onAction={() => runAction(step)} />
          ))}
        </div>
      </section>

      <section className="border border-line bg-panel p-4">
        <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Guided Configuration</div>
        <label className="mt-3 block">
          <span className="label">What are you protecting?</span>
          <select className="input" value={target} onChange={(event) => setTarget(event.target.value as ProtectionTarget)}>
            {targetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <div className="mt-4 space-y-2">
          <div className="label">Protection posture</div>
          {postureOptions.map((option) => (
            <button
              className={`w-full border px-3 py-2 text-left ${posture === option.value ? "border-signal/50 bg-signal/10" : "border-line bg-[#0d1116]"}`}
              key={option.value}
              onClick={() => setPosture(option.value)}
              type="button"
            >
              <div className="text-sm font-semibold text-ink">{option.label}</div>
              <div className="mt-1 text-xs leading-relaxed text-muted">{option.detail}</div>
            </button>
          ))}
        </div>
        <button className="button signal mt-4 h-9 w-full" onClick={applyGuidedSettings} type="button">Apply Local Settings</button>
        <details className="mt-4 border border-line bg-[#0d1116] p-3 text-xs text-muted">
          <summary className="cursor-pointer text-ink">Advanced generated settings</summary>
          <pre className="mt-3 max-h-44 overflow-auto font-mono">{JSON.stringify(generated, null, 2)}</pre>
        </details>
      </section>
    </div>
  );
}

function SetupStepRow({ step, index, onAction }: { step: SetupStep; index: number; onAction: () => void }) {
  const tone = step.state === "pass"
    ? "border-safe/30 bg-safe/5 text-safe"
    : step.state === "running"
      ? "border-signal/35 bg-signal/10 text-signal"
      : step.state === "fail"
        ? "border-danger/35 bg-danger/10 text-danger"
        : "border-line bg-[#0d1116] text-muted";
  return (
    <article className={`min-w-0 border p-3 ${tone}`}>
      <div className="flex items-start gap-3">
        <div className="grid h-6 w-6 shrink-0 place-items-center border border-current/40 font-mono text-xs">{step.state === "pass" ? "OK" : index}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">{step.label}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted">{step.summary}</p>
            </div>
            <div className="shrink-0 font-mono text-xs uppercase">{step.state}</div>
          </div>
          {step.remediation ? <p className="mt-2 text-xs leading-relaxed text-muted">{step.remediation}</p> : null}
          <div className="mt-3 flex items-center gap-2">
            {step.action ? <button className="button px-3 text-xs" onClick={onAction} type="button">Repair</button> : null}
            {step.technical ? (
              <details className="text-xs text-muted">
                <summary className="cursor-pointer">Technical detail</summary>
                <code className="mt-1 block max-w-full break-all font-mono">{step.technical}</code>
              </details>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}
