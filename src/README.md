# Source Layout

Runtime source is intentionally kept in focused top-level packages for compatibility with existing local scripts and release packaging:

- `orbit/`: intent and boundary validation.
- `arm/`: cost and execution authorization.
- `ram0na/`: runtime observation and receipt construction.
- `preflight/`: request and policy parsing.
- `policy/`: policy contract types.
- `sidecar/`: deterministic worker pool, HTTP admission, receipts, watchdogs, and socket controls.
- `shared/`: canonical JSON, hashing, contracts, errors, and receipt signing.
- `custody/`: startup custody and release integrity enforcement.
- `release/`: release manifest, provenance, and verification code.

`src/` exists as the map for enterprise readers. The runtime paths above remain stable to preserve compatibility-sensitive import and operator surfaces.
