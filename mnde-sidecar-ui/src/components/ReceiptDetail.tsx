import { useMemo, useState } from "react";
import { verifyReceipt } from "../api/sidecarClient";
import type { AppSettings, DecisionEvent, VerificationState, VerifyResult } from "../types";
import { mapReadableReason } from "../onboarding/setupModel";

interface ReceiptDetailProps {
  receipt?: DecisionEvent;
  settings: AppSettings;
  onClose: () => void;
}

export function ReceiptDetail({ receipt, settings, onClose }: ReceiptDetailProps) {
  const [verification, setVerification] = useState<VerifyResult | undefined>();
  const raw = useMemo(() => JSON.stringify(receipt?.raw_receipt ?? receipt ?? {}, null, 2), [receipt]);
  if (!receipt) return null;
  const currentReceipt = receipt;
  const readableReason = mapReadableReason(receipt.reason_code);

  async function runVerify() {
    setVerification({ state: "PENDING", message: "Verifying receipt...", checkedAt: new Date().toLocaleTimeString() });
    setVerification(await verifyReceipt(settings, currentReceipt));
  }

  function copy(value: string) {
    void navigator.clipboard.writeText(value);
  }

  async function exportReceipt() {
    if ("__TAURI_INTERNALS__" in window) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("export_receipt_json", { receiptId: currentReceipt.receipt_id, body: raw });
      return;
    }
    const blob = new Blob([raw], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${currentReceipt.receipt_id.replace(/\./g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="absolute inset-0 z-30 bg-black/40">
      <section className="absolute bottom-4 left-[260px] right-[384px] top-4 flex flex-col border border-line bg-[#0b0f13] shadow-operational">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Receipt Detail</div>
            <h2 className="font-mono text-base font-semibold text-ink">{receipt.receipt_id}</h2>
          </div>
          <button className="text-sm text-muted hover:text-ink" onClick={onClose}>Close</button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)]">
          <div className="space-y-3 overflow-auto border-r border-line p-4">
            <Detail label="Timestamp" value={receipt.timestamp} />
            <Detail label="Verdict" value={receipt.verdict} />
            <Detail label="Readable Explanation" value={readableReason.summary} />
            <Detail label="Reason Code" value={readableReason.technicalCode} mono />
            <Detail label="Request Hash" value={receipt.request_hash} mono action={() => copy(receipt.request_hash)} />
            <Detail label="Decision Hash" value={receipt.decision_hash} mono action={() => copy(receipt.decision_hash)} />
            <Detail label="Policy Hash" value={receipt.policy_hash} mono action={() => copy(receipt.policy_hash)} />
            <Detail label="Canonical Payload Hash" value={receipt.canonical_payload_hash} mono />
            <Detail label="Signature Status" value={receipt.signature_status} />
            <Detail label="Replay Status" value={receipt.replay_status} />
            <Detail label="Policy Source" value={receipt.policy_source} />
            <Detail label="Action Summary" value={receipt.action} />
            <Detail label="Prevented Impact Estimate" value={receipt.prevented_impact} />
            {verification && <VerificationBadge state={verification.state} message={verification.message} />}
            <div className="grid grid-cols-2 gap-2">
              <button className="button" onClick={() => copy(raw)}>Copy Receipt</button>
              <button className="button" onClick={() => copy(receipt.receipt_id)}>Copy ID</button>
              <button className="button" onClick={exportReceipt}>Export JSON</button>
              <button className="button signal" onClick={runVerify}>Verify Receipt</button>
            </div>
          </div>
          <pre className="min-h-0 overflow-auto p-4 font-mono text-xs leading-relaxed text-muted">{raw}</pre>
        </div>
      </section>
    </div>
  );
}

function Detail({ label, value, mono, action }: { label: string; value: string; mono?: boolean; action?: () => void }) {
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <button className={`${mono ? "font-mono" : ""} text-left text-sm text-ink ${action ? "hover:text-signal" : ""}`} onClick={action}>{value}</button>
    </div>
  );
}

function VerificationBadge({ state, message }: { state: VerificationState; message: string }) {
  const tone = state === "VALID" ? "border-safe/30 bg-safe/10 text-safe" : state === "PENDING" ? "border-signal/30 bg-signal/10 text-signal" : "border-danger/35 bg-danger/10 text-danger";
  return <div className={`border px-3 py-2 text-sm ${tone}`}>{message}</div>;
}
