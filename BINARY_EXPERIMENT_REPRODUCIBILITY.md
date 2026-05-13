# MNDe Binary Experiment Reproducibility

JSON remains the source of truth. The binary encoder is evidence-only and is not integrated into the production decision pipeline.

The current scale script is a core-pipeline validation harness. It calls the existing deterministic decision pipeline directly and does not validate the full sidecar POST `/v1/decisions` HTTP surface, request authentication, sidecar response formatting, or receipt persistence path.

## Kept Artifacts

- `app/encoding/binary_experiment.js`
- `app/encoding/binary_experiment_schema.md`
- `scripts/test_binary_experiment.mjs`
- `scripts/scale_binary_experiment.mjs`

Large result files are local-only. `results/` is ignored by Git, including `results/binary_experiment.jsonl`.

## Scale Commands

```powershell
$env:MNDE_BINARY_SCALE_DECISIONS='100000'; node --expose-gc --experimental-strip-types .\scripts\scale_binary_experiment.mjs
```

The local `results/binary_experiment.jsonl` proof artifact can be regenerated with the same harness.

## Latest Local 100,000 Decision Artifact Summary

```text
BINARY_EXPERIMENT_SCALE_REPORT
total_decisions: 100000
json_core_bytes_total: 32714993
binary_core_bytes_total: 12065000
bytes_saved_total: 20649993
percent_reduction: 63.12
encoder_errors: 0
observer_errors: 0
decision_mismatches: 0
hash_mismatches: 0
signature_mismatches: 0
off_pass_binary_calls: 0
determinism_unique_hashes: 1
reversibility_confirmed: true
tamper_detected: true
failure_injection_handled: true
verdict: PASS
```

## Future Gate

Reconsider binary only after a canonical format is defined, determinism guarantees are identical, and full audit parity with JSON is proven.
