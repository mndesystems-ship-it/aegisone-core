# MNDe Smoking Gun Proof

This proof is the reviewer-facing "show me" path.

It demonstrates, from the packaged custody release, that MNDe can:

1. verify the published release manifest and provenance,
2. accept a customer-owned signer registry,
3. verify an externally signed refusal receipt for a runaway GPU/autoscale request,
4. reject a tampered copy of that receipt.

The receipt is intentionally signed outside MNDe. The custody release verifies it with public-key material only. That is the point: production custody mode does not hold private signing keys and refuses internal signing.

## Run

From the repository root:

```cmd
mnde-smoking-gun\run.cmd
```

For the stronger reviewer simulation, copy the custody release into a fresh output directory first and run the proof against that copy:

```cmd
mnde-smoking-gun\run-fresh-reviewer.cmd
```

Expected first line:

```text
PASS
```

Artifacts are written to:

```text
mnde-smoking-gun\output\
```

The most important files are:

```text
runaway-gpu-autoscale.request.json
runaway-gpu-autoscale.registry.json
runaway-gpu-autoscale.refusal.receipt.json
runaway-gpu-autoscale.tampered.receipt.json
summary.json
fresh-reviewer-unzip\
```

## What Makes This The Smoking Gun

The request is operationally plausible: an automated execution asks for 8 GPUs for 20 hours with autoscale enabled and a scale multiplier of 20. The refusal receipt records:

```text
decision: REFUSE
reason_code: ERR_COST_LIMIT
projected_total_cost_usd: 11000
allowed_cost_usd: 500
prevented_cost_usd: 10500
```

The reviewer can verify the receipt signature through the shipped custody CLI. If the receipt is altered after signing, verification refuses it.
