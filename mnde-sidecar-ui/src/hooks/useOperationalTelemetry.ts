import { useEffect, useRef, useState } from "react";
import { EndpointUnavailableError, EndpointUnsupportedError, fetchLiveSnapshot } from "../api/sidecarClient";
import { advanceTelemetry, makeDisconnectedLiveTelemetry, makeInitialTelemetry } from "../data/telemetry";
import type { AppLog, AppSettings, TelemetryState } from "../types";

export function useOperationalTelemetry(settings: AppSettings) {
  const tickRef = useRef(1);
  const backoffRef = useRef(settings.pollIntervalMs);
  const [telemetry, setTelemetry] = useState<TelemetryState>(() => makeInitialTelemetry());
  const [logs, setLogs] = useState<AppLog[]>(() => [makeLog("info", "app", "MNDe UI initialized.")]);

  useEffect(() => {
    let cancelled = false;
    let timeout: number | undefined;

    function appendLog(severity: AppLog["severity"], source: string, message: string) {
      setLogs((current) => [makeLog(severity, source, message), ...current].slice(0, 250));
    }

    if (settings.mode === "demo") {
      setTelemetry(makeInitialTelemetry());
      appendLog("info", "mode", "Demo Mode enabled. Events are simulated.");
      timeout = window.setInterval(() => {
        const tick = tickRef.current++;
        setTelemetry((current) => advanceTelemetry(current, tick));
      }, settings.demoEventRateMs);

      return () => {
        cancelled = true;
        if (timeout) window.clearInterval(timeout);
      };
    }

    appendLog("info", "mode", `Live Mode enabled. Polling ${settings.sidecarEndpoint}.`);

    async function poll() {
      if (cancelled) return;
      try {
        const snapshot = await fetchLiveSnapshot(settings);
        backoffRef.current = settings.pollIntervalMs;
        setTelemetry(snapshot.telemetry);
        for (const message of snapshot.logs) appendLog("warning", "api", message);
        appendLog("info", "api", snapshot.telemetry.statusMessage);
      } catch (error) {
        const unsupported = error instanceof EndpointUnsupportedError;
        const message = error instanceof Error ? error.message : "MNDe sidecar disconnected.";
        setTelemetry((current) => ({
          ...makeDisconnectedLiveTelemetry(current, unsupported),
          nextRetryMs: settings.enableAutoReconnect ? backoffRef.current : undefined
        }));
        appendLog(error instanceof EndpointUnavailableError ? "error" : "warning", "api", message);
        backoffRef.current = Math.min(backoffRef.current * 2, 15000);
      }

      if (!cancelled && settings.enableAutoReconnect) {
        timeout = window.setTimeout(poll, backoffRef.current);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timeout) window.clearTimeout(timeout);
    };
  }, [settings]);

  return { telemetry, logs, setLogs };
}

function makeLog(severity: AppLog["severity"], source: string, message: string): AppLog {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toLocaleTimeString(),
    severity,
    source,
    message
  };
}
