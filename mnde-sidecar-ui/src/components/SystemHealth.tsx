import type { HealthItem } from "../types";
import { healthClass } from "./status";

interface SystemHealthProps {
  health: HealthItem[];
}

export function SystemHealth({ health }: SystemHealthProps) {
  return (
    <section className="border border-line bg-panel">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">System Health</h2>
      </header>
      <div className="divide-y divide-line">
        {health.map((item) => (
          <div className="flex items-center justify-between px-4 py-3" key={item.name}>
            <div>
              <div className="text-sm text-ink">{item.name}</div>
              <div className="font-mono text-xs text-muted">{item.latencyMs} ms</div>
            </div>
            <div className={`flex items-center gap-2 text-xs font-semibold ${healthClass(item.state)}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {item.state}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
