# benchmark_report

generated_at: 2026-04-16T05:16:56.636Z
total_runs: 1011280
determinism_mismatch_rate: 0
parity_mismatch_rate: 0
replay_drift_rate: 0
rejection_accuracy: 100

| profile | throughput_rps | p50_ms | p95_ms | p99_ms | cpu_percent | peak_rss_bytes | baseline_throughput_delta_percent | baseline_p95_delta_percent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| allow_burst | 6066.407752 | 0.1452 | 0.3151 | 0.4702 | 151.660194 | 299716608 | -85.795082 | 683.830846 |
| refuse_burst | 6064.406422 | 0.1474 | 0.301 | 0.497 | 114.010841 | 299814912 | -84.45917 | 527.083333 |
| mixed_50_50 | 5642.200955 | 0.1562 | 0.331 | 0.5819 | 78.990813 | 300093440 | -85.919267 | 595.378151 |
| adversarial_malformed | 9159.388006 | 0.0871 | 0.3018 | 0.5957 | 86.098247 | 300134400 | -71.404299 | 300.796813 |
| replay_storm | 5287.304178 | 0.1541 | 0.4106 | 0.629 | 66.620033 | 300154880 | -86.875166 | 706.679764 |
