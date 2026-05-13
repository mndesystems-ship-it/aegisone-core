# MNDe Sidecar overload Benchmark

```json
{
  "mode": "overload",
  "sidecar_url": "http://127.0.0.1:8787/v1/decisions",
  "profile": {
    "workers": 80,
    "duration_ms": 1500
  },
  "workload_hash": "e06ea56c6098d0698eb2b8de724882d5f6666ee65db1f6cf5bd71409addf48a6",
  "total": 1810,
  "http_errors": 0,
  "unexpected_allows": 0,
  "unsigned_allows": 0,
  "queue_saturated": 0,
  "replay_mismatches": 0,
  "signature_failures": 0,
  "receipts_sampled_for_replay": 1000,
  "p50_ms": 61.86,
  "p90_ms": 82.398,
  "p95_ms": 86.517,
  "p99_ms": 132.367,
  "p999_ms": 164.572,
  "max_ms": 165.038,
  "requests_per_second": 1206.67,
  "readyz": {
    "active_policy_version": "policy.v1",
    "durability_mode": "throughput",
    "event_loop_lag_ms": 11,
    "inflight": 0,
    "max_inflight": 32,
    "ok": true,
    "policy_hash": "f36b9177cc6b2331beefbf3831c97ce81de70e70b7982cb62d69b821236fdf6d",
    "receipt_queue": {
      "accepted": 1540,
      "fail_closed": false,
      "fail_closed_reason": null,
      "flush_count": 7,
      "flush_failures": 0,
      "flushed_receipts": 1540,
      "last_flush_ms": 4,
      "max_queue_bytes": 1075663,
      "max_queue_depth": 307,
      "persistence_flush_ms_total": 1347,
      "queue_bytes": 0,
      "queue_depth": 0,
      "saturated": 0
    },
    "shed_inflight": 12,
    "worker_id": 0
  },
  "verdict": "PASS"
}
```
