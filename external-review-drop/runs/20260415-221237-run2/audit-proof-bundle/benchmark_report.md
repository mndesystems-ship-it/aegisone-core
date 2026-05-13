# benchmark_report

generated_at: 2026-04-16T05:12:40.561Z
total_runs: 1011280
determinism_mismatch_rate: 0
parity_mismatch_rate: 0
replay_drift_rate: 0
rejection_accuracy: 100

| profile | throughput_rps | p50_ms | p95_ms | p99_ms | cpu_percent | peak_rss_bytes | baseline_throughput_delta_percent | baseline_p95_delta_percent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| allow_burst | 5521.619071 | 0.1535 | 0.3751 | 0.5639 | 103.806439 | 319868928 | -82.215251 | 456.52819 |
| refuse_burst | 5363.888905 | 0.1616 | 0.3731 | 0.612 | 92.258889 | 319967232 | -84.917549 | 588.376384 |
| mixed_50_50 | 6010.211349 | 0.1493 | 0.299 | 0.5141 | 75.127642 | 320016384 | -86.384828 | 693.103448 |
| adversarial_malformed | 9572.895686 | 0.0891 | 0.2747 | 0.5138 | 105.301853 | 320180224 | -77.43276 | 492.025862 |
| replay_storm | 6132.993974 | 0.1439 | 0.2938 | 0.5593 | 105.487496 | 320249856 | -85.494549 | 580.092593 |
