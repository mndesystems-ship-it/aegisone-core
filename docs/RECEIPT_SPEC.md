# Receipt Spec

Receipts are the audit boundary. A receipt binds canonical request bytes, decision output, pipeline trace, request hash, decision hash, policy version, policy hash, cost accounting, execution ID, and signature material.

Receipt compatibility constraints:

- Existing field names are preserved.
- Existing hash inputs are preserved.
- Existing signature verification behavior is preserved.
- Replay compares deterministic decision and receipt material, not wall-clock timing.
- `ALLOW` without a verifiable signature is a failure.

Schemas retained from the release package live in `schemas/`.
