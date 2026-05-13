# Scoped Policy Proof

## Scope

- scope: requests with `projected_cost_usd > 100`
- rule: `projected_cost_usd > 100 -> ERR_COST_LIMIT`

## Before

- request type: runaway autoscale
- example request: 8 GPUs for 20 hours with autoscale multiplier 20
- projected cost: `16000.00` USD
- weak gate outcome: execution allowed
- resulting spend: cost incurred

## After

- same request evaluated by the control stack
- observed outcome: `REFUSE`
- refusal code: `ERR_COST_LIMIT`
- resulting spend: `0` new execution cost

## Evidence

- [BUSINESS_PROOF.md](C:\Users\Shadow\Desktop\INsol\BUSINESS_PROOF.md)
- [summary.json](C:\Users\Shadow\Desktop\INsol\mnde-controlled-benchmark-bundle\summary.json)

## Defensible Claim

For the scoped class of requests whose projected spend exceeds `$100`, the control stack can refuse before execution with an explicit cost-limit reason instead of allowing cost to be incurred.

## Claim Language

Deterministic decision layer produces byte-identical receipts and manifests across independent reruns. Performance artifacts are excluded from reproducibility scope and provided separately.
