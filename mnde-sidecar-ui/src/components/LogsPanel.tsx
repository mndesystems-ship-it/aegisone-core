import { useMemo, useState } from "react";
import type { AppLog, LogSeverity } from "../types";

interface LogsPanelProps {
  logs: AppLog[];
  onClear: () => void;
}

export function LogsPanel({ logs, onClear }: LogsPanelProps) {
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<LogSeverity | "all">("all");
  const filtered = useMemo(
    () => logs.filter((log) => (severity === "all" || log.severity === severity) && `${log.source} ${log.message}`.toLowerCase().includes(query.toLowerCase())),
    [logs, query, severity]
  );

  return (
    <section className="max-h-[210px] border border-line bg-panel">
      <header className="flex h-10 items-center justify-between border-b border-line px-3">
        <div className="text-sm font-semibold text-ink">Operational Logs</div>
        <div className="flex items-center gap-2">
          <input aria-label="Search logs" className="h-7 w-32 border border-line bg-[#080b0f] px-2 text-xs text-ink outline-none" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select className="h-7 border border-line bg-[#080b0f] px-2 text-xs text-ink outline-none" value={severity} onChange={(event) => setSeverity(event.target.value as LogSeverity | "all")}>
            <option value="all">All</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </select>
          <button className="h-7 border border-line px-2 text-xs text-muted hover:text-ink" onClick={onClear}>Clear</button>
        </div>
      </header>
      <div className="max-h-[168px] overflow-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted">No logs match the current filter.</div>
        ) : (
          filtered.map((log) => (
            <div className="grid grid-cols-[72px_70px_86px_minmax(0,1fr)] gap-2 border-b border-line/70 px-3 py-2 text-xs" key={log.id}>
              <span className="font-mono text-muted">{log.timestamp}</span>
              <span className={log.severity === "error" ? "text-danger" : log.severity === "warning" ? "text-warn" : "text-signal"}>{log.severity}</span>
              <span className="text-muted">{log.source}</span>
              <span className="truncate text-ink">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
