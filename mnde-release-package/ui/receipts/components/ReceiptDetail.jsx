import React from "react";
import { CopyValue } from "./CopyValue.jsx";
import { JsonPanel } from "./JsonPanel.jsx";

export function ReceiptDetail({ receipt }) {
  if (!receipt) return <section className="panel empty">Select a receipt.</section>;
  return (
    <section className="panel detail">
      <div className="panel-title">Receipt detail</div>
      <div className="status-line">
        <strong>{receipt.decision}</strong>
        <span>{receipt.reason_code}</span>
        <span>{receipt.translation?.short_message}</span>
      </div>
      <CopyValue label="receipt_id" value={receipt.receipt_hash} />
      <CopyValue label="policy_version" value={receipt.policy_version} />
      <CopyValue label="policy_hash" value={receipt.policy_hash} />
      <CopyValue label="key_set_version" value={receipt.key_set_version} />
      <CopyValue label="manifest_ref" value={receipt.manifest_ref} />
      <CopyValue label="request_hash" value={receipt.request_hash} />
      <CopyValue label="decision_hash" value={receipt.decision_hash} />
      <CopyValue label="translation_version" value={receipt.translation_version} />
      <JsonPanel title="Raw receipt view" value={receipt} />
    </section>
  );
}
