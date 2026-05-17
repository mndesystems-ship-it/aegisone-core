# Architecture

AegisOne Core is a deterministic pre-execution authority. Requests flow through preflight parsing, Orbit intent validation, ARM cost authorization, RAM0NA runtime observation checks, receipt construction, and optional sidecar admission controls.

The runtime path is deliberately small:

- `preflight/` canonicalizes and validates request and policy input.
- `orbit/` verifies intent, lifecycle state, and execution boundary.
- `arm/` enforces projected cost, GPU, hour, retry, and approval rules.
- `ram0na/` compares runtime observation to approved execution bounds.
- `shared/` owns canonical JSON, hashing, contracts, errors, and receipt signing.
- `sidecar/` adds HTTP admission, worker isolation, receipt persistence, and overload refusal.
- `custody/` and `release/` verify release package integrity and deterministic startup refusal.

Proof evidence is operationally separated in `proofs/`. Runtime code does not depend on proof artifacts.
