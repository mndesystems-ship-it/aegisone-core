import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import { routes } from "./routes/routes.js";
import { ReceiptList } from "./components/ReceiptList.jsx";
import { ReceiptDetail } from "./components/ReceiptDetail.jsx";
import { VerificationPanel, ReplayPanel, ProofPanel, StatsDashboard, BundleExplorer, GraphLineage } from "./components/Panels.jsx";

const initialData = window.MNDE_RECEIPTS_DATA ?? {
  receipts: [],
  verification: null,
  replay: null,
  proof: null,
  stats: null,
  bundle: null,
  graph: null,
};

function App() {
  const [mode, setMode] = useState("operator");
  const [filters, setFilters] = useState({});
  const receipts = useMemo(() => initialData.receipts ?? [], []);
  const [selected, setSelected] = useState(receipts[0] ?? null);
  const [node, setNode] = useState(null);
  const audit = mode === "audit";
  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">MNDe Receipts</div>
        <nav className="nav">{routes.map((route) => <a key={route.path} href={route.path}>{route.label}</a>)}</nav>
        <div className="mode">
          <button className={mode === "operator" ? "active" : ""} onClick={() => setMode("operator")}>Operator</button>
          <button className={mode === "audit" ? "active" : ""} onClick={() => setMode("audit")}>Audit</button>
        </div>
      </header>
      <section className={`layout workspace ${audit ? "audit" : "operator"}`}>
        <ReceiptList receipts={receipts} filters={filters} onFilters={setFilters} onSelect={setSelected} />
        <div className="main-stack">
          <ReceiptDetail receipt={selected} />
          <VerificationPanel verification={initialData.verification} />
          <ReplayPanel replay={initialData.replay} />
          <ProofPanel proof={initialData.proof} />
          <StatsDashboard stats={initialData.stats} />
          <BundleExplorer bundle={initialData.bundle} />
          <GraphLineage graph={initialData.graph} onNode={setNode} />
          {node ? <ReceiptDetail receipt={node} /> : null}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
