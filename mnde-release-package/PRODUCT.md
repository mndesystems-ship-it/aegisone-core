# MNDe Execution Control Sidecar

Product name: MNDe Execution Control Sidecar

Function: local HTTP service that deterministically allows or refuses execution requests and returns signed receipts.

API surface:

- `POST /v1/decisions`
- `GET /healthz`
- `GET /readyz`
- `GET /metrics`

Customer integration point:

- Intercept a transaction, agent tool call, batch job, or provisioning action before execution.
- Send the execution request, pricing data, and signed request headers to `POST /v1/decisions`.
- Execute the action only when the response contains `decision: "ALLOW"`.
- Store the returned receipt for audit and verification.

