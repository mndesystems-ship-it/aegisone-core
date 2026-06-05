# Operational Model

Operators run MNDe as a local deterministic sidecar or package it for release verification. The sidecar exposes:

- `POST /v1/decisions`
- `GET /healthz`
- `GET /readyz`
- `GET /metrics`
- `POST /verify`
- `POST /replay`

Operational controls:

- HTTP admission sheds overload before accepting work.
- Worker pool saturation returns deterministic refusal.
- Receipt queue saturation returns deterministic refusal.
- Socket watchdogs close unsafe idle or overloaded connections.
- Custody startup checks refuse malformed or missing release material.

Generated operational output belongs in ignored output folders, not in the active source tree.
