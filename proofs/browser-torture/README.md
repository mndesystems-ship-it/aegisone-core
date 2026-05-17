# Browser Torture Proof

Purpose: verify browser-origin pressure, overload handling, receipt persistence, replay, and signature integrity.

Verification:

```powershell
npm run test:sidecar-browser-torture
node .\scripts\verify_sidecar_torture_report.mjs
```

PASS criteria: no unsigned allows, no replay mismatches, no signature failures, no receipt count mismatch, and health remains responsive.

Artifacts retain compact browser-origin and hostile torture summaries. Raw latency CSVs, JSONL receipt streams, and transient sidecar logs are ignored.
