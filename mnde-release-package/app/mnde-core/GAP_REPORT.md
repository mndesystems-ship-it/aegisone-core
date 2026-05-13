# Step 3. Identify gaps

## Preflight

- missing strict schema: `mnde-preflight` has strict parsing for workflow, pricing, and MNDe incident input, but there is no single strict schema covering the unified request, orbit, policy, release, and runtime envelope.
- unknown fields allowed: Orbit validation currently allows `ext`; this is intentional in Orbit but means the unified intake layer did not exist and could not reject unrelated fields outside that boundary.

## Validation

- nondeterministic logic: `C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\parse.ts:209` parses numbers as JavaScript `Number`, so large integers can lose precision and float-like representations are still tokenized before validation.
- external calls: no network calls were found in Orbit validation code.
- missing signature verification: Orbit validates only signature record shape and array presence; it does not verify any cryptographic signature.

## Policy Trust

- missing signature verification: there is receipt signature verification, but there is no standalone signed policy object verification path.
- no version lock: existing MNDe policy parsing does not pin a `policy_version` for execution.
- policy not bound to decision: existing `decision_hash` in `mnde_proof.go` binds request and decision payload, but not a standalone `policy_hash`.

## Release

- no hold state: existing gating either allows or refuses; there is no separate hold state for manual approval.
- no one shot execution: no existing release module prevents re-use of an approval or execution token.
- release control is partial: the closest existing release control is Orbit’s `lifecycle_state === ARMED` plus cost gating in `decideMNDeIncident`, but there is no isolated ARM layer.

## Runtime

- no drift detection: receipt replay detects post-hoc drift, but there is no inline runtime drift gate before or during execution.
- no cost spike protection: `decideMNDeIncident` projects cost, but there is no runtime refusal on actual spend spike.
- no kill switch: no runtime kill-switch or execution-stop primitive was found in the scanned repositories.
