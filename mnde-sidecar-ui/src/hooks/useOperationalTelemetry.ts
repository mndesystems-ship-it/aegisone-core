import { useEffect, useRef, useState } from "react";
import { EndpointUnavailableError, EndpointUnsupportedError, fetchLiveSnapshot } from "../api/sidecarClient";
import { advanceTelemetry, makeDisconnectedLiveTelemetry, makeInitialTelemetry } from "../data/telemetry";
import { isStressUiRequested, makeStressLogs, makeStressTelemetry } from "../data/stressTelemetry";
import { buildLiveDemoOverlay, fetchLiveDemoEvidence, type LiveDemoOverlay } from "../liveDemo/evidence";
import type { AppLog, AppSettings, TelemetryState } from "../types";

export function useOperationalTelemetry(settings: AppSettings, liveDemo = false) {
  const tickRef = useRef(1);
  const backoffRef = useRef(settings.pollIntervalMs);
  const [telemetry, setTelemetry] = useState<TelemetryState>(() => makeInitialTelemetry());
  const [logs, setLogs] = useState<AppLog[]>(() => [makeLog("info", "app", "MNDe UI initialized.")]);
  const [liveDemoOverlay, setLiveDemoOverlay] = useState<LiveDemoOverlay>(() => ({ events: [] }));

  useEffect(() => {
    let cancelled = false;
    let timeout: number | undefined;

    function appendLog(severity: AppLog["severity"], source: string, message: string) {
      setLogs((current) => [makeLog(severity, source, message), ...current].slice(0, 250));
    }

    if (settings.mode === "demo" && !liveDemo) {
      const stress = isStressUiRequested();
      setTelemetry(stress ? makeStressTelemetry(makeInitialTelemetry()) : makeInitialTelemetry());
      if (stress) setLogs(makeStressLogs());
      appendLog("info", "mode", stress ? "Stress UI mode enabled. Hostile text payloads loaded." : "Demo Mode enabled. Events are simulated.");
      timeout = window.setInterval(() => {
        const tick = tickRef.current++;
        setTelemetry((current) => stress ? makeStressTelemetry(current) : advanceTelemetry(current, tick));
      }, settings.demoEventRateMs);

      return () => {
        cancelled = true;
        if (timeout) window.clearInterval(timeout);
      };
    }

    appendLog("info", "mode", liveDemo ? `Live Demo Mode enabled. Polling ${settings.sidecarEndpoint}.` : `Live Mode enabled. Polling ${settings.sidecarEndpoint}.`);

    async function poll() {
      if (cancelled) return;
      try {
        const [snapshot, demoEvidence] = await Promise.all([
          fetchLiveSnapshot(settings),
          liveDemo ? fetchLiveDemoEvidence().catch(() => undefined) : Promise.resolve(undefined)
        ]);
        const overlay = buildLiveDemoOverlay(demoEvidence);
        backoffRef.current = settings.pollIntervalMs;
        setLiveDemoOverlay(overlay);
        setTelemetry(overlay.events.length > 0 ? overlayTelemetry(snapshot.telemetry, overlay) : snapshot.telemetry);
        for (const message of snapshot.logs) appendLog("warning", "api", message);
        appendLog("info", liveDemo ? "live-demo" : "api", overlay.evidence ? `Live demo ${overlay.evidence.status}: ${overlay.evidence.verdict}` : snapshot.telemetry.statusMessage);
      } catch (error) {
        const demoEvidence = liveDemo ? await fetchLiveDemoEvidence().catch(() => undefined) : undefined;
        const overlay = buildLiveDemoOverlay(demoEvidence);
        setLiveDemoOverlay(overlay);
        const unsupported = error instanceof EndpointUnsupportedError;
        const message = error instanceof Error ? error.message : "MNDe sidecar disconnected.";
        setTelemetry((current) => overlayTelemetry({
          ...makeDisconnectedLiveTelemetry(current, unsupported),
          nextRetryMs: settings.enableAutoReconnect ? backoffRef.current : undefined
        }, overlay));
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

  return { telemetry, logs, setLogs, liveDemoOverlay };
}

function overlayTelemetry(telemetry: TelemetryState, overlay: LiveDemoOverlay): TelemetryState {
  if (overlay.events.length === 0) return telemetry;
  const events = [...overlay.events, ...telemetry.events].slice(0, 80);
  const latestRefusal = events.find((event) => event.verdict === "REFUSE");
  const finalPass = overlay.final?.verdict === "PASS";
  const liveDemoAttached = Boolean(overlay.evidence);
  return {
    ...telemetry,
    systemState: finalPass ? "ACTIVE" : telemetry.systemState,
    liveConnectionState: liveDemoAttached ? "CONNECTED" : telemetry.liveConnectionState,
    connectionState: finalPass ? "MNDe live demo attached to real runtime." : telemetry.connectionState,
    events,
    latestRefusal,
    statusMessage: overlay.evidence ? `Live Demo Mode: ${overlay.evidence.status.toUpperCase()} / ${overlay.evidence.verdict}` : telemetry.statusMessage,
    metrics: {
      ...telemetry.metrics,
      allows: events.filter((event) => event.verdict === "ALLOW").length,
      refuses: events.filter((event) => event.verdict === "REFUSE").length,
      replayDrift: overlay.replay?.drift ?? telemetry.metrics.replayDrift,
      signerStatus: overlay.authority?.signature_verification === "VALID" ? "Healthy" : telemetry.metrics.signerStatus,
      sidecarConnectionState: liveDemoAttached ? "CONNECTED" : telemetry.metrics.sidecarConnectionState
    },
    health: liveDemoAttached ? telemetry.health.map((item) => ({ ...item, state: "Healthy" })) : telemetry.health,
    proof: liveDemoAttached ? {
      ...telemetry.proof,
      healthEndpointOk: true,
      readyEndpointOk: true,
      metricsEndpointOk: true,
      receiptsEndpointOk: true,
      lastSidecarContactMs: Date.now(),
      lastSignerHeartbeatMs: Date.now(),
      lastPolicyVerificationMs: Date.now(),
      lastReplayVerificationMs: overlay.replay ? Date.now() : telemetry.proof?.lastReplayVerificationMs,
      receiptPersistenceLagMs: 0,
      runtimeTelemetryAgeMs: 0
    } : telemetry.proof,
    integrity: {
      ...telemetry.integrity,
      receiptSignatureValidity: overlay.replay?.receipt_verification ?? telemetry.integrity?.receiptSignatureValidity,
      replayReproducibilityState: overlay.replay?.deterministic_parity ? "VALID" : telemetry.integrity?.replayReproducibilityState
    }
  };
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
