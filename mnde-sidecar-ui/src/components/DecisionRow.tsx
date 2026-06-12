import type { DecisionEvent } from "../types";
import { riskClass, verdictClass } from "./status";

interface DecisionRowProps {
  event: DecisionEvent;
  onReceiptClick: (event: DecisionEvent) => void;
}

export function DecisionRow({ event, onReceiptClick }: DecisionRowProps) {
  return (
    <article className="grid-safe group grid grid-cols-[72px_86px_minmax(220px,1fr)_minmax(130px,0.65fr)_70px_minmax(112px,0.55fr)_minmax(120px,0.65fr)] items-start gap-3 border-b border-line/80 px-4 py-3 transition hover:bg-panel2">
      <div className="font-mono text-xs tabular-nums text-muted">{event.timestamp}</div>
      <div className={`w-fit border px-2 py-1 text-[11px] font-semibold ${verdictClass(event.verdict)}`}>{event.verdict}</div>
      <div className="min-w-0">
        <div className="safe-text text-sm font-medium text-ink">{event.action}</div>
        <div className="safe-text mt-1 text-xs text-muted">{event.explanation}</div>
      </div>
      <div className="safe-mono font-mono text-[11px] text-muted">{event.reason_code}</div>
      <div className={`w-fit border px-2 py-1 text-[11px] font-semibold ${riskClass(event.risk_level)}`}>{event.risk_level}</div>
      <div className="safe-mono font-mono text-[11px] text-muted">{event.policy_hash}</div>
      <button
        className="safe-mono max-w-full text-left font-mono text-xs text-signal transition hover:text-ink"
        onClick={() => onReceiptClick(event)}
      >
        {event.receipt_id}
      </button>
    </article>
  );
}
