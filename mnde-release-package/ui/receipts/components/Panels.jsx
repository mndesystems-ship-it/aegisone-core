import React from "react";
import { CopyValue } from "./CopyValue.jsx";
import { JsonPanel } from "./JsonPanel.jsx";

export function VerificationPanel({ verification }) {
  return (
    <section className="panel">
      <div className="panel-title">Verification</div>
      <CopyValue label="schema valid" value={verification?.schema_version ? "true" : "unknown"} />
      <CopyValue label="signature valid" value={String(verification?.public_signature_valid ?? "unknown")} />
      <CopyValue label="decision hash match" value={String(verification?.decision_hash_matches ?? "unknown")} />
      <CopyValue label="request hash" value={verification?.request_hash} />
      <JsonPanel title="Raw verification" value={verification ?? {}} />
    </section>
  );
}

export function ReplayPanel({ replay }) {
  return (
    <section className="panel">
      <div className="panel-title">Replay</div>
      <CopyValue label="decision match" value={String(replay?.drift === false)} />
      <CopyValue label="mismatch count" value={String(replay?.mismatches?.length ?? 0)} />
      <JsonPanel title="Raw replay" value={replay ?? {}} />
    </section>
  );
}

export function ProofPanel({ proof }) {
  return (
    <section className="panel">
      <div className="panel-title">Proof</div>
      <CopyValue label="status" value={proof?.status} />
      <CopyValue label="policy_version" value={proof?.policy_version} />
      <CopyValue label="policy_hash" value={proof?.policy_hash} />
      <CopyValue label="manifest_path" value={proof?.manifest_path} />
      <CopyValue label="signature_envelope_path" value={proof?.signature_envelope_path} />
      <CopyValue label="key_set_version" value={proof?.key_set_version} />
      <CopyValue label="valid_signatures" value={String(proof?.valid_signatures ?? "unknown")} />
      <JsonPanel title="Raw proof" value={proof ?? {}} />
    </section>
  );
}

export function StatsDashboard({ stats }) {
  return (
    <section className="panel">
      <div className="panel-title">Stats dashboard</div>
      <CopyValue label="total receipts" value={String(stats?.total_receipts ?? 0)} />
      <CopyValue label="verified" value={String(stats?.verified_receipts ?? 0)} />
      <CopyValue label="prevented cost micro USD" value={String(stats?.prevented_cost_micro_usd ?? 0)} />
      <JsonPanel title="Raw stats" value={stats ?? {}} />
    </section>
  );
}

export function BundleExplorer({ bundle }) {
  return (
    <section className="panel">
      <div className="panel-title">Audit bundle explorer</div>
      <JsonPanel title="Bundle manifest" value={bundle?.manifest ?? {}} />
      <JsonPanel title="Bundle signature" value={bundle?.signature ?? {}} />
      <JsonPanel title="Bundle graph" value={bundle?.graph ?? {}} />
    </section>
  );
}

export function GraphLineage({ graph, onNode }) {
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  return (
    <section className="panel">
      <div className="panel-title">Graph lineage</div>
      <div className="graph-list">
        {edges.map((edge) => (
          <button type="button" key={`${edge.from}-${edge.to}-${edge.relationship}`} onClick={() => onNode(nodes.find((node) => node.id === edge.to))}>
            <code>{edge.from}</code> -> <code>{edge.to}</code>
          </button>
        ))}
      </div>
      <JsonPanel title="Raw graph" value={graph ?? {}} />
    </section>
  );
}
