# benchmark_report

generated_at: 2026-04-16T05:45:23.732Z
total_runs: 1011280
determinism_mismatch_rate: 0
parity_mismatch_rate: 0
replay_drift_rate: 0
rejection_accuracy: 100

| profile | throughput_rps | p50_ms | p95_ms | p99_ms | cpu_percent | peak_rss_bytes | baseline_throughput_delta_percent | baseline_p95_delta_percent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| allow_burst | 5746.043275 | 0.1468 | 0.3317 | 0.5504 | 71.825541 | 274890752 | -86.114169 | 627.412281 |
| refuse_burst | 6209.1554 | 0.1459 | 0.2741 | 0.5699 | 96.862824 | 275963904 | -85.431521 | 595.685279 |
| mixed_50_50 | 6084.601516 | 0.1435 | 0.2956 | 0.6305 | 66.322157 | 275468288 | -84.538419 | 477.34375 |
| adversarial_malformed | 9356.523789 | 0.083 | 0.2827 | 0.4779 | 72.980886 | 275623936 | -68.017905 | 261.971831 |
| replay_storm | 5588.92454 | 0.1513 | 0.394 | 0.6646 | 148.665393 | 275648512 | -85.842695 | 666.536965 |
