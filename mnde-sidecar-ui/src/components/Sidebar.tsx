import type { AppMode, LiveConnectionState, SystemState } from "../types";
import { connectionClass, systemClass } from "./status";

interface SidebarProps {
  state: SystemState;
  mode: AppMode;
  liveConnectionState: LiveConnectionState | "DEMO_MODE";
  connection: string;
  activeView: AppView;
  onViewChange: (view: AppView) => void;
}

export type AppView = "Setup" | "Decision Stream" | "Demos" | "Receipts" | "Policies" | "Replay" | "Runtime" | "Audit" | "Access";

export const nav: AppView[] = ["Setup", "Decision Stream", "Demos", "Receipts", "Policies", "Replay", "Runtime", "Audit", "Access"];

const navLabels: Record<AppView, string> = {
  Setup: "Authority Setup",
  "Decision Stream": "Authority",
  Demos: "Demonstration",
  Receipts: "Receipts",
  Policies: "Policy",
  Replay: "Replay",
  Runtime: "Infrastructure",
  Audit: "Audit Record",
  Access: "Access"
};

function SidebarMark() {
  return (
    <svg aria-hidden="true" className="h-6 w-7" viewBox="0 0 56 36" role="img">
      <rect fill="#14a7df" height="4" opacity="0.72" width="22" x="4" y="16" />
      <rect fill="#eef2f6" height="16" opacity="0.78" width="7" x="30" y="10" />
      <rect fill="#eef2f6" height="16" opacity="0.78" width="7" x="42" y="10" />
      <rect fill="#eef2f6" height="4" opacity="0.72" width="7" x="49" y="16" />
    </svg>
  );
}

export function Sidebar({ state, mode, liveConnectionState, connection, activeView, onViewChange }: SidebarProps) {
  return (
    <aside className="flex h-full w-[236px] shrink-0 flex-col border-r border-line bg-[#0b0d10]">
      <div className="border-b border-line px-5 py-5">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center border border-signal/30 bg-[#10171d]">
            <SidebarMark />
          </div>
          <div>
            <div className="text-lg font-semibold tracking-normal text-ink">MNDe</div>
            <div className="text-xs uppercase tracking-[0.16em] text-muted">Authority System</div>
          </div>
        </div>
        <div className={`mt-5 inline-flex items-center gap-2 border px-2.5 py-1.5 text-xs font-semibold ${systemClass(state)}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {state}
        </div>
      </div>

      <nav className="flex-1 px-3 py-4">
        {nav.map((item) => (
          <button
            className={`mb-1 flex h-9 w-full items-center justify-between px-3 text-left text-sm transition hover:bg-panel2 hover:text-ink ${
              item === activeView ? "border-l-2 border-signal bg-panel2 text-ink" : "text-muted"
            }`}
            key={item}
            onClick={() => onViewChange(item)}
            type="button"
          >
            <span>{navLabels[item]}</span>
            {item === "Receipts" && <span className="font-mono text-[11px] text-signal">{mode}</span>}
          </button>
        ))}
      </nav>

      <div className="border-t border-line p-4">
        <div className="mb-3 text-xs uppercase tracking-[0.14em] text-muted">Connection</div>
        <div className="mb-4 border border-line bg-panel px-3 py-2 text-xs text-ink">
          <div className={`mb-2 inline-flex items-center gap-2 border px-2 py-1 ${connectionClass(liveConnectionState)}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {mode === "demo" ? "Demo Mode" : liveConnectionState}
          </div>
          <div className="leading-relaxed text-muted">{connection}</div>
        </div>
        <div className="text-xs text-muted">MNDe Sidecar v0.5.0</div>
      </div>
    </aside>
  );
}
