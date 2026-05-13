# benchmark_report

generated_at: 2026-04-16T05:08:40.574Z
total_runs: 1011280
determinism_mismatch_rate: 0
parity_mismatch_rate: 0
replay_drift_rate: 0
rejection_accuracy: 100

| profile | throughput_rps | p50_ms | p95_ms | p99_ms | cpu_percent | peak_rss_bytes | baseline_throughput_delta_percent | baseline_p95_delta_percent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| allow_burst | 5892.265812 | 0.1487 | 0.3204 | 0.5041 | 73.653323 | 275628032 | -84.731136 | 566.112266 |
| refuse_burst | 5805.286061 | 0.1512 | 0.3486 | 0.4931 | 109.139378 | 275587072 | -84.319052 | 507.317073 |
| mixed_50_50 | 5538.561403 | 0.1569 | 0.348 | 0.4938 | 86.401558 | 275861504 | -87.492322 | 835.483871 |
| adversarial_malformed | 9431.168503 | 0.0875 | 0.2935 | 0.4119 | 59.416362 | 275931136 | -78.863808 | 584.149184 |
| replay_storm | 5842.961072 | 0.1537 | 0.3344 | 0.5024 | 100.49893 | 275951616 | -84.721709 | 527.39212 |
