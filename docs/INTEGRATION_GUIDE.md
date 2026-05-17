# Integration Guide

Integrate with `POST /v1/decisions`. Submit a complete execution request, policy input when needed, pricing data, and runtime observation. Treat every non-`ALLOW` response as a refusal and preserve the receipt for audit.

Minimal checks before production use:

```powershell
npm run test:release:integrity
npm run test:local:replay
npm run test:local:proof
```

Runtime health:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/readyz
```

Compatibility notes:

- `/decide` remains a legacy local alias.
- Existing receipt formats and hash inputs are unchanged.
- Existing `MNDE_*` environment variables remain compatibility surfaces.
- Proof artifacts are now organized under `proofs/`; generated output folders are ignored.
