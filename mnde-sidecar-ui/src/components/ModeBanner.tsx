import type { AppSettings, TelemetryState } from "../types";
import type { SidecarLaunchState } from "../desktop/sidecarControl";

interface ModeBannerProps {
  settings: AppSettings;
  telemetry: TelemetryState;
  onOpenSettings: () => void;
  onStartSidecar: () => void;
  onStartLiveDemo: () => void;
  sidecarLaunchMessage?: string;
  sidecarLaunchState: SidecarLaunchState;
  liveDemoLaunchState: SidecarLaunchState;
  authorityReady: boolean;
}

export function ModeBanner({ settings, telemetry, onOpenSettings, onStartSidecar, onStartLiveDemo, sidecarLaunchMessage, sidecarLaunchState, liveDemoLaunchState, authorityReady }: ModeBannerProps) {
  const demo = settings.mode === "demo";
  const tone = demo ? "border-warn/35 bg-warn/10 text-warn" : telemetry.liveConnectionState === "CONNECTED" ? "border-safe/30 bg-safe/10 text-safe" : "border-danger/35 bg-danger/10 text-danger";
  const canStartSidecar = !demo && authorityReady && telemetry.liveConnectionState !== "CONNECTED" && telemetry.liveConnectionState !== "REFUSING";
  const startLabel = sidecarLaunchState === "starting" ? "Starting..." : sidecarLaunchState === "started" ? "Start Requested" : "Start Sidecar";
  const liveDemoLabel = liveDemoLaunchState === "starting" ? "Starting Demo..." : liveDemoLaunchState === "started" ? "Demo Started" : "Start Live Demo";

  return (
    <div className={`grid-safe grid grid-cols-1 items-start gap-3 border px-4 py-2 text-sm xl:grid-cols-[minmax(0,1fr)_auto] ${tone}`}>
      <div className="min-w-0 space-y-1">
        <div className="grid-safe flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="safe-mono font-semibold">{demo ? "DEMO MODE" : telemetry.liveConnectionState}</span>
          <span className="safe-text text-ink/80">{demo ? "Demo Mode. Events are simulated." : authorityReady ? telemetry.statusMessage : "AUTH REQUIRED. Live authority is locked."}</span>
        </div>
        {sidecarLaunchMessage ? <div className="safe-mono font-mono text-[11px] text-ink/60">{sidecarLaunchMessage}</div> : null}
      </div>
      <div className="grid-safe grid grid-cols-1 gap-2 sm:grid-cols-3 xl:flex xl:shrink-0 xl:items-center">
        <button
          className="min-h-8 border border-current/30 px-3 py-1 text-xs font-semibold transition hover:bg-white/5 disabled:cursor-wait disabled:opacity-60"
          disabled={liveDemoLaunchState === "starting"}
          onClick={onStartLiveDemo}
          type="button"
        >
          {liveDemoLabel}
        </button>
        {canStartSidecar ? (
          <button
            className="min-h-8 border border-current/30 px-3 py-1 text-xs font-semibold transition hover:bg-white/5 disabled:cursor-wait disabled:opacity-60"
            disabled={sidecarLaunchState === "starting"}
            onClick={onStartSidecar}
            type="button"
          >
            {startLabel}
          </button>
        ) : null}
        <button className="min-h-8 border border-current/30 px-3 py-1 text-xs font-semibold transition hover:bg-white/5" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
    </div>
  );
}
