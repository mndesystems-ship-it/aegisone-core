# MNDe Sidecar Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate half-dead MNDe local sidecar states while preserving deterministic decision, hash, policy, receipt, and replay behavior.

**Architecture:** Keep the deterministic decision engine untouched and harden only the HTTP/runtime boundary. Add isolated socket management, request deadlines, worker deadlines, bounded receipt persistence deadlines, watchdog telemetry, and browser-origin torture verification.

**Tech Stack:** Node.js ESM, built-in `http`, `worker_threads`, PowerShell launch scripts, existing MNDe audit and receipt tooling.

---

### Task 1: Browser-Origin Regression Harness

**Files:**
- Create: `scripts/test_browser_origin_runtime_torture.mjs`
- Modify: `package.json`

- [ ] Write a failing test that starts `mnde-local-sidecar.mjs`, sends browser-origin keepalive requests, polls `/healthz`, and fails if the process remains alive while endpoints hang.
- [ ] Verify it fails against the current sidecar or reproduces the wedge.
- [ ] Add an npm script named `test:sidecar-browser-torture`.

### Task 2: Socket Registry

**Files:**
- Create: `sidecar/socket_registry.mjs`
- Modify: `mnde-local-sidecar.mjs`
- Test: `scripts/test_sidecar_admission_control.mjs`

- [ ] Add centralized socket tracking with open, idle, destroyed, and timeout counters.
- [ ] Default local responses to `Connection: close`.
- [ ] Destroy stale idle sockets on an interval.
- [ ] Destroy all remaining sockets during shutdown.

### Task 3: Watchdog

**Files:**
- Create: `sidecar/runtime_watchdog.mjs`
- Modify: `mnde-local-sidecar.mjs`

- [ ] Track heartbeat timestamps, event-loop lag, degraded state, fatal state, and interventions.
- [ ] Keep `/healthz` independent of worker pool, receipt queue, filesystem, and metrics.
- [ ] Let `/readyz` report degraded runtime state.
- [ ] Refuse new decisions when degraded.

### Task 4: Worker Deadlines

**Files:**
- Modify: `sidecar/deterministic_worker_pool.mjs`
- Test: `scripts/test_sidecar_latency_scaling.mjs`

- [ ] Add task timeout config.
- [ ] Resolve timed-out tasks as `ERR_WORKER_TIMEOUT`.
- [ ] Terminate and replace timed-out or failed workers.
- [ ] Add timeout and restart telemetry.

### Task 5: Receipt Persistence Deadlines

**Files:**
- Modify: `sidecar/receipt_persistence_queue.mjs`
- Test: `scripts/test_sidecar_latency_scaling.mjs`

- [ ] Add flush timeout config.
- [ ] Fail closed on flush timeout or flush failure.
- [ ] Add queue and flush telemetry without changing receipt bytes.
- [ ] Ensure shutdown drain is bounded.

### Task 6: Sidecar Request Deadlines

**Files:**
- Modify: `mnde-local-sidecar.mjs`

- [ ] Add deterministic request deadline handling.
- [ ] Return signed fail-closed refusal for timeout paths when possible.
- [ ] Avoid waiting indefinitely on workers or filesystem writes.
- [ ] Preserve existing refusal responses and receipt compatibility.

### Task 7: Reports and Verification

**Files:**
- Create or update: `docs/SIDECAR_RUNTIME_STABILITY_HARDENING.md`
- Output: `sidecar-scaling-output/` and `hostile-verifier-proof-bundle/`

- [ ] Run browser-origin torture verification.
- [ ] Run sidecar scaling/admission checks.
- [ ] Run Codex MNDe integration check.
- [ ] Run replay/signature checks where available.
- [ ] Document benchmark, failure matrix, latency distribution, deterministic overload results, and known residual risks.
