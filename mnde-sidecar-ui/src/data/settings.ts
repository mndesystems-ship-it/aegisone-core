import type { AppSettings } from "../types";

export const defaultSettings: AppSettings = {
  mode: "live",
  sidecarEndpoint: "http://127.0.0.1:8787",
  pollIntervalMs: 2500,
  requestTimeoutMs: 1200,
  receiptLimit: 50,
  enableNativeNotifications: false,
  enableAutoReconnect: true,
  demoEventRateMs: 1450
};

const storageKey = "mnde.sidecar.ui.settings.v1";

export function loadSettings(storage: Storage = window.localStorage): AppSettings {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return defaultSettings;
    return sanitizeSettings({ ...defaultSettings, ...JSON.parse(raw) });
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(settings: AppSettings, storage: Storage = window.localStorage) {
  storage.setItem(storageKey, JSON.stringify(sanitizeSettings(settings)));
}

export function sanitizeSettings(settings: AppSettings): AppSettings {
  return {
    mode: settings.mode === "live" ? "live" : "demo",
    sidecarEndpoint: settings.sidecarEndpoint || defaultSettings.sidecarEndpoint,
    pollIntervalMs: clamp(settings.pollIntervalMs, 1000, 15000),
    requestTimeoutMs: clamp(settings.requestTimeoutMs, 500, 10000),
    receiptLimit: clamp(settings.receiptLimit, 5, 200),
    enableNativeNotifications: Boolean(settings.enableNativeNotifications),
    enableAutoReconnect: Boolean(settings.enableAutoReconnect),
    demoEventRateMs: clamp(settings.demoEventRateMs, 500, 8000)
  };
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
