# Replay Proof

Purpose: verify that signed receipts replay without drift.

Verification:

```powershell
npm run test:local:replay
```

PASS criteria: replay drift count is `0`, replay drift rate is `0`, and deterministic receipt material is unchanged.

Artifacts retain replay reports and latest verified summaries without raw JSONL receipt streams.
