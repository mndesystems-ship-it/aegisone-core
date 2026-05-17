# Security Proof

Purpose: retain hostile input, schema enforcement, remediation, and fail-closed evidence.

Verification:

```powershell
npm run test:regression
npm run test:local:malformed
npm run test:local:policy
```

PASS criteria: unexpected allows remain zero, malformed input refuses deterministically, and known security corrections remain enforced.

Artifacts retain compact hostile verifier and remediation summaries.
