# Security Model

MNDe fails closed. Any invalid schema, malformed JSON, missing release material, unsigned allow, replay drift, policy hash mismatch, exhausted worker pool, saturated receipt queue, or consumed execution ID is a refusal condition.

Security-sensitive invariants:

- Decisions are deterministic for equivalent canonical input.
- `ALLOW` receipts must be signed.
- Receipt replay must produce the same decision hash and request hash.
- Release integrity failure produces a deterministic startup refusal receipt.
- Browser-origin and local HTTP overload paths refuse before collapse.
- Concurrency probes must produce one winner and deterministic duplicate refusal.
- Generated proof data is not trusted unless recreated by committed scripts or retained as compact evidence under `proofs/`.
