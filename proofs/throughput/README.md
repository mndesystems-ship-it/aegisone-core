# Throughput Proof

Purpose: retain controlled benchmark summaries without keeping raw benchmark dumps in git.

Verification:

```powershell
npm run benchmark:mnde
npm run test:local:proof
```

PASS criteria: controlled benchmark reports zero drift, zero replay mismatch, and expected cost control.

Artifacts retain compact benchmark summaries, latency validation, workload manifest, and sidecar scaling summaries.
