# CLAIM

- Scoped claim: Deterministic decision layer produces byte-identical receipts and manifests across independent reruns.
- Performance claim: Performance characteristics are stable within defined tolerance bands under controlled conditions, with workload and environment hashes recorded.
- Performance posture: benchmark methodology is fixed and falsifiable; current environment does not yet satisfy the `3%` stability band.

- Stable manifest SHA-256: `6f62088b0e60f32574e6556a85553e194dc92f2773efd211e61f3cdb0cc1e8c9`
- Stable receipts SHA-256: `f134996223a184864622da8a3d44d774dfe35beaed0cfb9ae3580cb4ccce28f8`

- Zero drift over `1,011,280` audit executions
- Zero replay mismatches
- Zero cross-runtime mismatches

- Benchmark anchor: `mixed_50_50_allow_refuse`
- Benchmark verification rule: within band across `3` consecutive runs
- Throughput tolerance: `<= 3%`
- Latency p99 tolerance: `<= 3%`
- Current locked-run result: throughput spread `4.34057%`, anchor p99 spread `12.101911%`, combined decision-layer p99 spread `5.147059%`

Verify:

```powershell
npm run proof:full
powershell -ExecutionPolicy Bypass -File .\scripts\prove_repeatability.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\run_controlled_benchmark_triplicate.ps1
```
