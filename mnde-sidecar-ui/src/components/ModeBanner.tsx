import type { AppSettings, TelemetryState } from "../types";
import type { SidecarLaunchState } from "../desktop/sidecarControl";

interface ModeBannerProps {
  settings: AppSettings;
  telemetry: TelemetryState;
  onOpenSettings: () => void;
  onStartSidecar: () => void;
  sidecarLaunchMessage?: string;
  sidecarLaunchState: SidecarLaunchState;
  authorityReady: boolean;
}

export function ModeBanner({ settings, telemetry, onOpenSettings, onStartSidecar, sidecarLaunchMessage, sidecarLaunchState, authorityReady }: ModeBannerProps) {
  const demo = settings.mode === "demo";
  const tone = demo ? "border-warn/35 bg-warn/10 text-warn" : telemetry.liveConnectionState === "CONNECTED" ? "border-safe/30 bg-safe/10 text-safe" : "border-danger/35 bg-danger/10 text-danger";
  const canStartSidecar = !demo && authorityReady && telemetry.liveConnectionState !== "CONNECTED" && telemetry.liveConnectionState !== "REFUSING";
  const startLabel = sidecarLaunchState === "starting" ? "Starting..." : sidecarLaunchState === "started" ? "Start Requested" : "Start Sidecar";

  return (
    <div className={`flex items-center justify-between gap-4 border px-4 py-2 text-sm ${tone}`}>
      <div className="min-w-0">
        <span className="font-semibold">{demo ? "DEMO MODE" : telemetry.liveConnectionState}</span>
        <span className="ml-3 text-ink/80">{demo ? "Demo Mode. Events are simulated." : authorityReady ? telemetry.statusMessage : "AUTH REQUIRED. Live authority is locked."}</span>
        {sidecarLaunchMessage ? <span className="ml-3 font-mono text-[11px] text-ink/60">{sidecarLaunchMessage}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canStartSidecar ? (
          <button
            className="border border-current/30 px-3 py-1 text-xs font-semibold transition hover:bg-white/5 disabled:cursor-wait disabled:opacity-60"
            disabled={sidecarLaunchState === "starting"}
            onClick={onStartSidecar}
          >
            {startLabel}
          </button>
        ) : null}
        <button className="border border-current/30 px-3 py-1 text-xs font-semibold transition hover:bg-white/5" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
    </div>
  );
}
