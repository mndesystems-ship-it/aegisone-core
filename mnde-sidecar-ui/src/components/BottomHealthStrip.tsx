import type { HealthItem } from "../types";
import { healthClass } from "./status";

interface BottomHealthStripProps {
  health: HealthItem[];
}

export function BottomHealthStrip({ health }: BottomHealthStripProps) {
  const parser = health.find((item) => item.name === "Parser (MCJ-1)");
  const signer = health.find((item) => item.name === "Signer");
  const storage = health.find((item) => item.name === "Storage");
  const runtime = health.find((item) => item.name === "Policy Engine");
  const api = health.find((item) => item.name === "API");

  return (
    <footer className="grid h-12 shrink-0 grid-cols-5 border-t border-line bg-[#0b0f13]">
      <StripItem label="Parser" item={api} />
      <StripItem label="MCJ-1" item={parser} />
      <StripItem label="Signer" item={signer} />
      <StripItem label="Storage" item={storage} />
      <StripItem label="Runtime" item={runtime} />
    </footer>
  );
}

function StripItem({ label, item }: { label: string; item?: HealthItem }) {
  return (
    <div className="flex items-center justify-between border-r border-line px-4 text-xs last:border-r-0">
      <span className="uppercase tracking-[0.12em] text-muted">{label}</span>
      <span className={`font-semibold ${healthClass(item?.state ?? "Failed")}`}>{item?.state ?? "Failed"}</span>
    </div>
  );
}
