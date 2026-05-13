# benchmark_report

generated_at: 2026-04-16T05:53:24.107Z
total_runs: 1011280
determinism_mismatch_rate: 0
parity_mismatch_rate: 0
replay_drift_rate: 0
rejection_accuracy: 100

| profile | throughput_rps | p50_ms | p95_ms | p99_ms | cpu_percent | peak_rss_bytes | baseline_throughput_delta_percent | baseline_p95_delta_percent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| allow_burst | 5946.162258 | 0.1475 | 0.3136 | 0.6563 | 129.626337 | 314273792 | -85.488807 | 636.150235 |
| refuse_burst | 6003.445978 | 0.1464 | 0.3052 | 0.6585 | 150.086149 | 314548224 | -84.881702 | 572.246696 |
| mixed_50_50 | 6266.791083 | 0.1394 | 0.2875 | 0.4805 | 97.761941 | 314896384 | -84.405466 | 518.27957 |
| adversarial_malformed | 10557.867142 | 0.0818 | 0.2504 | 0.4379 | 82.351364 | 315084800 | -70.118597 | 310.491803 |
| replay_storm | 5232.380482 | 0.1605 | 0.397 | 0.6589 | 81.625136 | 315133952 | -87.254235 | 873.039216 |
