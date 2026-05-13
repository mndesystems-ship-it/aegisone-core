import React from "react";

export function JsonPanel({ title, value }) {
  return (
    <section className="panel json-panel">
      <div className="panel-title">{title}</div>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}
