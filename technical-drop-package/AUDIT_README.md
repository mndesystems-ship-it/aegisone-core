# Deterministic Execution Control Proof Bundle

This system evaluates an execution request through four control layers, `Preflight -> Orbit -> ARM -> RAM0NA`, and returns `ALLOW` or `REFUSE` before work proceeds. The proof bundle shows that the same canonical input produces the same hashes and receipts, malformed or ambiguous input fails closed, stored requests replay exactly, and Node and Rust produce byte-identical receipts for the same contract.

In concrete terms, it solves a control problem that is hard to audit in practice: expensive or risky execution requests can drift at parse time, at policy evaluation time, or at runtime observation time. The bundle gives a reviewer direct evidence that the control path is deterministic, replayable, and able to refuse malformed, tampered, or cost-amplified requests without relying on hidden state.

## Regenerate The Bundle

Run:

```powershell
npm run audit
```

This writes the proof artifacts into [audit-proof-bundle](C:\Users\Shadow\Desktop\INsol\audit-proof-bundle).

## Artifacts

`drift_report.json`
What it proves: fixed allow and fixed refuse requests were executed 1,000 times each with zero output divergence.

`replay_report.json`
What it proves: every stored signed receipt replayed to the exact same decision and decision hash, with no signature or receipt-byte mismatch.

`parity_report.json`
What it proves: Node and Rust produced identical decisions, identical decision hashes, and byte-identical receipt payloads for the same inputs.

`adversarial_report.json`
What it proves: malformed, partial, reordered, tampered, and contamination cases all failed closed or produced deterministic results.

`cost_prevention_cases.json`
What it proves: realistic high-cost requests were refused with concrete `reason_code` values and reproducible `prevented_cost_usd`.

`throughput_report.json`
What it proves: 10,000 mixed requests completed without drift and without evidence of state leakage between requests.

`signed_receipts.jsonl`
What it proves: the system emits append-only signed receipts containing the canonical request, decision output, and pipeline trace needed for replay.

`manifest.json`
What it proves: every artifact in the bundle is hashed, and the build environment is recorded without changing the artifact hashes being attested.

## Pass Criteria

- `drift_report.json`: `zero_divergence` must be `true`.
- `replay_report.json`: `exact_match` must be `true` and `mismatches` must be empty.
- `parity_report.json`: `zero_divergence` must be `true`, and every case must show `byte_identical_receipt: true`.
- `adversarial_report.json`: `failures` must be `0`.
- `throughput_report.json`: `zero_drift` must be `true` and `state_leakage_detected` must be `false`.
- `cost_prevention_cases.json`: every listed case should show `decision: REFUSE` with a concrete `reason_code` and non-zero `prevented_cost_usd`.
