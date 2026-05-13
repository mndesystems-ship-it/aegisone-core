# benchmark_report

generated_at: 2026-04-16T05:41:29.651Z
total_runs: 1011280
determinism_mismatch_rate: 0
parity_mismatch_rate: 0
replay_drift_rate: 0
rejection_accuracy: 100

| profile | throughput_rps | p50_ms | p95_ms | p99_ms | cpu_percent | peak_rss_bytes | baseline_throughput_delta_percent | baseline_p95_delta_percent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| allow_burst | 5981.065144 | 0.1435 | 0.3401 | 0.5685 | 112.444025 | 274894848 | -85.518585 | 739.753086 |
| refuse_burst | 6108.246683 | 0.1425 | 0.3187 | 0.5383 | 76.353084 | 274907136 | -85.629495 | 568.134172 |
| mixed_50_50 | 6174.886367 | 0.1432 | 0.3011 | 0.5609 | 106.208046 | 275189760 | -84.201306 | 523.395445 |
| adversarial_malformed | 10103.479841 | 0.0807 | 0.2594 | 0.5224 | 78.807143 | 275202048 | -72.723737 | 331.613977 |
| replay_storm | 5765.968562 | 0.1516 | 0.3243 | 0.5416 | 72.074607 | 274362368 | -86.304268 | 706.716418 |
