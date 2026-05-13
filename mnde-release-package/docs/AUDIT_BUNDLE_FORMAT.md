# Audit Bundle Format

Purpose: portable offline proof package for receipts and policy proof artifacts.

Structure: `manifest.json`, `graph.json`, `receipts/`, `index/`, `policies/`, `keys/`, `reports/summary.json`, `reports/determinism.json`, `reports/adversarial.json`, `signatures/bundle.sig`.

Manifest schema: see `schemas/audit_bundle.schema.json`.

Signature output: `algorithm`, `key_id`, `root_hash`, `signature`.

Failure codes: export fails before bundle completion on invalid receipt, replay drift, unresolved proof, signature failure, or manifest ambiguity.

Determinism rules: canonical JSON files, lexicographic file ordering, root hash over canonical bundle contents, fixed build timestamp.
