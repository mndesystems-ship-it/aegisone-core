import { useMemo, useState } from "react";
import type { SidecarLaunchState } from "../desktop/sidecarControl";

const setupSteps = [
  {
    id: "sidecar",
    label: "Connect sidecar",
    detail: "Start the local MNDe sidecar and connect Live Mode.",
    command: "http://127.0.0.1:8787"
  },
  {
    id: "policy",
    label: "Load policy",
    detail: "Use the strict execution guardrail profile.",
    command: "mnde policy load enterprise.guardrails.strict"
  },
  {
    id: "receipts",
    label: "Enable receipts",
    detail: "Seal every decision with MCJ-1 canonical bytes.",
    command: "mnde receipts enable --profile MCJ-1"
  },
  {
    id: "dryrun",
    label: "Run dry check",
    detail: "Verify refusals before allowing live automation.",
    command: "mnde verify --dry-run powershell.exe -Command Remove-Item -Recurse C:\\*"
  }
];

interface SetupGuideProps {
  onStartSidecar: () => void;
  sidecarLaunchState: SidecarLaunchState;
  startGate?: { allowed: boolean; reason: string };
}

export function SetupGuide({ onStartSidecar, sidecarLaunchState, startGate }: SetupGuideProps) {
  const [completed, setCompleted] = useState(() => new Set(["sidecar", "policy"]));
  const [copied, setCopied] = useState<string | null>(null);
  const progress = useMemo(() => Math.round((completed.size / setupSteps.length) * 100), [completed]);

  function toggle(id: string) {
    setCompleted((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copyCommand(id: string, command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(id);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      setCopied(null);
    }
  }

  return (
    <section className="border border-line bg-panel">
      <header className="grid-safe grid grid-cols-1 gap-3 border-b border-line px-4 py-3 md:grid-cols-[minmax(0,1fr)_176px] md:items-center">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Setup Assistant</div>
          <h2 className="safe-text mt-1 text-sm font-semibold text-ink">Bring MNDe online safely</h2>
        </div>
        <div className="min-w-0">
          <div className="mb-1 flex justify-between text-[11px] text-muted">
            <span>Readiness</span>
            <span className="font-mono text-signal">{progress}%</span>
          </div>
          <div className="h-1.5 bg-[#080b0f]">
            <div className="h-full bg-signal transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </header>

      <div className="grid-safe grid grid-cols-1 gap-2 p-3 md:grid-cols-2 xl:grid-cols-4">
        {setupSteps.map((step, index) => {
          const done = completed.has(step.id);
          return (
            <article className={`border px-3 py-3 transition ${done ? "border-safe/25 bg-safe/5" : "border-line bg-[#0d1116] hover:border-signal/30"}`} key={step.id}>
              <button className="mb-3 flex w-full items-start gap-2 text-left" onClick={() => toggle(step.id)}>
                <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center border text-[11px] ${done ? "border-safe bg-safe/15 text-safe" : "border-line text-muted"}`}>
                  {done ? "✓" : index + 1}
                </span>
                <span className="min-w-0">
                  <span className="safe-text block text-sm font-semibold text-ink">{step.label}</span>
                  <span className="safe-text mt-1 block text-xs leading-relaxed text-muted">{step.detail}</span>
                </span>
              </button>
              <div className="flex items-center gap-2">
                <code className="safe-mono min-w-0 flex-1 border border-line bg-[#080b0f] px-2 py-1.5 font-mono text-[11px] text-muted">{step.command}</code>
                {step.id === "sidecar" ? (
                  <button
                    className="h-8 shrink-0 border border-safe/40 px-2 text-xs font-semibold text-safe transition hover:bg-safe/10 hover:text-ink disabled:cursor-wait disabled:opacity-60"
                    disabled={sidecarLaunchState === "starting" || startGate?.allowed === false}
                    title={startGate?.allowed === false ? startGate.reason : undefined}
                    onClick={onStartSidecar}
                  >
                    {sidecarLaunchState === "starting" ? "Starting" : "Start"}
                  </button>
                ) : (
                  <button
                    className="h-8 shrink-0 border border-signal/35 px-2 text-xs font-semibold text-signal transition hover:bg-signal/10 hover:text-ink"
                    onClick={() => copyCommand(step.id, step.command)}
                  >
                    {copied === step.id ? "Copied" : "Copy"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
