# Reviewer Path

## Step 1: Read `AUDIT_README.md`

Confirm the scope first. The system under review is a pre-execution control pipeline, not a general workflow engine. The README tells you what each artifact is for and what a passing bundle should look like.

## Step 2: Inspect `manifest.json`

Check that:

- `schema_version` is `ecs.audit.manifest.v1`
- `artifacts` lists the expected files
- each artifact entry has a `file` and `sha256`
- `build_metadata` records Node, npm, Rust, operating system, and build date

The important point is that the build metadata is descriptive only. The artifact hashes are separate and stable.

## Step 3: Verify `drift_report.json`

Look for:

- `zero_divergence: true`
- each case showing `distinct_outputs: 1`
- each case showing `divergence_count: 0`

That is the direct determinism proof for repeated execution of the same canonical input.

## Step 4: Verify `replay_report.json`

Look for:

- `exact_match: true`
- `total_receipts` equal to `exact_matches`
- `mismatches` as an empty array

This shows stored canonical requests and signed receipts can be replayed without a decision, hash, or receipt mismatch.

## Step 5: Verify `parity_report.json`

Look for:

- `zero_divergence: true`
- every case showing `identical_decision: true`
- every case showing `identical_decision_hash: true`
- every case showing `byte_identical_receipt: true`

Matching decisions alone would not be enough. The receipt bytes must also match to prove the contract is shared across runtimes.

## Step 6: Inspect `adversarial_report.json`

Review the case list and confirm:

- malformed and duplicate-key inputs refuse at the parse boundary
- unknown and partial inputs refuse instead of being normalized
- policy tamper and receipt tamper are detected
- runtime contamination is refused
- the numeric boundary case only allows at the exact safe edge
- `failures` is `0`

This is the fail-closed evidence.

## Step 7: Review `cost_prevention_cases.json`

For each case, check:

- the execution request is concrete and expensive enough to matter
- the refusal has a direct `reason_code`
- `prevented_cost_usd` is non-zero

This is the business-value proof: the control system did not just refuse malformed input, it also blocked costly requests with reproducible math.
