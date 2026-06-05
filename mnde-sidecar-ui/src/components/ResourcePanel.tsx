import type { ResourceMetrics } from "../types";

interface ResourcePanelProps {
  resources: ResourceMetrics;
}

export function ResourcePanel({ resources }: ResourcePanelProps) {
  return (
    <section className="grid grid-cols-1 gap-2">
      <ResourceBar label="CPU" value={resources.cpu} />
      <ResourceBar label="Memory" value={resources.memory} />
      <ResourceBar label="Disk IO" value={resources.diskIo} />
      <ResourceBar label="Decision Throughput" value={resources.decisionThroughput} max={190} suffix="/s" />
    </section>
  );
}

function ResourceBar({ label, value, max = 100, suffix = "%" }: { label: string; value: number; max?: number; suffix?: string }) {
  const width = Math.min(100, Math.round((value / max) * 100));
  const tone = width > 78 ? "bg-warn" : "bg-signal";

  return (
    <div className="border border-line bg-panel px-3 py-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="font-mono text-ink tabular-nums">{value}{suffix}</span>
      </div>
      <div className="h-1.5 bg-[#080b0f]">
        <div className={`h-full transition-all duration-500 ${tone}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}
