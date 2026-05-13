# Receipt Viewer UI Spec

Purpose: read-only inspection of receipts, replay, proof, stats, audit bundles, and graph lineage.

Modes: Operator and Audit.

Inputs: API results or bundle JSON injected into `window.MNDE_RECEIPTS_DATA`.

Outputs: visible fields trace to exact API or bundle fields. Raw JSON is available on every major screen.

Failure codes: UI does not create failure codes; it displays API failure payloads unchanged.

Determinism rules: stable sorting by receipt hash, no relative time rendering, no random ids, no write controls, no mutation controls.
