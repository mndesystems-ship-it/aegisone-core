import { useState } from "react";
import type { DecisionEvent } from "../types";
import { riskClass } from "./status";

interface RiskPanelProps {
  latestRefusal?: DecisionEvent;
  selectedReceipt?: DecisionEvent;
  onOpenReceipt: (event: DecisionEvent) => void;
}

export function RiskPanel({ latestRefusal, selectedReceipt, onOpenReceipt }: RiskPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const receipt = selectedReceipt ?? latestRefusal;

  if (!latestRefusal) {
    return (
      <aside className="hidden w-[320px] shrink-0 flex-col gap-3 overflow-x-hidden border-l border-line bg-[#0b0d10] p-3 2xl:flex">
        <section className="authority-panel p-4">
          <div className="authority-eyebrow mb-1">Refusal Record</div>
          <h2 className="min-w-0 break-words text-lg font-semibold leading-tight text-ink">No refusal receipt recorded</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted">Live Mode displays signed refusal receipts only. If disconnected, no protection claim is made.</p>
        </section>
      </aside>
    );
  }

  return (
    <aside className="hidden w-[320px] shrink-0 flex-col gap-3 overflow-x-hidden border-l border-line bg-[#0b0d10] p-3 2xl:flex">
      <section className="min-w-0 border border-danger/40 bg-danger/10">
        <header className="border-b border-danger/25 px-4 py-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-danger">Refusal Record</div>
          <h2 className="min-w-0 break-words text-base font-semibold leading-tight text-ink">{latestRefusal.action}</h2>
        </header>
        <div className="space-y-4 px-4 py-4">
          <Field label="Verdict" value={latestRefusal.verdict} />
          <Field label="Reason Code" value={latestRefusal.reason_code} mono />
          <Field label="Command" value={latestRefusal.command_preview} mono />
          <Field label="Policy" value={latestRefusal.policy} />
          <Field label="Policy Hash" value={latestRefusal.policy_hash} mono />
          <Field label="Policy-Declared Impact Estimate" value={latestRefusal.prevented_impact} strong />
          <Field label="Calculation Basis" value={latestRefusal.prevented_cost_usd === undefined || latestRefusal.prevented_cost_usd === null ? "sidecar receipt text; verified cost not reported" : "sidecar reported prevented_cost_usd"} />
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted">Risk Level</div>
            <div className={`inline-flex border px-2.5 py-1 text-xs font-semibold ${riskClass(latestRefusal.risk_level)}`}>{latestRefusal.risk_level}</div>
          </div>
          <Field label="Receipt ID" value={latestRefusal.receipt_id} mono />
          <Field label="Request Hash" value={latestRefusal.request_hash} mono />
          <Field label="Decision Hash" value={latestRefusal.decision_hash} mono />
          <Field label="Timestamp" value={latestRefusal.timestamp} mono />
          <button className="h-9 w-full border border-signal/40 bg-signal/10 text-sm font-semibold text-signal transition hover:bg-signal/15 hover:text-ink" onClick={() => onOpenReceipt(latestRefusal)}>
            Open Refusal Receipt
          </button>
        </div>
      </section>

      <section className="min-w-0 border border-line bg-panel">
        <button className="flex h-11 w-full items-center justify-between px-4 text-left" onClick={() => setExpanded((value) => !value)}>
          <span className="text-sm font-semibold text-ink">Receipt Record</span>
          <span className="font-mono text-xs text-muted">{expanded ? "open" : "closed"}</span>
        </button>
        {expanded && (
          <div className="space-y-3 border-t border-line px-4 py-3">
            {receipt ? (
              <>
                <Field label="Selected Receipt" value={receipt.receipt_id} mono />
                <Field label="Canonical Policy" value={receipt.policy} />
                <Field label="Signer Latency" value={`${receipt.signer_latency_ms} ms`} />
                <Field label="Replay Drift" value={`${receipt.replay_drift}`} />
              </>
            ) : null}
            <div className="safe-mono min-w-0 overflow-auto border border-line bg-[#0d1116] p-3 font-mono text-xs leading-relaxed text-muted">
              {receipt?.command_preview ?? "No receipt selected."}
            </div>
          </div>
        )}
      </section>
    </aside>
  );
}

function Field({ label, value, mono, strong }: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div
        className={`${mono ? "safe-mono font-mono" : "safe-text"} ${strong ? "text-danger" : "text-ink"} min-w-0 text-sm leading-relaxed`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}
