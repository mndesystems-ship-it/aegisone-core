# MNDe Operator Runbook

For launch readiness, use `OPERATIONS_LAUNCH_CHECKLIST.md` first. This runbook is the day-two incident and maintenance companion.

## Basic Commands
Install from an elevated prompt: `install.cmd`
Start: `start.cmd`
Stop: `stop.cmd`
Restart: `restart.cmd`
Status JSON: `status.cmd`
Uninstall, preserving config and receipts: `uninstall.cmd`

## Service Not Starting
Run `status.cmd`. If `installed` is false, run an elevated `install.cmd`. If `running` is false, run `start.cmd` and inspect `C:\ProgramData\MNDe\logs\runtime.log`.

Expected codes: `ERR_INSTALL_PERMISSION_DENIED`, `ERR_SERVICE_START_FAILED`, `ERR_HEALTH_TIMEOUT`, `ERR_PORT_BIND_FAILED`, `ERR_FORBIDDEN_ARTIFACT_PRESENT`.

## Check Config
Config path: `C:\ProgramData\MNDe\config\custody.config.json`.

`ERR_INVALID_CONFIG` means a required field is missing, an unknown field exists while `strict` is true, or a value has the wrong type. Fix the reported `field`, then run `start.cmd`. MNDe validates config before opening a port.

## Check Logs
Runtime log: `C:\ProgramData\MNDe\logs\runtime.log`
Install log: `C:\ProgramData\MNDe\logs\install.log`
Verification log: `C:\ProgramData\MNDe\logs\verification.log`

Logs rotate by `logging.max_bytes` and `logging.max_files`. `ERR_LOG_PATH_UNAVAILABLE` means the log directory cannot be created or written. If `logging.required_for_audit_integrity` is true, startup fails closed; otherwise status shows a warning/degraded state.

## Policy Rejected
Check status and runtime logs for `ERR_POLICY_REJECTED`, `ERR_INVALID_POLICY_SCHEMA`, or `ERR_POLICY_SIGNATURE_MISMATCH`. Verify the policy schema, policy hash, and customer public key material. Do not bypass policy validation.

## Signature Timeout
`ERR_SIGNATURE_TIMEOUT` means the external signer path exceeded `signer.timeout_ms`. Check signer network reachability, tenant signer config, and signer service logs. MNDe reports `ready: false` while signer status is unsafe.

## Disk Full
Health reports `disk_status.code: ERR_DISK_LOW` when free space falls below `disk.min_free_bytes`. MNDe keeps status endpoints available and refuses unsafe execution if receipt integrity cannot be guaranteed. Free disk space under the log and receipt volumes, then restart if needed.

## Receipt Store
Active receipt file: `C:\ProgramData\MNDe\receipts\receipts.jsonl`
Archive path: `C:\ProgramData\MNDe\receipts\archive`

Receipts rotate by `receipts.rotation_mode` using `receipts.max_bytes` or `receipts.max_count`. Rotation moves complete old receipt files to the archive and starts a new active append-only file. `ERR_RECEIPT_ARCHIVE_FAILED` or `ERR_RECEIPT_WRITE_FAILED` is critical because receipt integrity cannot be guaranteed.

## Launch Go/No-Go
Before a pilot or release, confirm:

- `bin\verify-release.cmd` or `verify-custody-release.cmd` returns `PASS`.
- `status.cmd` reports `running: true`, `config_ok: true`, and manifest integrity passing.
- `/healthz`, `/readyz`, and `/metrics` are reachable.
- At least one known allow request and one known refuse request have been tested through `POST /v1/decisions`.
- Runtime logs and receipt archives are writable and backed up.
- A rollback package and prior signed manifest are available.
