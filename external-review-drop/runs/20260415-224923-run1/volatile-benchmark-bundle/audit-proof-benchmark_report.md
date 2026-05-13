# benchmark_report

generated_at: 2026-04-16T05:49:26.459Z
total_runs: 1011280
determinism_mismatch_rate: 0
parity_mismatch_rate: 0
replay_drift_rate: 0
rejection_accuracy: 100

| profile | throughput_rps | p50_ms | p95_ms | p99_ms | cpu_percent | peak_rss_bytes | baseline_throughput_delta_percent | baseline_p95_delta_percent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| allow_burst | 6154.550613 | 0.1442 | 0.3006 | 0.4828 | 57.852776 | 341544960 | -84.348547 | 518.518519 |
| refuse_burst | 6209.664349 | 0.1428 | 0.3014 | 0.516 | 87.556267 | 341565440 | -83.236949 | 527.916667 |
| mixed_50_50 | 6142.245814 | 0.1441 | 0.3042 | 0.4655 | 105.646628 | 341676032 | -81.265536 | 344.736842 |
| adversarial_malformed | 8670.116795 | 0.0895 | 0.3468 | 0.4806 | 81.499098 | 341684224 | -75.708067 | 465.742251 |
| replay_storm | 5914.227147 | 0.1467 | 0.3183 | 0.5527 | 101.724707 | 341712896 | -85.684258 | 645.433255 |
