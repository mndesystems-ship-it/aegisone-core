# MNDe Sidecar sustained Benchmark

```json
{
  "mode": "sustained",
  "sidecar_url": "http://127.0.0.1:8787/v1/decisions",
  "profile": {
    "workers": 25,
    "duration_ms": 2000
  },
  "workload_hash": "8cc2dbccc1fcdbdaf3d45f4f0715b117484cf6168f0aec9a43dc9b22473e06fe",
  "total": 2822,
  "http_errors": 0,
  "unexpected_allows": 0,
  "unsigned_allows": 0,
  "queue_saturated": 0,
  "replay_mismatches": 0,
  "signature_failures": 0,
  "receipts_sampled_for_replay": 1000,
  "p50_ms": 17.031,
  "p90_ms": 21.406,
  "p95_ms": 23.452,
  "p99_ms": 44.255,
  "p999_ms": 59.253,
  "max_ms": 70.333,
  "requests_per_second": 1411,
  "readyz": {
    "active_policy_version": "policy.v1",
    "durability_mode": "throughput",
    "inflight": 0,
    "max_inflight": 512,
    "ok": true,
    "policy_hash": "f36b9177cc6b2331beefbf3831c97ce81de70e70b7982cb62d69b821236fdf6d",
    "receipt_queue": {
      "accepted": 2402,
      "fail_closed": false,
      "fail_closed_reason": null,
      "flush_count": 30,
      "flush_failures": 0,
      "flushed_receipts": 2402,
      "last_flush_ms": 3,
      "max_queue_bytes": 371653,
      "max_queue_depth": 106,
      "persistence_flush_ms_total": 1498,
      "queue_bytes": 0,
      "queue_depth": 0,
      "saturated": 0
    },
    "worker_id": 0
  },
  "verdict": "PASS"
}
```
