# Custody Proof

Purpose: retain custody key, rotation, timeout, and release custody evidence.

Verification:

```powershell
npm run test:custody
node --experimental-strip-types .\scripts\test_custody_audit_hardening.mjs
```

PASS criteria: custody signatures verify, timeout refusals remain deterministic, and rotation evidence remains auditable.

Artifacts retain compact custody receipts, release manifests, and timeout evidence.
