import type { buildOperationalTimeline } from "../authority/trust";

type TimelineEvent = ReturnType<typeof buildOperationalTimeline>[number];

export function OperationalTimeline({ events }: { events: TimelineEvent[] }) {
  return (
    <section className="border border-line bg-panel">
      <header className="border-b border-line px-4 py-3">
        <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Operational Timeline</div>
      </header>
      <div className="max-h-[260px] overflow-auto">
        {events.length === 0 ? (
          <div className="p-4 text-sm text-muted">No live operational events reported.</div>
        ) : events.map((event, index) => (
          <article className="grid grid-cols-[84px_minmax(0,1fr)_116px] gap-3 border-b border-line/80 px-4 py-3 text-xs" key={`${event.timestamp}-${event.event}-${index}`}>
            <div className="font-mono text-muted">{event.timestamp}</div>
            <div className="min-w-0">
              <div className="font-semibold text-ink">{event.event}</div>
              <div className="mt-1 break-words text-muted">{event.runtimeImpact}</div>
              <div className="mt-1 font-mono text-[11px] text-muted">{event.actor} / {event.authorityScope}</div>
            </div>
            <div className="min-w-0 truncate text-right font-mono text-signal" title={event.receipt}>{event.receipt}</div>
          </article>
        ))}
      </div>
    </section>
  );
}
