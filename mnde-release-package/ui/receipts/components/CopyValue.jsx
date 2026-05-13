import React from "react";

export function CopyValue({ label, value }) {
  return (
    <div className="copy-row">
      <span>{label}</span>
      <code>{value ?? "unknown"}</code>
      <button type="button" onClick={() => navigator.clipboard.writeText(String(value ?? ""))}>Copy</button>
    </div>
  );
}
