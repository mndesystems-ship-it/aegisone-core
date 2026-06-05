# Reviewer Kit

The reviewer kit is an external evaluation harness for MNDe. It is separate from product runtime code and writes live evidence under `reviewer-kit\artifacts\`.

## Scope

The kit exercises the public local sidecar endpoints:

- `GET /healthz`
- `GET /readyz`
- `POST /v1/decisions`
- `POST /verify`
- `POST /replay`

The kit does not use mocked decisions, simulated receipts, or demo-only receipt generation.

## One-Command Review

```powershell
cmd /c npm run reviewer-kit
```

The command performs:

1. Starts the MNDe sidecar with reviewer-local signing configuration.
2. Waits for `/readyz`.
3. Checks `/healthz`, `/readyz`, signer availability, replay availability, and writable receipt storage.
4. Sends `read_status` to `/v1/decisions` and expects `ALLOW`.
5. Sends `recursive_delete` to `/v1/decisions` and expects `REFUSE`.
6. Stores both receipts under `reviewer-kit\artifacts\receipts\`.
7. Verifies signature, schema, replay, and hashes for both receipts.
8. Stops the sidecar.

## Individual Commands

Start MNDe reviewer session:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\reviewer-kit\run-review.ps1
```

Verify environment:

```powershell
npm run reviewer-kit:verify
```

Run ALLOW example:

```powershell
npm run reviewer-kit:allow
```

Run REFUSE example:

```powershell
npm run reviewer-kit:refuse
```

Verify a receipt:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\reviewer-kit\verify-receipt.ps1 .\reviewer-kit\artifacts\receipts\allow-receipt.json
```

Verify a copied receipt independently without sidecar:

```powershell
npm run verify-receipt .\reviewer-kit\artifacts\receipts\allow-receipt.json
```

Prove independent verification with localhost unavailable:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\reviewer-kit\verify-independent.ps1 .\reviewer-kit\artifacts\receipts\allow-receipt.json
```

## Artifact Map

```text
reviewer-kit\artifacts\receipts\allow-receipt.json
reviewer-kit\artifacts\receipts\refuse-receipt.json
reviewer-kit\artifacts\logs\sidecar-receipts.jsonl
reviewer-kit\artifacts\logs\sidecar.pid
reviewer-kit\artifacts\proofs\determinism\allow-response.json
reviewer-kit\artifacts\proofs\security\environment-verification.json
reviewer-kit\artifacts\proofs\security\refuse-response.json
reviewer-kit\artifacts\proofs\replay\allow-receipt-verification.json
reviewer-kit\artifacts\proofs\replay\refuse-receipt-verification.json
```

`reviewer-kit\expected\pass-transcript.txt` is a sanitized expected transcript. It is a fixture, not generated evidence.

## Replay

Replay uses the receipt's `canonical_request`. MNDe reruns the deterministic decision pipeline and compares the replayed decision fields to the original receipt. If the recomputed decision differs, replay reports drift. If replay passes, the decision in the receipt is reproducible from the receipt's canonical input.

## Fail-Closed Behavior

Every reviewer script exits nonzero on failure. The full review prints `FINAL VERDICT: PASS` only after environment verification, ALLOW, REFUSE, receipt verification, replay verification, and sidecar cleanup have completed successfully.
