# MNDe API Surface

This file separates the launch contract from local demo helpers.

## Public Launch Contract

Customer integrations should call:

- `POST /v1/decisions`
- `GET /healthz`
- `GET /readyz`
- `GET /metrics`

`POST /v1/decisions` is the execution gate. A customer intercepts a transaction, agent tool call, batch job, or provisioning action before it runs, sends the execution request to MNDe, and only executes when the response contains `decision: "ALLOW"`.

The response includes:

- `decision`
- `reason_code`
- `request_hash`
- `decision_hash`
- cost fields
- `policy_version`
- `policy_hash`
- signed `receipt`

## Local Demo Helpers

The local no-code UI also uses:

- `POST /verify`
- `POST /replay`

These routes are for receipt demonstration inside the local UI. They are not the primary customer execution-control surface.

The local adapter also accepts `POST /decide` as a legacy alias for `POST /v1/decisions` so older demos keep working. New docs, demos, and integrations should use `/v1/decisions`.

## Launch Rule

Use this wording externally:

> MNDe is a local execution-control sidecar. Integrate it by sending execution requests to `POST /v1/decisions` before action. Execute only on `ALLOW`, and store the returned signed receipt for audit.
