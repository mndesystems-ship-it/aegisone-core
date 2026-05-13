# MNDe Sidecar Production Latency Scaling

## Architecture

The local sidecar no longer persists receipts with synchronous `appendFileSync` on the request path. Successful deterministic decisions build and sign the same receipt payload as before, then enqueue the canonical receipt line into an internal bounded persistence queue.

The queue flushes with ordered batched appends when any of these conditions occur:

- `MNDE_RECEIPT_BATCH_MAX_SIZE` is reached.
- `MNDE_RECEIPT_BATCH_MAX_AGE_MS` elapses.
- The process receives shutdown and drains pending entries.

Ordering is guaranteed within a single worker by enqueue order and flush order. In cluster mode each worker writes its own receipt log suffix, for example `receipts.worker-1.jsonl`, so cross-worker file interleaving cannot corrupt JSONL records. Global receipt order across workers is not a correctness primitive; receipt signatures, request hashes, decision hashes, and canonical requests are the audit truth.

## Durability Modes

`MNDE_RECEIPT_DURABILITY_MODE=strict_audit` sends the response only after the batch containing the signed receipt is durably appended.

`MNDE_RECEIPT_DURABILITY_MODE=throughput` sends the response after the signed receipt is accepted into the bounded queue. This mode is still fail-closed: if the queue cannot accept the receipt, the sidecar returns `REFUSE` with `ERR_RECEIPT_QUEUE_SATURATED`.

Both modes preserve deterministic replay, signed receipt verification, and fail-closed overload handling.

## Backpressure

The sidecar enforces:

- `MNDE_MAX_INFLIGHT`
- `MNDE_RECEIPT_QUEUE_MAX_ITEMS`
- `MNDE_RECEIPT_QUEUE_MAX_BYTES`

When any bound is exceeded, the response is deterministic:

```text
decision: REFUSE
reason_code: ERR_RECEIPT_QUEUE_SATURATED
receipt: null
```

No receipts are silently dropped. No unsigned `ALLOW` response is emitted. Flush failure places the queue in fail-closed mode.

## Instrumentation

Decision responses include timing fields:

- `parse_ms`
- `preflight_ms`
- `orbit_ms`
- `arm_ms`
- `ramona_ms`
- `canonicalize_ms`
- `receipt_build_ms`
- `signing_ms`
- `receipt_queue_ms`
- `persistence_flush_ms`
- `total_ms`

The `/readyz` endpoint reports queue depth, queue bytes, fail-closed state, inflight count, and durability mode. The `/metrics` endpoint emits queue saturation counters, flush failure counters, overload counters, queue depth, queue bytes, and aggregate latency averages.

## Cluster Mode

Set:

```powershell
$env:MNDE_CLUSTER_MODE='1'
$env:MNDE_CLUSTER_WORKERS='8'
node --experimental-strip-types .\mnde-local-sidecar.mjs
```

Workers share the same public port through Node cluster. Each worker runs the deterministic pipeline independently and writes a separate worker receipt log. Replay remains receipt-local because every receipt contains the canonical request and signed decision output.

## Benchmarks

Run the sidecar first, then run:

```powershell
npm run bench:sidecar:sustained
npm run bench:sidecar:burst
npm run bench:sidecar:overload
npm run bench:sidecar:replay
npm run bench:sidecar:parity
```

Reports are written to `sidecar-scaling-output/` and include latency percentiles, throughput, queue saturation, signature verification, replay drift, and `/readyz` queue telemetry.

## Threat Analysis

- Queue saturation cannot turn a refused or overloaded request into an allow.
- Flush failure cannot emit new successful responses after fail-closed activation.
- Signed receipt material does not include runtime timing metrics, so instrumentation cannot perturb receipt hashes.
- Cluster mode avoids multi-process writes into the same JSONL file by using per-worker files.
- Replay verification remains based on the signed canonical request, not wall-clock order.

## Production Readiness Verdict

This implementation removes the known blocking receipt append from the request hot path and adds bounded overload behavior. Production readiness still requires fresh hostile benchmark evidence on the target machine. The release target remains:

- 3,000+ sustained local req/s
- mixed p99 under 100ms
- spike p99 under 250ms
- zero unsigned allows
- zero replay mismatches
- zero signature failures
