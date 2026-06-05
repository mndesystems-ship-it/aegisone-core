# MNDe External Review

This review package is for a technical reviewer who wants a direct evidence path without reading source code.

## What It Proves

- MNDe exposes a pre-execution decision endpoint at `POST /v1/decisions`.
- A safe `read_status` action receives an `ALLOW` decision before execution.
- A destructive `recursive_delete` action receives a `REFUSE` decision before execution.
- Each decision produces a signed receipt.
- Receipt verification checks signature, schema, replay, and request hash consistency.
- Replay recomputes the decision from the stored canonical request and detects drift.
- The one-command review path starts the local sidecar, runs the review, and shuts it down.

## What It Does Not Prove

- It does not prove production deployment readiness for every customer environment.
- It does not prove policy suitability for a specific buyer workflow.
- It does not prove all possible actions are classified correctly.
- It does not replace security review of deployment, identity, network, or custody configuration.

## Command

From the repository root on Windows:

```powershell
cmd /c npm run reviewer-kit
```

PowerShell users whose execution policy permits npm shims may also run:

```powershell
npm run reviewer-kit
```

## Expected Output

The final lines should include:

```text
========================================
MNDe External Review Complete
========================================

Environment: PASS
ALLOW: PASS
REFUSE: PASS
Receipt Verification: PASS
Replay Verification: PASS

FINAL VERDICT: PASS
```

## Artifacts

Generated evidence is written only under:

```text
reviewer-kit\artifacts\
```

Primary artifact paths:

```text
reviewer-kit\artifacts\receipts\allow-receipt.json
reviewer-kit\artifacts\receipts\refuse-receipt.json
reviewer-kit\artifacts\proofs\determinism\allow-response.json
reviewer-kit\artifacts\proofs\security\refuse-response.json
reviewer-kit\artifacts\proofs\security\environment-verification.json
reviewer-kit\artifacts\proofs\replay\allow-receipt-verification.json
reviewer-kit\artifacts\proofs\replay\refuse-receipt-verification.json
reviewer-kit\artifacts\logs\sidecar-receipts.jsonl
```

## Manual Receipt Verification

Offline verification does not require MNDe to be running:

```powershell
npm run verify-receipt .\reviewer-kit\artifacts\receipts\allow-receipt.json
```

Expected result:

```text
FINAL VERDICT: VERIFIED
```

The reviewer proof script confirms localhost is unavailable before verifying:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\reviewer-kit\verify-independent.ps1 .\reviewer-kit\artifacts\receipts\allow-receipt.json
```

Expected result:

```text
Sidecar Reachable: NO
Receipt Verification: PASS
Replay Determinism: PASS
FINAL VERDICT: VERIFIED
```

The reviewer session verifier is also available when the sidecar is running:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\reviewer-kit\run-review.ps1
```

Verify one stored receipt:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\reviewer-kit\verify-receipt.ps1 .\reviewer-kit\artifacts\receipts\allow-receipt.json
```

Expected result:

```text
SIGNATURE: PASS
SCHEMA: PASS
REPLAY: PASS
HASHES: PASS

VERDICT: PASS
```

## Replay Integrity

Each receipt stores the canonical pre-execution request and the original decision output. Replay submits that canonical request back through MNDe's deterministic decision pipeline and compares the recomputed decision fields to the stored receipt. A mismatch is reported as drift. A PASS means the receipt decision is reproducible from its stored canonical input.
