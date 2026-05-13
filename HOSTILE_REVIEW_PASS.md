# Hostile Review Pass

## Claim: Deterministic Execution

Skeptical question: does the system only look deterministic because the test set is small?

Evidence:

- [audit-proof-bundle/drift_report.json](C:\Users\Shadow\Desktop\INsol\audit-proof-bundle\drift_report.json) shows the fixed allow and fixed refuse requests each ran 1,000 times with `distinct_outputs: 1` and `divergence_count: 0`.
- [audit-proof-bundle/throughput_report.json](C:\Users\Shadow\Desktop\INsol\audit-proof-bundle\throughput_report.json) shows 10,000 mixed requests with `zero_drift: true` and `state_leakage_detected: false`.

Wording tightened:

- Say: "The bundle shows repeated identical outputs for fixed cases and no drift across a 10,000 request mixed run."
- Do not say: "The system is deterministic under all possible workloads."

## Claim: Replayability

Skeptical question: can stored receipts really be re-executed exactly, or only approximately?

Evidence:

- [audit-proof-bundle/replay_report.json](C:\Users\Shadow\Desktop\INsol\audit-proof-bundle\replay_report.json) shows `exact_match: true`, `exact_matches: 3`, and no mismatches.
- [audit-proof-bundle/signed_receipts.jsonl](C:\Users\Shadow\Desktop\INsol\audit-proof-bundle\signed_receipts.jsonl) stores the canonical request, decision output, and pipeline trace needed to rerun the decision path.

Wording tightened:

- Say: "Stored canonical requests replayed to the same decision and decision hash, with no receipt mismatch in this bundle."
- Do not say: "Replay is guaranteed forever regardless of contract changes."

## Claim: Fail Closed Behavior

Skeptical question: are malformed inputs refused early, or silently normalized into something else?

Evidence:

- [audit-proof-bundle/adversarial_report.json](C:\Users\Shadow\Desktop\INsol\audit-proof-bundle\adversarial_report.json) shows passing cases for duplicate keys, malformed JSON, unknown fields, missing fields, partial input, policy tamper, receipt tamper, and request contamination.
- Parse-boundary cases return explicit refusal codes such as `ERR_DUPLICATE_JSON_KEYS` and `ERR_INVALID_JSON_SYNTAX`.

Weak point to surface:

- The proof is evidence-driven, not formal verification. It demonstrates fail-closed behavior on the listed adversarial cases.

Wording tightened:

- Say: "The listed malformed and tampered cases fail closed in the current proof suite."
- Do not say: "The system is formally proven fail closed."

## Claim: Cross Runtime Consistency

Skeptical question: do the runtimes only agree on the high-level decision while producing different receipts?

Evidence:

- [audit-proof-bundle/parity_report.json](C:\Users\Shadow\Desktop\INsol\audit-proof-bundle\parity_report.json) shows `identical_decision: true`, `identical_decision_hash: true`, and `byte_identical_receipt: true` for all listed cases.

Wording tightened:

- Say: "Node and Rust matched at the receipt-byte level for the parity vectors in this bundle."
- Do not say: "Any runtime will match automatically."

## Claim: Cost Prevention Validity

Skeptical question: are the prevented-cost numbers just illustrative?

Evidence:

- [audit-proof-bundle/cost_prevention_cases.json](C:\Users\Shadow\Desktop\INsol\audit-proof-bundle\cost_prevention_cases.json) includes the full input, refusal, and `prevented_cost_usd` for each scenario.
- The refusal codes tie directly to the policy boundary hit: `ERR_COST_LIMIT`, `ERR_GPU_LIMIT`, and `ERR_RETRY_LIMIT`.

Weak point to surface:

- The prevented-cost figures are only as credible as the pricing input in the request. The bundle proves reproducibility of the math, not external market pricing accuracy.

Wording tightened:

- Say: "The bundle shows reproducible prevented-cost math for the supplied pricing data."
- Do not say: "The prevented-cost values are market-validated savings figures."
