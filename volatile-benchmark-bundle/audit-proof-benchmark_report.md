# benchmark_report

generated_at: 2026-05-13T21:14:35.848Z
total_runs: 1012080
determinism_mismatch_rate: 0
parity_mismatch_rate: 0
replay_drift_rate: 0
rejection_accuracy: 100

| profile | throughput_rps | p50_ms | p95_ms | p99_ms | cpu_percent | peak_rss_bytes | baseline_throughput_delta_percent | baseline_p95_delta_percent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| allow_burst | 2377.249532 | 0.3832 | 0.7731 | 1.0248 | 77.973785 | 342036480 | -93.312013 | 1292.972973 |
| refuse_burst | 2598.317745 | 0.3494 | 0.6599 | 0.8701 | 97.436915 | 341176320 | -91.457771 | 954.153355 |
| mixed_50_50 | 2190.710075 | 0.387 | 0.7607 | 1.0002 | 89.1619 | 341360640 | -92.706798 | 1151.151316 |
| adversarial_malformed | 8178.139506 | 0.1044 | 0.3314 | 0.4848 | 76.874511 | 341733376 | -74.996647 | 384.502924 |
| replay_storm | 2302.350147 | 0.4099 | 0.7042 | 0.9217 | 104.296462 | 341749760 | -92.280404 | 1023.125997 |
