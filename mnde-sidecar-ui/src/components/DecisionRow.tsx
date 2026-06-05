import type { DecisionEvent } from "../types";
import { riskClass, verdictClass } from "./status";

interface DecisionRowProps {
  event: DecisionEvent;
  onReceiptClick: (event: DecisionEvent) => void;
}

export function DecisionRow({ event, onReceiptClick }: DecisionRowProps) {
  return (
    <article className="group grid grid-cols-[72px_86px_minmax(180px,1fr)_116px_70px_92px_96px] items-center gap-3 border-b border-line/80 px-4 py-3 transition hover:bg-panel2">
      <div className="font-mono text-xs tabular-nums text-muted">{event.timestamp}</div>
      <div className={`w-fit border px-2 py-1 text-[11px] font-semibold ${verdictClass(event.verdict)}`}>{event.verdict}</div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-ink">{event.action}</div>
        <div className="mt-1 truncate text-xs text-muted">{event.explanation}</div>
      </div>
      <div className="truncate font-mono text-[11px] text-muted">{event.reason_code}</div>
      <div className={`w-fit border px-2 py-1 text-[11px] font-semibold ${riskClass(event.risk_level)}`}>{event.risk_level}</div>
      <div className="truncate font-mono text-[11px] text-muted">{event.policy_hash}</div>
      <button
        className="truncate text-left font-mono text-xs text-signal transition hover:text-ink"
        onClick={() => onReceiptClick(event)}
      >
        {event.receipt_id}
      </button>
    </article>
  );
}
