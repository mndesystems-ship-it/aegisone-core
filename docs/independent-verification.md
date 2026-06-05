# Independent Receipt Verification

Run:

```powershell
npm run verify-receipt receipt.json
```

Equivalent direct command:

```powershell
node tools/verify-receipt.mjs receipt.json
```

Expected output:

```text
FINAL VERDICT: VERIFIED
```

This process requires:

- no running sidecar
- no running desktop
- no network access

Verification is performed entirely from receipt contents and production verification logic.

The verifier checks schema, canonicalization, request hash, decision hash, policy hash, Ed25519 signature, and local replay determinism. Replay uses the receipt's stored canonical request and reruns the deterministic MNDe decision pipeline locally. It does not call `localhost`, `/replay`, or any live service.

Failure in any check produces `FINAL VERDICT: FAILED` and a nonzero exit code.
