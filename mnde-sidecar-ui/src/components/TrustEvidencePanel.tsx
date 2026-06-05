import type { TrustState } from "../authority/trust";

const stateClass = {
  fresh: "text-safe",
  stale: "text-danger",
  missing: "text-warn",
  valid: "text-safe",
  degraded: "text-danger",
  unverified: "text-warn"
};

export function TrustEvidencePanel({ trust }: { trust: TrustState }) {
  return (
    <section className="border border-line bg-panel">
      <header className="border-b border-line px-4 py-3">
        <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Freshness And Integrity</div>
      </header>
      <div className="grid grid-cols-2 gap-3 p-4">
        {trust.freshness.map((item) => (
          <EvidenceLine key={item.label} label={item.label} value={item.value} state={item.state} />
        ))}
        {trust.integrity.map((item) => (
          <EvidenceLine key={item.label} label={item.label} value={item.value} state={item.state} />
        ))}
      </div>
    </section>
  );
}

function EvidenceLine({ label, value, state }: { label: string; value: string; state: keyof typeof stateClass }) {
  return (
    <div className="min-w-0 border border-line bg-[#0d1116] p-3">
      <div className="text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={`mt-1 min-w-0 break-words font-mono text-xs font-semibold ${stateClass[state]}`}>{value}</div>
    </div>
  );
}
