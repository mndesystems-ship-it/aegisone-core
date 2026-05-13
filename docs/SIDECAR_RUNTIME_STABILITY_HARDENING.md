# MNDe Local Sidecar Runtime Stability Hardening

## Scope

This pass hardens only the local sidecar HTTP/runtime layer. It does not change deterministic decision logic, canonicalization, policy evaluation order, `request_hash`, `decision_hash`, receipt schema, receipt signing, or replay semantics.

## Runtime Changes

- Added `sidecar/socket_registry.mjs` for centralized socket tracking, idle eviction, shutdown drain, open/idle/destroyed counters, and deterministic cleanup.
- Added `sidecar/runtime_watchdog.mjs` for heartbeat, event-loop lag, degraded/fatal state, and watchdog intervention telemetry.
- Added worker task deadlines in `sidecar/deterministic_worker_pool.mjs`.
- Added deterministic `ERR_WORKER_TIMEOUT` handling and automatic worker replacement.
- Added receipt flush timeout and bounded shutdown drain in `sidecar/receipt_persistence_queue.mjs`.
- Updated `mnde-local-sidecar.mjs` to emit `Connection: close` by default for local responses, expose runtime telemetry, isolate `/healthz`, and refuse new decisions when watchdog state is degraded or fatal.
- Sanitized readiness telemetry so all JSON responses remain compatible with strict integer-only canonicalization.

## Health and Readiness

`/healthz` is intentionally lightweight. It does not query the worker pool, receipt queue, filesystem, metrics generation, or external state. It reports only process-level liveness, degraded/fatal flags, event-loop lag, and worker id.

`/readyz` reports richer runtime state, including receipt queue, worker pool, socket registry, watchdog state, active policy, and durability mode. If the runtime is degraded or receipt persistence has failed closed, readiness reflects that.

## Browser-Origin Torture Result

Command:

```powershell
npm run test:sidecar-browser-torture
```

Result:

```json
{
  "decisions": 7937,
  "health_polls": 118,
  "health_p95_ms": 13,
  "decision_p95_ms": 18
}
```

Failure matrix:

```json
{
  "health_unresponsive": 0,
  "decision_transport_errors": 0,
  "refresh_errors": 0,
  "unsigned_allows": 0
}
```

Telemetry highlights:

- Browser-origin requests: `7879`
- L0 deterministic 503 sheds: `58`
- L0 destroy sheds: `0`
- Worker-pool saturation refusals: `788`
- Receipt queue saturation refusals: `0`
- Receipt flush failures: `0`
- Receipt flush timeouts: `0`
- Runtime degraded: `0`
- Runtime fatal: `0`
- Watchdog interventions: `0`
- Open sockets at final metrics snapshot: `1`
- Idle sockets destroyed: `1`
- Unsigned allows blocked: `0`

## Receipt Integrity

Command:

```powershell
node --experimental-strip-types -e "import { readFileSync } from 'node:fs'; import { verifySignedReceipt } from './audit/node_runtime.ts'; const lines = readFileSync('./sidecar-scaling-output/browser-origin-runtime-torture/receipts.jsonl','utf8').trim().split(/\r?\n/).filter(Boolean); let invalid=0; for (const line of lines) { if (!verifySignedReceipt(JSON.parse(line))) invalid++; } console.log(JSON.stringify({ receipts: lines.length, invalid_signatures: invalid })); if (invalid) process.exit(1);"
```

Result:

```json
{
  "receipts": 7879,
  "invalid_signatures": 0
}
```

## Stability Proof Bundle

Generated folder:

```text
sidecar-stability-proof-bundle/
```

Contents:

- `browser-origin-torture-summary.json`
- `runtime-failure-matrix.json`
- `latency-distribution.json`
- `signed-receipts.jsonl`

These files are compatible with existing MNDe sidecar receipt verification because the signed receipt shape and signature verification path are unchanged.

## Additional Verification

Commands:

```powershell
npm run test:sidecar-scaling
npm run test:codex-mnde
```

Results:

- `PASS sidecar latency scaling tests`
- `PASS sidecar admission control tests`
- `PASS codex MNDe integration tests`

## Runtime Failure Matrix

| Condition | Behavior |
| --- | --- |
| Browser keepalive accumulation | Responses default to `Connection: close`; idle sockets are evicted. |
| Socket accumulation | Watchdog degrades runtime before accepting new decisions indefinitely. |
| Worker saturation | Deterministic refusal via existing worker-pool saturation reason. |
| Worker timeout | Deterministic `ERR_WORKER_TIMEOUT`; worker is replaced. |
| Receipt queue saturation | Deterministic `ERR_RECEIPT_QUEUE_SATURATED`; no request waits indefinitely. |
| Receipt flush timeout/failure | Queue fails closed; readiness reports degraded state. |
| Event-loop lag | Watchdog tracks lag and degrades/fatal-flags runtime according to configured limits. |
| Shutdown | Watchdog stops, HTTP server closes, receipt queue drains boundedly, workers terminate, remaining sockets are destroyed. |

## Residual Notes

The hardening pass intentionally keeps timing and runtime telemetry outside signed receipt content. This preserves deterministic receipt bytes, replay behavior, and cross-runtime compatibility.
