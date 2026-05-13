import React from "react";
import { stableSortReceipts } from "../lib/apiClient.js";

export function ReceiptList({ receipts, filters, onFilters, onSelect }) {
  const filtered = stableSortReceipts(receipts).filter((receipt) => {
    if (filters.decision && receipt.decision !== filters.decision) return false;
    if (filters.reason_code && receipt.reason_code !== filters.reason_code) return false;
    if (filters.policy_version && receipt.policy_version !== filters.policy_version) return false;
    if (filters.policy_hash && receipt.policy_hash !== filters.policy_hash) return false;
    return true;
  });
  return (
    <section className="panel">
      <div className="panel-title">Receipt list</div>
      <div className="filters">
        {["decision", "reason_code", "policy_version", "policy_hash"].map((field) => (
          <input key={field} value={filters[field] ?? ""} placeholder={field} onChange={(event) => onFilters({ ...filters, [field]: event.target.value })} />
        ))}
      </div>
      <table>
        <thead>
          <tr><th>Decision</th><th>Reason</th><th>Policy</th><th>Receipt hash</th></tr>
        </thead>
        <tbody>
          {filtered.map((receipt) => (
            <tr key={receipt.receipt_hash} onClick={() => onSelect(receipt)}>
              <td>{receipt.decision}</td>
              <td>{receipt.reason_code}</td>
              <td>{receipt.policy_version}</td>
              <td><code>{receipt.receipt_hash}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
