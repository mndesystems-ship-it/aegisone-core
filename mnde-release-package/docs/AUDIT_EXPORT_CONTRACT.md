# Audit Export Contract

Purpose: produce an offline audit bundle from verified receipts and local proof artifacts.

Input: `mnde receipts export --receipts <dir|jsonl> --proof-root <dir> --out <dir> --format dir|tar --strict true --build-timestamp <ISO8601>`.

Output: canonical JSON result with `schema_version`, `status`, `bundle_path`, `format`, `receipt_count`, `root_hash`, `signed_root_hash`, and `final_bundle_hash`.

Failure codes: `ERR_RECEIPT_SIGNATURE_INVALID`, `ERR_REQUEST_HASH_MISMATCH`, `ERR_DECISION_HASH_MISMATCH`, `ERR_REPLAY_MISMATCH`, `ERR_POLICY_PROOF_UNRESOLVED`, `ERR_POLICY_HASH_MISMATCH`, `ERR_POLICY_SIGNATURE_INVALID`.

Determinism rules: lexicographic file ordering, canonical JSON only, injected `build_timestamp`, no local clocks, no remote lookup.
