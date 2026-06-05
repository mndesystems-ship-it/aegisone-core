import type { TopMetrics } from "../types";
import { MetricCard } from "./MetricCard";

interface StatusCardsProps {
  metrics: TopMetrics;
}

export function StatusCards({ metrics }: StatusCardsProps) {
  return (
    <section className="grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-6">
      <MetricCard label="Policy" value={metrics.policyName} detail={metrics.policyHash} tone="signal" />
      <MetricCard label="Signer" value={metrics.signerStatus} detail={`${metrics.signerLatencyMs} ms latency`} tone={metrics.signerStatus === "Healthy" ? "safe" : "warn"} />
      <MetricCard label="Uptime" value={metrics.uptime} detail="continuous protection" tone="idle" />
      <MetricCard label="Decisions/sec" value={metrics.decisionsPerSecond} detail="rolling 30s" tone="signal" />
      <MetricCard label="Allows" value={metrics.allows} detail="recent window" tone="safe" />
      <MetricCard label="Refuses" value={metrics.refuses} detail="damage prevented" tone="danger" />
      <MetricCard label="Replay drift" value={metrics.replayDrift} detail="canonical mismatch count" tone="safe" />
      <MetricCard label="Queue pressure" value={`${metrics.queuePressure}%`} detail="sidecar ingress" tone={metrics.queuePressure > 75 ? "warn" : "idle"} />
      <MetricCard label="Workers" value={`${metrics.workerSaturation}%`} detail="runtime saturation" tone={metrics.workerSaturation > 80 ? "warn" : "idle"} />
      <MetricCard label="Sidecar" value={metrics.sidecarConnectionState} detail="connection state" tone={metrics.sidecarConnectionState === "CONNECTED" ? "safe" : metrics.sidecarConnectionState === "DEMO_MODE" ? "warn" : "danger"} />
    </section>
  );
}
