# Reviewer Path

## Commands

Install:

```powershell
npm install
```

Path A. Determinism proof:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_full_local_proof.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\prove_repeatability.ps1
```

Path B. Performance validation:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_controlled_benchmark_triplicate.ps1
```

## Path A. Determinism Proof

1. Inspect `stable-proof-bundle/manifest.json` and `stable-proof-bundle/hashes.json`.
2. Compare the two captures under `external-review-drop/runs` and expect the stable bundle hashes to be identical.
3. Verify `stable-proof-bundle/receipts.jsonl` is byte-identical across reruns.
4. Verify `audit-proof-bundle/determinism_proof.json`, `audit-proof-bundle/proof_bundle/replay_results.json`, and `audit-proof-bundle/proof_bundle/parity_report.json` show zero drift, zero replay mismatches, and zero cross-runtime mismatches.
5. Review `failure_proofs.json` and `TEST_MATRIX.md` for one forced refusal example per test.

## Path B. Performance Validation

1. Inspect `volatile-benchmark-bundle/benchmark_validation.json`.
2. Inspect `volatile-benchmark-bundle/workload_manifest.json` and confirm the workload hash and anchor hash stay fixed.
3. Verify the benchmark consistency report uses `3` consecutive runs and reports median plus spread.
4. Verify throughput and latency p99 stay within `3%` under controlled conditions.
5. Do not use byte equality for the volatile benchmark bundle.

## Claim

Deterministic decision layer produces byte-identical receipts and manifests across independent reruns. Performance artifacts are excluded from reproducibility scope and provided separately.
