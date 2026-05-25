import type { DecisionEvent } from "../types";
import { DecisionRow } from "./DecisionRow";

interface DecisionFeedProps {
  events: DecisionEvent[];
  onReceiptClick: (event: DecisionEvent) => void;
}

export function DecisionFeed({ events, onReceiptClick }: DecisionFeedProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col border border-line bg-panel shadow-operational">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Realtime Decision Stream</h2>
          <p className="text-xs text-muted">Execution requests evaluated before runtime access</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-safe" />
          live
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="min-w-[820px]">
          <div className="grid grid-cols-[72px_86px_minmax(180px,1fr)_116px_70px_92px_96px] gap-3 border-b border-line bg-[#0f1318] px-4 py-2 text-[10px] uppercase tracking-[0.08em] text-muted">
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
