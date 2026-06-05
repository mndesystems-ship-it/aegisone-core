# Start Here

MNDe is for teams that need a local authority layer in front of agentic automation, GPU jobs, infrastructure actions, or other expensive and risky execution.

The core idea is simple:

```text
action request -> MNDe -> ALLOW or REFUSE -> signed receipt
```

MNDe decides before the action runs. The receipt lets a reviewer verify what was requested, what MNDe decided, which policy was used, and whether replay produces the same decision.

## First Evaluation

Run the reviewer kit:

```powershell
cmd /c npm install
cmd /c npm run reviewer-kit
```

Expected result:

```text
FINAL VERDICT: PASS
```

This proves:

- a safe `read_status` request receives `ALLOW`
- a destructive `recursive_delete` request receives `REFUSE`
- both paths generate signed receipts
- receipt verification passes
- replay verification passes
- generated evidence is inspectable under `reviewer-kit/artifacts/`

## Verify A Receipt Offline

After the reviewer kit runs:

```powershell
node tools/verify-receipt.mjs reviewer-kit/artifacts/receipts/allow-receipt.json
```

Expected result:

```text
FINAL VERDICT: VERIFIED
```

The standalone verifier does not require the sidecar, desktop UI, network access, localhost, or any live MNDe process.

## Where To Go Next

- Fast review path: [REVIEWER_QUICKSTART.md](REVIEWER_QUICKSTART.md)
- Full external review explanation: [REVIEW.md](REVIEW.md)
- Reviewer kit details: [docs/reviewer-kit.md](docs/reviewer-kit.md)
- Offline verifier details: [docs/independent-verification.md](docs/independent-verification.md)
- Documentation index: [docs/README.md](docs/README.md)

## What To Ignore At First

The repository also contains retained proof artifacts, benchmark outputs, migration notes, release integrity material, and internal audit reports. They are useful for deeper diligence, but they are not the first-time path.

Start with the reviewer kit. Then inspect the generated receipts.
