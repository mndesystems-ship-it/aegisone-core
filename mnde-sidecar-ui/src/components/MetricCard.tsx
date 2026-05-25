interface MetricCardProps {
  label: string;
  value: string | number;
  detail?: string;
  tone?: "safe" | "warn" | "danger" | "signal" | "idle";
}

const toneClass = {
  safe: "text-safe",
  warn: "text-warn",
  danger: "text-danger",
  signal: "text-signal",
  idle: "text-idle"
};

export function MetricCard({ label, value, detail, tone = "idle" }: MetricCardProps) {
  return (
    <div className="min-h-[96px] min-w-0 border border-line bg-panel px-4 py-3 transition hover:border-signal/25">
      <div className="mb-2 text-[10px] uppercase tracking-[0.1em] text-muted">{label}</div>
      <div className={`min-w-0 overflow-hidden break-words font-mono text-lg font-semibold leading-tight tabular-nums ${toneClass[tone]}`}>{value}</div>
      {detail && <div className="mt-2 min-w-0 overflow-hidden break-words text-xs leading-snug text-muted">{detail}</div>}
    </div>
  );
}
