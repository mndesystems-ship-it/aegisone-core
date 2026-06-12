import { useEffect, useMemo, useState } from "react";
import { currentControlledStep, deriveDemoControlGate, normalizeControlledDemoState, type ControlledDemoState, type ControlledDemoStep } from "../demo/controlledDemo";

export function DemoWorkspace() {
  const [state, setState] = useState<ControlledDemoState | undefined>();
  const [message, setMessage] = useState("Controlled demo service is not attached.");
  const [busy, setBusy] = useState(false);
  const gate = useMemo(() => deriveDemoControlGate(state), [state]);
  const currentStep = currentControlledStep(state);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    async function poll() {
      const next = await fetchDemoState();
      if (cancelled) return;
      if (next.state) {
        setState(next.state);
        setMessage(next.state.message);
      } else {
        setMessage(next.message);
      }
      timer = window.setTimeout(poll, state?.running ? 600 : 1600);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [state?.running]);

  async function runAction(action: "start" | "next" | "reset") {
    setBusy(true);
    try {
      const response = await fetch(`/__mnde/demo/${action}`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.message === "string" ? body.message : `demo ${action} failed`);
      const next = normalizeControlledDemoState(body);
      setState(next);
      setMessage(next.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid-safe grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[280px_minmax(0,1fr)]">
      <section className="border border-line bg-panel p-4">
        <div className="text-xs uppercase tracking-[0.16em] text-signal">Demos</div>
        <button className="mt-4 w-full border border-signal/45 bg-signal/10 px-3 py-3 text-left" type="button">
          <div className="safe-text font-semibold text-ink">Live Authority Demo</div>
          <div className="safe-text mt-1 text-xs leading-relaxed text-muted">Step through signed authority, RBAC, receipts, and replay protection.</div>
        </button>
      </section>

      <section className="flex min-h-0 flex-col border border-line bg-panel">
        <header className="shrink-0 border-b border-line p-4">
          <div className="grid-safe grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(210px,260px)]">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-[0.16em] text-signal">Controlled Runner</div>
              <h2 className="safe-text mt-1 text-xl font-semibold text-ink">Live Authority Demo</h2>
              <p className="safe-text mt-2 max-w-2xl text-sm leading-relaxed text-muted">{message}</p>
            </div>
            <div className="grid-safe grid grid-cols-2 gap-2 text-sm">
              <StatusPill label="State" value={state?.status ?? "offline"} />
              <StatusPill label="Verdict" value={state?.verdict ?? "PENDING"} />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="button signal px-4 disabled:cursor-not-allowed disabled:opacity-45" disabled={busy || !gate.canStart} onClick={() => runAction("start")} type="button">Start Demo</button>
            <button className="button signal px-4 disabled:cursor-not-allowed disabled:opacity-45" disabled={busy || !gate.canNext} onClick={() => runAction("next")} type="button">Next Step</button>
            <button className="button px-4 disabled:cursor-not-allowed disabled:opacity-45" disabled={busy || !gate.canReset} onClick={() => runAction("reset")} type="button">Reset</button>
            <div className="safe-mono flex min-w-0 items-center font-mono text-xs text-muted">{busy ? "requesting..." : gate.reason}</div>
          </div>
        </header>

        <div className="grid-safe grid min-h-0 flex-1 grid-cols-1 gap-3 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-h-0 overflow-auto">
            <CurrentStepCard step={currentStep} index={state?.current_index ?? 0} total={state?.steps.length ?? 0} />
            <div className="mt-3 space-y-2">
              {(state?.steps ?? []).map((step, index) => (
                <StepRow index={index} key={step.id} step={step} active={step.id === currentStep?.id} />
              ))}
            </div>
          </div>
          <FinalPanel state={state} />
        </div>
      </section>
    </div>
  );
}

async function fetchDemoState(): Promise<{ state?: ControlledDemoState; message: string }> {
  try {
    const response = await fetch("/__mnde/demo-state.json", { cache: "no-store" });
    if (!response.ok) return { message: "Click Start Demo to launch the controlled runner." };
    const state = normalizeControlledDemoState(await response.json());
    return { state, message: state.message };
  } catch {
    return { message: "Click Start Demo to launch the controlled runner." };
  }
}

function CurrentStepCard({ step, index, total }: { step?: ControlledDemoStep; index: number; total: number }) {
  if (!step) {
    return (
      <section className="border border-line bg-[#0d1116] p-4">
        <div className="text-xs uppercase tracking-[0.16em] text-signal">Next Action</div>
        <div className="safe-text mt-2 text-lg font-semibold text-ink">Start the demo</div>
        <p className="safe-text mt-2 text-sm leading-relaxed text-muted">The runner will start an isolated sidecar, load signed authority, and wait for you to click Next Step.</p>
      </section>
    );
  }
  return (
    <section className="border border-signal/35 bg-signal/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs uppercase tracking-[0.16em] text-signal">Next Action</div>
        <div className="font-mono text-xs text-muted">{Math.min(index + 1, total)} / {total}</div>
      </div>
      <h3 className="safe-text mt-2 text-lg font-semibold text-ink">{step.name}</h3>
      <p className="safe-text mt-2 text-sm leading-relaxed text-muted">{step.purpose}</p>
      <div className="grid-safe mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <Context label="Endpoint" value={step.endpoint} />
        <Context label="Expected" value={step.expected} />
      </div>
      {step.result ? <ResultBox step={step} /> : null}
    </section>
  );
}

function StepRow({ step, index, active }: { step: ControlledDemoStep; index: number; active: boolean }) {
  const tone = step.state === "pass" ? "border-safe/35 bg-safe/5 text-safe" : step.state === "fail" ? "border-danger/45 bg-danger/10 text-danger" : active ? "border-signal/35 bg-signal/5 text-signal" : "border-line bg-[#0d1116] text-muted";
  return (
    <div className={`grid-safe grid grid-cols-[34px_minmax(0,1fr)_92px] items-start gap-3 border px-3 py-2.5 ${tone}`}>
      <div className="flex h-7 w-7 items-center justify-center border border-current font-mono text-xs">{index + 1}</div>
      <div className="min-w-0">
        <div className="safe-text text-sm font-semibold text-ink">{step.name}</div>
        <div className="safe-mono font-mono text-xs text-muted">{step.endpoint}</div>
      </div>
      <div className="text-right font-mono text-xs font-semibold">{step.state}</div>
    </div>
  );
}

function ResultBox({ step }: { step: ControlledDemoStep }) {
  const result = step.result;
  if (!result) return null;
  return (
    <div className="mt-4 border border-line bg-[#080b0f] p-3">
      <div className="text-xs uppercase tracking-[0.14em] text-muted">Real Result</div>
      <div className="grid-safe mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <Context label="Decision" value={result.decision} />
        <Context label="Reason" value={result.reason_code} />
        <Context label="HTTP" value={String(result.status ?? "not reported")} />
        <Context label="Request" value={shortHash(result.request_hash)} />
        <Context label="Decision Hash" value={shortHash(result.decision_hash)} />
        <Context label="Receipt" value={shortHash(result.receipt_id ?? "not reported")} />
      </div>
    </div>
  );
}

function FinalPanel({ state }: { state?: ControlledDemoState }) {
  return (
    <aside className="min-h-0 overflow-auto border border-line bg-[#0d1116] p-4">
      <div className="text-xs uppercase tracking-[0.16em] text-signal">Final Screen</div>
      <div className="mt-4 space-y-2 text-sm">
        <Context label="Hostile Verification" value={state?.final?.hostile_verification ?? "PENDING"} />
        <Context label="Signature Validation" value={state?.final?.signature_verification ?? "PENDING"} />
        <Context label="RBAC Enforcement" value={state?.final?.rbac_enforcement ?? "PENDING"} />
        <Context label="Replay Protection" value={state?.final?.replay_protection ?? "PENDING"} />
        <Context label="Deterministic Replay" value={state?.final?.deterministic_replay ?? "PENDING"} />
      </div>
      <div className="safe-mono mt-4 border border-signal/35 bg-signal/10 px-3 py-2.5 font-mono text-base font-semibold text-signal">FINAL VERDICT: {state?.final?.verdict ?? "PENDING"}</div>
      <div className="grid-safe mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <StatusPill label="Replay" value={state?.replay?.status ?? "waiting"} />
        <StatusPill label="Drift" value={String(state?.replay?.drift ?? "waiting")} />
        <StatusPill label="Signature" value={state?.replay?.signature_validation ?? "waiting"} />
        <StatusPill label="Receipt" value={state?.replay?.receipt_verification ?? "waiting"} />
      </div>
    </aside>
  );
}

function StatusPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-line bg-[#0d1116] px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className="safe-mono mt-1 font-mono text-sm font-semibold text-signal">{value}</div>
    </div>
  );
}

function Context({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid-safe grid grid-cols-[minmax(92px,0.42fr)_minmax(0,1fr)] items-start gap-3">
      <span className="safe-text uppercase tracking-[0.12em] text-muted">{label}</span>
      <span className="min-w-0 break-all text-right font-mono text-ink">{value}</span>
    </div>
  );
}

function shortHash(value: string): string {
  if (!value || value === "not reported") return value || "not reported";
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}
