# MNDe Sidecar Torture Bench Reproducibility

This benchmark drives the real local HTTP sidecar at `POST http://127.0.0.1:8787/v1/decisions`.

It does not import or call `executeDeterministicPipeline` from the benchmark. Replay and signature checks use sidecar HTTP endpoints.

## Commands

Terminal 1:

```powershell
node --experimental-strip-types .\mnde-local-sidecar.mjs
```

Terminal 2:

```powershell
node --experimental-strip-types .\scripts\mnde_sidecar_torture_bench.mjs
node --experimental-strip-types .\scripts\verify_sidecar_torture_report.mjs
```

For a short local shakeout only:

```powershell
$env:MNDE_TORTURE_FAST='1'; node --experimental-strip-types .\scripts\mnde_sidecar_torture_bench.mjs
```

## Output

- `hostile-verifier-proof-bundle/sidecar-torture-summary.json`
- `hostile-verifier-proof-bundle/sidecar-torture-latency.csv`
- `hostile-verifier-proof-bundle/sidecar-torture-errors.jsonl`
- `hostile-verifier-proof-bundle/sidecar-torture-replay-report.json`
- `hostile-verifier-proof-bundle/sidecar-torture-custody-report.json`
- `hostile-verifier-proof-bundle/sidecar-torture-reproducibility.md`

`verdict: PASS` is allowed only when every hard criterion in the summary passes.

## Latest Full Run

```text
SIDECAR_TORTURE_BENCH_REPORT
verdict: FAIL
total_requests: 504107
requests_per_second_avg: 367.3
requests_per_second_peak: 3460
p95_ms: 764.771
p99_ms: 789.53
p999_ms: 863.736
http_5xx: 0
unexpected_allows: 0
unsigned_allows: 0
drift_mismatches: 0
replay_mismatches: 0
signature_failures: 0
late_response_upgrades: 0
persisted_receipts: 400242
prevented_cost_usd: 9031440
prevented_cost_percent: 26.51
failed_criterion: mixed_p99_under_100
failed_criterion: spike_p99_under_250
```

Verifier output confirmed the same FAIL verdict because mixed p99 was `224.363ms` and spike p99 was `825.2ms`.
