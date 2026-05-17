# Determinism

Determinism means that the same request, policy, pricing input, runtime observation, and release context produce the same decision, request hash, decision hash, receipt bytes, and replay result.

The active checks are:

```powershell
npm run test:local:replay
npm run test:local:proof
```

PASS criteria:

- `determinism_mismatch_rate = 0`
- `replay_drift_rate = 0`
- `replay drift_count = 0`
- parity mismatch count is `0`
- controlled benchmark reproducibility reports zero drift and zero replay mismatch

Retained evidence lives in `proofs/determinism`, `proofs/replay`, and `proofs/parity`.
