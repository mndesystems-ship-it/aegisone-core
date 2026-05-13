# MNDe Operations Launch Checklist

Use this checklist before any customer pilot, design-partner launch, or public release.

## Go/No-Go Summary

MNDe is launchable only when all of these are true:

- Release integrity verifies with `bin\verify-release.cmd` or the installed `verify-custody-release.cmd`.
- `status.cmd` reports `running: true`, `config_ok: true`, and `manifest_integrity: "PASS"`.
- `GET /healthz` returns `ok: true`.
- `GET /readyz` returns `ok: true` and includes the active policy version and policy hash.
- `GET /metrics` is reachable from the operator monitoring host.
- Runtime logs and receipt files are writable and covered by backup/retention.
- Policy, signer, and receipt-store failures have been tested to fail closed.
- Rollback package and previous signed manifest are available before upgrade.

## Public Runtime Surface

Launch integrations should use:

- `POST /v1/decisions`
- `GET /healthz`
- `GET /readyz`
- `GET /metrics`

Receipt inspection tools may exist locally, but they are not the execution gate. Customers should integrate by calling `POST /v1/decisions` before action and executing only on `decision: "ALLOW"`.

## Required Configuration

Default config path:

```text
C:\ProgramData\MNDe\config\custody.config.json
```

Start from:

```text
config\custody.config.template.json
```

Required launch settings:

- `strict: true`
- `runtime.bind` set to the intended local interface, normally `127.0.0.1:8787`
- `runtime.deny_internal_signing: true`
- `runtime.fail_on_forbidden_artifacts: true`
- `logging.required_for_audit_integrity` explicitly chosen and documented
- `receipts.path` and `receipts.archive_path` on durable storage
- `disk.min_free_bytes` high enough to protect receipt and log writes
- `signer.timeout_ms` aligned with the customer signer SLA
- `policy.mode: "required"`
- `policy.path` set to the customer active policy
- `policy.expected_hash` set when the deployment pins a policy hash

## Observability

Monitor these endpoints:

- `/healthz`: process is alive.
- `/readyz`: process is safe to accept decisions.
- `/metrics`: decision counters and refusal counters.

Monitor these health fields from `status.cmd` or `/readyz`:

- `ready`
- `startup_state`
- `manifest_ok`
- `config_ok`
- `log_status.code`
- `receipt_store_status.code`
- `disk_status.code`
- `custody_status.code`
- `signer_status.code`
- `active_policy_version`
- `policy_hash`

Page an operator when:

- `ready` is false.
- `manifest_ok` is false.
- `config_ok` is false.
- `receipt_store_status.ok` is false.
- `disk_status.code` is `ERR_DISK_LOW`.
- `signer_status.code` is `ERR_SIGNATURE_TIMEOUT`.
- refusal volume or a specific `reason_code` spikes unexpectedly.

## Logs And Receipts

Default log paths:

```text
C:\ProgramData\MNDe\logs\runtime.log
C:\ProgramData\MNDe\logs\install.log
C:\ProgramData\MNDe\logs\verification.log
```

Default receipt paths:

```text
C:\ProgramData\MNDe\receipts\receipts.jsonl
C:\ProgramData\MNDe\receipts\archive
```

Launch requirements:

- Confirm the service account can create, append, rotate, and read these paths.
- Confirm log rotation with `logging.max_bytes` and `logging.max_files`.
- Confirm receipt rotation with `receipts.rotation_mode`, `receipts.max_bytes`, and `receipts.max_count`.
- Back up receipt archives before deleting or moving old files.
- Treat `ERR_RECEIPT_WRITE_FAILED` and `ERR_RECEIPT_ARCHIVE_FAILED` as critical because audit integrity may be unsafe.

## Key, Policy, And Signer Handling

Launch requirements:

- Keep policy signing keys out of the release package.
- Keep customer signer credentials outside the repo and release artifact.
- Pin or record the active policy hash for every launch.
- Verify policy schema and signature before start.
- Treat `ERR_POLICY_REJECTED`, `ERR_INVALID_POLICY_SCHEMA`, and `ERR_POLICY_SIGNATURE_MISMATCH` as no-go conditions.
- Treat `ERR_SIGNATURE_TIMEOUT` as not-ready until signer reachability and latency are restored.

## Fail-Closed Behavior

Expected fail-closed states:

- Invalid release manifest: refuse startup or report not-ready.
- Invalid config: refuse startup or report not-ready.
- Invalid policy: refuse startup or report not-ready.
- Missing signer or signer timeout: report not-ready.
- Low disk or unsafe receipt store: report not-ready.
- Invalid request signature, body hash mismatch, timestamp skew, or nonce replay: return `REFUSE`.
- Runtime errors: return `REFUSE` with a typed `reason_code`.

Operators must not bypass these checks for launch. Fix the underlying cause and rerun verification.

## Upgrade And Rollback

Before upgrade:

- Run the current release verifier and save the result.
- Back up `C:\ProgramData\MNDe\config`, `C:\ProgramData\MNDe\policy`, and `C:\ProgramData\MNDe\receipts`.
- Save the current release package, signed manifest, and published SHA256.
- Confirm the new version has a new signed manifest and provenance file.

Upgrade:

- Stop with `stop.cmd`.
- Verify the new release.
- Install or replace the service.
- Start with `start.cmd`.
- Confirm `/healthz`, `/readyz`, `/metrics`, and one known `POST /v1/decisions` request.

Rollback:

- Stop with `stop.cmd`.
- Restore the previous release package and manifest.
- Restore config and policy only if the upgrade changed them.
- Start with `start.cmd`.
- Confirm status and one known decision request.

## Pre-Launch Proof Commands

Run from the release root:

```powershell
.\bin\verify-release.cmd
.\status.cmd
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/readyz
Invoke-RestMethod http://127.0.0.1:8787/metrics
```

Run at least one known allow and one known refuse request through `POST /v1/decisions`.

## Evidence To Save

For every launch or customer pilot, save:

- Release version, manifest hash, and provenance.
- Output from release verification.
- Output from `status.cmd`.
- `/healthz`, `/readyz`, and `/metrics` snapshots.
- The active policy file or policy hash.
- One allow receipt and one refuse receipt.
- Operator name, launch time, rollback package location, and known risks.
