# Replay Verification

Replay verification proves that retained receipts still resolve to the same deterministic decision.

Run:

```powershell
npm run test:local:replay
```

PASS criteria:

- determinism mismatch rate is `0`
- replay drift rate is `0`
- replay drift count is `0`
- determinism mismatch count is `0`

Evidence:

- `proofs/replay/summary.json`
- `proofs/replay/artifacts/replay-results.json`
- `proofs/replay/artifacts/replay-report.json`
- regenerated local output under ignored proof bundle folders
