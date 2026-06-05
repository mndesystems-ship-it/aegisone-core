# Reviewer Quickstart

Run this from the repository root:

```powershell
cmd /c npm run reviewer-kit
```

Expected final line:

```text
FINAL VERDICT: PASS
```

Inspect the receipts:

```text
reviewer-kit\artifacts\receipts\allow-receipt.json
reviewer-kit\artifacts\receipts\refuse-receipt.json
```

Verify one receipt independently with no sidecar:

```powershell
node .\tools\verify-receipt.mjs .\reviewer-kit\artifacts\receipts\allow-receipt.json
```

Expected final line:

```text
FINAL VERDICT: VERIFIED
```

Verify one receipt through the reviewer session verifier:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\reviewer-kit\run-review.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\reviewer-kit\verify-receipt.ps1 .\reviewer-kit\artifacts\receipts\allow-receipt.json
```

The reviewer kit starts MNDe, requests one ALLOW decision and one REFUSE decision, verifies signed receipts, verifies replay, and stops MNDe after the full run.
