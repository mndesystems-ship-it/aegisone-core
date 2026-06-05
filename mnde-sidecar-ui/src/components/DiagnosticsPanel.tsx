import type { SetupModel } from "../onboarding/setupModel";
import type { TelemetryState } from "../types";
import type { TrustState } from "../authority/trust";

interface DiagnosticsPanelProps {
  setup: SetupModel;
  telemetry: TelemetryState;
  trust: TrustState;
  onStartSidecar: () => void;
  onReconnect: () => void;
  onReloadPolicy: () => void;
  onVerifyReplay: () => void;
  onRerunDiagnostics: () => void;
}

export function DiagnosticsPanel({ setup, telemetry, trust, onStartSidecar, onReconnect, onReloadPolicy, onVerifyReplay, onRerunDiagnostics }: DiagnosticsPanelProps) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] gap-3">
      <section className="border border-line bg-panel">
        <header className="border-b border-line px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Startup Diagnostics</div>
          <h2 className="mt-1 text-base font-semibold text-ink">{setup.primaryIssue ?? "No blocking diagnostic issue reported"}</h2>
        </header>
        <div className="divide-y divide-line">
          {setup.steps.map((step) => (
            <div className="grid grid-cols-[160px_minmax(0,1fr)_90px] gap-3 px-4 py-3 text-sm" key={step.id}>
              <div className="font-semibold text-ink">{step.label}</div>
              <div className="min-w-0">
                <div className="break-words text-muted">{step.summary}</div>
                {step.remediation ? <div className="mt-1 break-words text-xs text-danger">{step.remediation}</div> : null}
                {step.technical ? (
                  <details className="mt-2 text-xs text-muted">
                    <summary className="cursor-pointer">Technical detail</summary>
                    <code className="mt-1 block break-all font-mono">{step.technical}</code>
                  </details>
                ) : null}
              </div>
              <div className={step.state === "pass" ? "text-safe" : step.state === "fail" ? "text-danger" : "text-warn"}>{step.state}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="border border-line bg-panel p-4">
        <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Recovery Actions</div>
        <div className="mt-3 grid gap-2">
          <button className="button h-9 text-left" onClick={onStartSidecar}>Restart Sidecar</button>
          <button className="button h-9 text-left" onClick={onReconnect}>Reconnect</button>
          <button className="button h-9 text-left" onClick={onReloadPolicy}>Reload Policy State</button>
          <button className="button h-9 text-left" onClick={onVerifyReplay}>Verify Replay Store</button>
          <button className="button signal h-9 text-left" onClick={onRerunDiagnostics}>Re-run Diagnostics</button>
        </div>
        <details className="mt-4 border border-line bg-[#0d1116] p-3 text-xs text-muted">
          <summary className="cursor-pointer text-ink">Current evidence</summary>
          <pre className="mt-3 max-h-56 overflow-auto font-mono">{JSON.stringify({
            trust: trust.verdict,
            causes: trust.causes,
            staleProofs: trust.staleProofs,
            liveConnectionState: telemetry.liveConnectionState,
            policy: telemetry.metrics.policyName,
            policyHash: telemetry.metrics.policyHash,
            signer: telemetry.metrics.signerStatus,
            replayDrift: telemetry.metrics.replayDrift,
            queuePressure: telemetry.metrics.queuePressure,
            workerSaturation: telemetry.metrics.workerSaturation,
            proof: telemetry.proof
          }, null, 2)}</pre>
        </details>
      </section>
    </div>
  );
}
