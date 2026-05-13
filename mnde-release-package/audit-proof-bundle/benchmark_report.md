# benchmark_report

generated_at: 2026-04-18T23:00:27.615Z
total_runs: 1012080
determinism_mismatch_rate: 0
parity_mismatch_rate: 0
replay_drift_rate: 0
rejection_accuracy: 100

| profile | throughput_rps | p50_ms | p95_ms | p99_ms | cpu_percent | peak_rss_bytes | baseline_throughput_delta_percent | baseline_p95_delta_percent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| allow_burst | 3143.412539 | 0.3011 | 0.4596 | 0.6062 | 93.359352 | 368840704 | -92.950143 | 1128.877005 |
| refuse_burst | 3157.519491 | 0.3016 | 0.449 | 0.5408 | 113.670702 | 369025024 | -92.846324 | 1110.242588 |
| mixed_50_50 | 3192.964239 | 0.2986 | 0.4489 | 0.545 | 84.932849 | 368627712 | -93.160926 | 1153.910615 |
| adversarial_malformed | 11214.119024 | 0.0783 | 0.2331 | 0.3241 | 105.412719 | 368672768 | -77.386729 | 493.129771 |
| replay_storm | 3112.38802 | 0.3033 | 0.4655 | 0.5882 | 121.383133 | 368734208 | -93.301612 | 1193.055556 |
