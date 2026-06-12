import type { DecisionEvent } from "../types";
import { DecisionRow } from "./DecisionRow";

interface DecisionFeedProps {
  events: DecisionEvent[];
  onReceiptClick: (event: DecisionEvent) => void;
  title?: string;
  subtitle?: string;
  badge?: string;
}

export function DecisionFeed({ events, onReceiptClick, title = "Realtime Decision Stream", subtitle = "Execution requests evaluated before runtime access", badge = "live" }: DecisionFeedProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col border border-line bg-panel shadow-operational">
      <header className="grid-safe grid min-h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-4 py-2">
        <div className="min-w-0">
          <h2 className="safe-text text-sm font-semibold text-ink">{title}</h2>
          <p className="safe-text text-xs text-muted">{subtitle}</p>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-safe" />
          <span className="safe-text">{badge}</span>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="min-w-[880px]">
          <div className="grid-safe grid grid-cols-[72px_86px_minmax(220px,1fr)_minmax(130px,0.65fr)_70px_minmax(112px,0.55fr)_minmax(120px,0.65fr)] gap-3 border-b border-line bg-[#0f1318] px-4 py-2 text-[10px] uppercase tracking-[0.08em] text-muted">
            <div>Time</div>
            <div>Verdict</div>
            <div>Action</div>
            <div>Reason</div>
            <div>Risk</div>
            <div>Policy</div>
            <div>Receipt</div>
          </div>
          {events.map((event) => (
            <DecisionRow event={event} key={event.id} onReceiptClick={onReceiptClick} />
          ))}
        </div>
      </div>
    </section>
  );
}
