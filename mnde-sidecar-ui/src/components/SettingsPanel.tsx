import type { AppSettings } from "../types";

interface SettingsPanelProps {
  open: boolean;
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onClose: () => void;
}

export function SettingsPanel({ open, settings, onChange, onClose }: SettingsPanelProps) {
  if (!open) return null;

  return (
    <div className="absolute inset-0 z-40 bg-black/45">
      <section className="absolute right-4 top-4 w-[440px] border border-line bg-[#0b0f13] shadow-operational">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Settings</div>
            <h2 className="text-base font-semibold text-ink">Sidecar Control</h2>
          </div>
          <button className="text-sm text-muted hover:text-ink" onClick={onClose}>Close</button>
        </header>
        <div className="space-y-4 p-4">
          <label className="block">
            <span className="label">Mode</span>
            <select className="input" value={settings.mode} onChange={(event) => onChange({ ...settings, mode: event.target.value === "live" ? "live" : "demo" })}>
              <option value="demo">Demo Mode</option>
              <option value="live">Live Mode</option>
            </select>
          </label>
          <label className="block">
            <span className="label">Sidecar endpoint</span>
            <input className="input" value={settings.sidecarEndpoint} onChange={(event) => onChange({ ...settings, sidecarEndpoint: event.target.value })} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Poll interval ms" value={settings.pollIntervalMs} onChange={(value) => onChange({ ...settings, pollIntervalMs: value })} />
            <NumberField label="Timeout ms" value={settings.requestTimeoutMs} onChange={(value) => onChange({ ...settings, requestTimeoutMs: value })} />
            <NumberField label="Receipt limit" value={settings.receiptLimit} onChange={(value) => onChange({ ...settings, receiptLimit: value })} />
            <NumberField label="Demo event ms" value={settings.demoEventRateMs} onChange={(value) => onChange({ ...settings, demoEventRateMs: value })} />
          </div>
          <Toggle label="Auto reconnect" checked={settings.enableAutoReconnect} onChange={(value) => onChange({ ...settings, enableAutoReconnect: value })} />
          <Toggle label="Native refusal notifications" checked={settings.enableNativeNotifications} onChange={(value) => onChange({ ...settings, enableNativeNotifications: value })} hint="Native notification bridge is disabled until explicitly configured." />
          <div className="border border-line bg-panel p-3 text-xs leading-relaxed text-muted">
            Live Mode never uses simulated telemetry. If an endpoint is missing or disconnected, the UI shows unavailable state instead of pretending protection is active.
          </div>
        </div>
      </section>
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input" type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (value: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start justify-between gap-3 border border-line bg-panel p-3">
      <span>
        <span className="block text-sm text-ink">{label}</span>
        {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
      </span>
      <input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
    </label>
  );
}
