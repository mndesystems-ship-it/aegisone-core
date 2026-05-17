# Parity Proof

Purpose: verify cross-runtime parity and proof bundle consistency.

Verification:

```powershell
npm run test:local:proof
```

PASS criteria: parity mismatch count is `0`, controlled benchmark drift is zero, and replay mismatch is zero.

Artifacts retain compact parity vectors and Rust parity output. Large generated receipt streams are ignored.
