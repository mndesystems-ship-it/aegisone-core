# benchmark_report

generated_at: 2026-04-16T05:20:59.623Z
total_runs: 1011280
determinism_mismatch_rate: 0
parity_mismatch_rate: 0
replay_drift_rate: 0
rejection_accuracy: 100

| profile | throughput_rps | p50_ms | p95_ms | p99_ms | cpu_percent | peak_rss_bytes | baseline_throughput_delta_percent | baseline_p95_delta_percent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| allow_burst | 5633.310894 | 0.1542 | 0.347 | 0.5942 | 96.892947 | 346578944 | -84.257149 | 502.430556 |
| refuse_burst | 5722.958449 | 0.1493 | 0.3622 | 0.545 | 80.121418 | 346828800 | -84.529069 | 628.772636 |
| mixed_50_50 | 5838.815982 | 0.1511 | 0.3305 | 0.5763 | 109.185859 | 346988544 | -85.273397 | 516.604478 |
| adversarial_malformed | 8342.593612 | 0.091 | 0.349 | 0.5742 | 91.76853 | 347078656 | -78.470769 | 429.590288 |
| replay_storm | 5362.896479 | 0.1579 | 0.4077 | 0.5851 | 92.241819 | 347131904 | -87.061476 | 863.829787 |
