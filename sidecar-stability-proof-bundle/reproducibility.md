# MNDe Sidecar Stability Proof Bundle

Generated: 2026-05-11T04:30:06.392Z

## Source

- Runtime torture output: `C:\Users\Shadow\Downloads\INsol\INsol\sidecar-scaling-output\browser-origin-runtime-torture`
- Proof bundle: `C:\Users\Shadow\Downloads\INsol\INsol\sidecar-stability-proof-bundle`

## Reproduce

Run from `C:\Users\Shadow\Downloads\INsol\INsol`:

```powershell
cmd /c npm run test:sidecar-scaling
cmd /c npm run test:codex-mnde
cmd /c npm run test:sidecar-browser-torture
node --experimental-strip-types .\scripts\build_sidecar_external_review_bundle.mjs
```

## Review Notes

- Runtime overload refusal receipts such as `ERR_WORKER_POOL_SATURATED` are signed, append-only runtime fail-closed receipts. They are intentionally separated from deterministic engine replay because they prove sidecar saturation handling rather than policy evaluation output.
- Deterministic engine receipts are replayed through the canonical execution pipeline and must have zero replay mismatches.
- The bundle preserves the original signed receipt log as `signed-receipts.jsonl`.
