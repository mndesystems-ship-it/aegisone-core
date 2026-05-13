# MNDe Review Spec And System Rundown

## Executive Summary

MNDe is a local execution-control sidecar. It sits before an expensive or risky action, evaluates a strict execution request against policy and runtime evidence, returns `ALLOW` or `REFUSE`, and emits a signed receipt that can be stored, replayed, and verified later.

Reviewers should evaluate three claims:

- Decision control: MNDe blocks unsafe, over-budget, replayed, malformed, or policy-incompatible requests before execution.
- Determinism: the same canonical request and policy produce the same decision, hashes, and receipt.
- Auditability: every decision has a receipt containing canonical request input, decision output, pipeline traces, hashes, policy identity, and signatures.

## Launch Integration Contract

Public runtime API:

- `POST /v1/decisions`
- `GET /healthz`
- `GET /readyz`
- `GET /metrics`

Integration rule:

1. Intercept the transaction, agent tool call, batch job, provisioning request, or other action before it runs.
2. Send the execution request and pricing data to `POST /v1/decisions`.
3. Execute the action only when the response contains `decision: "ALLOW"`.
4. Store the returned signed receipt for audit and later verification.

Local demo helpers:

- `POST /verify`
- `POST /replay`

These helpers support the local no-code UI and receipt demonstrations. They are not the primary execution-control endpoint. `POST /decide` is retained only as a local legacy alias for `POST /v1/decisions`.

## System Components

### Sidecar Runtime

The packaged sidecar exposes the public runtime API, validates startup requirements, loads policy, checks request signatures, enforces replay protections, authorizes submitters, executes the deterministic decision pipeline, persists receipts, emits metrics, and fails closed on unsafe states.

Primary files:

- `mnde-release-package/app/sidecar/server.js`
- `mnde-local-sidecar.mjs`

### Decision Pipeline

The deterministic pipeline is implemented in `audit/node_runtime.ts` and calls these layers in order:

1. `preflight`: strict JSON parsing, canonicalization, schema validation, safe integer checks, policy signature checks, policy version pinning, and request/policy hash derivation.
2. `orbit`: intent and tool-call validation, lifecycle enforcement, and forbidden parameter pattern checks.
3. `arm`: cost projection, GPU/hour/retry/autoscale limits, execution ID single-use behavior, budget token reservation, and prevented-cost calculation.
4. `ramona`: runtime observation checks, kill switch enforcement, observed GPU/hour/cost drift checks, receipt construction, and receipt signature verification.

Primary files:

- `preflight/engine.ts`
- `orbit/engine.ts`
- `arm/engine.ts`
- `ramona/engine.ts`
- `audit/node_runtime.ts`

### Receipt System

Receipts contain:

- `schema_version`
- canonical request
- request hash
- decision output
- policy version and policy hash
- execution ID
- cost fields
- pipeline traces
- legacy HMAC signature
- verifiable Ed25519 signature

Receipt tooling supports verification, replay, indexing, search, stats, proof resolution, and audit export.

Primary files:

- `ramona/engine.ts`
- `mnde-release-package/app/receipts/`
- `mnde-release-package/app/api/receipts.js`
- `mnde-release-package/app/api/receipts_handlers.js`

### No-Code Review UI

The UI is a local review and demo surface. It lets a reviewer set request fields with controls instead of editing JSON, runs the public `/v1/decisions` route, and exposes receipt replay/verification helpers.

Primary files:

- `index.html`
- `main.js`
- `request-builder.js`
- `styles.css`
- `mnde-ui-static-server.mjs`

### Operations Layer

The operations layer covers install/start/stop/status lifecycle, config validation, logs, receipt rotation, disk checks, signer health, readiness, launch checklist, and incident runbook.

Primary files:

- `lifecycle/`
- `config/custody.config.template.json`
- `shared/operations.js`
- `operator_runbook.md`
- `OPERATIONS_LAUNCH_CHECKLIST.md`

### Release Integrity

Release artifacts are intended to be immutable after publication. A rebuild or byte-level change requires a new version, signed manifest, provenance, and published SHA256.

Primary files:

- `RELEASE_INTEGRITY.md`
- `release/verify_manifest.ts`
- `release/provenance.ts`
- `scripts/build_release_package.mjs`

## Request Shape

A decision request contains:

- `execution_request`
- `pricing_data`
- optional or injected `policy_document`

Key execution fields:

- actor: `execution_request.actor.user_id`
- identity: `request_id`, `release_request.execution_id`
- resources: GPU type, GPU count, hours
- execution behavior: autoscale, retries, retry-on-fail
- tool calls: requested tools and priorities
- orbit intent: version, action, boundary, lifecycle state, payload tool calls, signatures
- release state: hold state, consumed flag
- runtime observation: observed GPU count, hours, total cost, kill switch
- budget token when configured

The local UI maps all visible controls into this request shape through `request-builder.js`.

## Response Shape

`POST /v1/decisions` returns:

- `schema_version`
- `request_id`
- `decision`
- `reason_code`
- `request_hash`
- `decision_hash`
- `total_cost_usd`
- `allowed_cost_usd`
- `prevented_cost_usd`
- `policy_version`
- `policy_hash`
- `receipt`

The customer should treat any non-`ALLOW` decision as a stop condition.

## Security And Safety Model

MNDe is designed around fail-closed behavior:

- Strict JSON rejects duplicate keys, invalid syntax, invalid numbers, unknown unsafe fields, and unsafe numeric values.
- Policy validation rejects wrong schema, wrong version, invalid key ID, and invalid signature.
- Request validation rejects signature failures, body hash mismatches, timestamp skew, nonce replay, schema errors, and forbidden parameter patterns.
- Arm checks reject cost, GPU, hours, retry, autoscale, execution replay, and budget-token violations.
- Runtime observation rejects kill-switch activation and observed drift beyond the requested envelope.
- Operations readiness reports not-ready when manifest, config, signer, disk, or receipt-store state is unsafe.

Known review focus:

- Confirm the packaged runtime uses external customer key material and does not rely on demo fixture secrets.
- Confirm production signer credentials and policy signing keys remain outside the release artifact.
- Confirm customers understand that local UI receipt helpers are review/demo tools, while `/v1/decisions` is the execution gate.

## Operational Requirements

Before a pilot or launch:

- Verify release integrity.
- Confirm `status.cmd` reports installed/running/config/manifest health.
- Confirm `/healthz`, `/readyz`, and `/metrics`.
- Confirm one known allow and one known refuse request through `/v1/decisions`.
- Confirm logs and receipt paths are writable and backed up.
- Confirm policy, signer, disk, and receipt-store failures fail closed.
- Save launch evidence: manifest hash, provenance, status output, health snapshots, active policy hash, allow receipt, refuse receipt, rollback package location, operator name, and launch time.

See `OPERATIONS_LAUNCH_CHECKLIST.md` for the full checklist.

## Evidence Already Packaged

Current proof catalog highlights:

- Stable manifest SHA-256: `6f62088b0e60f32574e6556a85553e194dc92f2773efd211e61f3cdb0cc1e8c9`
- Stable receipts SHA-256: `f134996223a184864622da8a3d44d774dfe35beaed0cfb9ae3580cb4ccce28f8`
- Audit executions: `1,011,280`
- Determinism mismatch rate: `0`
- Parity mismatch rate: `0`
- Replay drift rate: `0`
- Rejection accuracy: `100`
- Attack wave: `20/20 PASS`
- Remediation wave: `12/12 PASS`
- Post-remediation verification: `546/546 PASS`
- Controlled benchmark: zero drift, zero replay mismatch, 100 percent unsafe-action blocking, 98 percent cost reduction in benchmark scenario.

Source: `LABELED_TEST_AND_BENCHMARK_CATALOG.md`.

## Reviewer Walkthrough

1. Read `API_SURFACE.md` to confirm the public contract.
2. Run the local UI with `start-mnde-ui.cmd`.
3. Open `http://127.0.0.1:8080/`.
4. Run the safe sample and confirm `ALLOW / OK_ALLOW`.
5. Run the high-cost sample and confirm `REFUSE / ERR_GPU_LIMIT`.
6. Export or copy a receipt.
7. Verify and replay the receipt.
8. Call `/healthz`, `/readyz`, and `/metrics`.
9. Review `OPERATIONS_LAUNCH_CHECKLIST.md`.
10. Review the proof catalog and choose targeted tests to rerun.

## Verification Commands

Core local checks:

```powershell
node scripts/test_no_code_request_builder.mjs
node scripts/test_operations.mjs
node scripts/test_operations_launch_docs.mjs
node scripts/test_review_spec_docs.mjs
```

Launch route smoke test:

```powershell
$body = Get-Content requests\allow-request.json -Raw
Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://127.0.0.1:8787/v1/decisions -ContentType application/json -Body $body
```

Release checks:

```powershell
.\bin\verify-release.cmd
.\status.cmd
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/readyz
Invoke-RestMethod http://127.0.0.1:8787/metrics
```

## Current Launch Status

Prepared:

- Proof package
- Reviewer instructions
- Outreach message
- Live validation plan
- Feedback capture template
- No-code local UI
- Public API surface documentation
- Operations launch checklist
- Review spec

Remaining before broad launch:

- Engage 3 to 5 independent technical reviewers.
- Engage at least 1 design partner or potential customer.
- Execute 1 live validation against a real execution request outside this workspace.
- Collect reviewer feedback and classify findings as launch-blocking, follow-up, or accepted risk.

## Review Questions

Ask reviewers to answer:

- Is the `/v1/decisions` contract clear enough to integrate without live explanation?
- Are refusal reason codes precise and stable enough for operators?
- Can a receipt independently prove what was decided and why?
- Does replay catch drift in a way auditors can understand?
- Are policy, signer, and key boundaries explicit enough for a customer deployment?
- Are operational failure modes sufficiently fail-closed?
- What would block a customer pilot?

## Known Non-Goals For This Review

- MNDe is not a hosted SaaS control plane in this package.
- The local UI is a review and demo surface, not the core enforcement mechanism.
- Receipt helper endpoints are not the primary launch API.
- External validation is not complete until reviewers and a real customer-like request have exercised the system outside this workspace.
