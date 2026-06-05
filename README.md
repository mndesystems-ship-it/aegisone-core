# MNDe

MNDe is a pre-execution authority layer for risky automation. Before an action runs, the action is sent to MNDe. MNDe returns a deterministic `ALLOW` or `REFUSE`, then writes a signed receipt that can be verified and replayed later.

The shortest proof is the reviewer kit:

```powershell
cmd /c npm install
cmd /c npm run reviewer-kit
```

Expected final output:

```text
FINAL VERDICT: PASS
```

## What MNDe Proves

The reviewer kit demonstrates the core product behavior with real sidecar APIs and real receipts:

- `read_status` is evaluated before execution and receives `ALLOW`.
- `recursive_delete` is evaluated before execution and receives `REFUSE`.
- Both decisions generate signed receipts.
- Both receipts verify.
- Replay verification recomputes the deterministic decision path.
- Standalone receipt verification works without a running sidecar, desktop UI, network access, or localhost.

The generated evidence is written under:

```text
reviewer-kit/artifacts/
```

## Start Here

First-time evaluators should read:

- [START_HERE.md](START_HERE.md)
- [REVIEWER_QUICKSTART.md](REVIEWER_QUICKSTART.md)
- [REVIEW.md](REVIEW.md)
- [docs/reviewer-kit.md](docs/reviewer-kit.md)
- [docs/independent-verification.md](docs/independent-verification.md)

## One-Command External Review

```powershell
cmd /c npm run reviewer-kit
```

This command:

1. Starts the local MNDe sidecar.
2. Waits for readiness.
3. Runs an `ALLOW` example.
4. Runs a `REFUSE` example.
5. Stores receipts under `reviewer-kit/artifacts/receipts/`.
6. Verifies receipt signatures, schemas, hashes, and replay.
7. Stops the sidecar.

## Offline Receipt Verification

A receipt can be copied to another machine and verified locally:

```powershell
node tools/verify-receipt.mjs reviewer-kit/artifacts/receipts/allow-receipt.json
```

Expected final output:

```text
FINAL VERDICT: VERIFIED
```

The standalone verifier does not call localhost and does not require a live MNDe process.

## Integration Shape

Applications integrate by sending execution requests to MNDe before performing work:

```js
const response = await fetch("http://127.0.0.1:8787/v1/decisions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(request)
});

const result = await response.json();
if (result.decision !== "ALLOW") {
  throw new Error(result.reason_code);
}
```

The decision receipt is the audit object. It contains the canonical request, request hash, decision output, policy hash, pipeline trace, and signature material needed for verification.

## Documentation Map

Use [docs/README.md](docs/README.md) as the documentation index.

Evaluator path:

- [START_HERE.md](START_HERE.md)
- [REVIEWER_QUICKSTART.md](REVIEWER_QUICKSTART.md)
- [REVIEW.md](REVIEW.md)
- [docs/reviewer-kit.md](docs/reviewer-kit.md)
- [docs/independent-verification.md](docs/independent-verification.md)

Technical model:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/OPERATIONAL_MODEL.md](docs/OPERATIONAL_MODEL.md)
- [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md)

Retained evidence:

- `proofs/determinism/`
- `proofs/replay/`
- `proofs/parity/`
- `proofs/security/`
- `proofs/throughput/`
- `proofs/external-reviews/`

## Verification Commands

```powershell
cmd /c npm run reviewer-kit
cmd /c npm run test:receipt-verifier
node tools/verify-receipt.mjs tests/receipts/valid-receipt.json
```

Broader internal proof and benchmark scripts remain available in `package.json`, `scripts/`, and `proofs/`, but the reviewer kit is the intended first evaluation path.
