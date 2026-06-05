import { useEffect, useMemo, useRef, useState } from "react";
import { advanceTelemetry, makeInitialTelemetry } from "../data/telemetry";

export function useTelemetry() {
  const initial = useMemo(() => makeInitialTelemetry(), []);
  const tickRef = useRef(1);
  const [telemetry, setTelemetry] = useState(initial);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const nextTick = tickRef.current;
      setTelemetry((current) => advanceTelemetry(current, nextTick));
      tickRef.current = nextTick + 1;
    }, 1450);

    return () => window.clearInterval(interval);
  }, []);

  return telemetry;
}
