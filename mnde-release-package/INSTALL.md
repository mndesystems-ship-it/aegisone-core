# MNDe Sidecar Install

## Prerequisites

- Windows Server 2019 or newer, or Windows 10/11.
- PowerShell 5 or newer.
- No Node.js install is required on Windows because `bin\node\node.exe` is bundled.
- Port `127.0.0.1:8787` must be available.

## Install

Unzip the release package:

```powershell
Expand-Archive .\mnde-release-package-v1.0.0-win32-x64.zip -DestinationPath C:\MNDe
cd C:\MNDe
```

Verify package integrity:

```powershell
.\bin\verify-release.cmd
```

For first local deployment, generate a signed local policy and client key:

```powershell
.\bin\node\node.exe .\app\sidecar\create-local-fixtures.js C:\ProgramData\MNDe
```

Set environment:

```powershell
$env:MNDE_BIND_ADDR = "127.0.0.1:8787"
$env:MNDE_POLICY_FILE = "C:\ProgramData\MNDe\policy.v1.signed.json"
$env:MNDE_CLIENT_KEYS = "C:\ProgramData\MNDe\client_keys.json"
$env:MNDE_RECEIPT_LOG = "C:\ProgramData\MNDe\receipts\receipts.jsonl"
$env:MNDE_SIDECAR_LOG = "C:\ProgramData\MNDe\logs\sidecar.jsonl"
$env:MNDE_PINNED_POLICY_VERSION = "policy.v1"
```

## Run

Foreground:

```powershell
.\bin\mnde-sidecar.cmd
```

Background:

```powershell
.\bin\mnde-sidecar-background.cmd
```

## Health Test

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/readyz
```

## First Request

In a second PowerShell window:

```powershell
$env:MNDE_CLIENT_PRIVATE_KEY = "C:\ProgramData\MNDe\client_ed25519_private.pem"
$env:MNDE_CLIENT_KEY_ID = "local-client-1"
.\bin\mnde-example-client.cmd --raw
```

## First Refusal

```powershell
$env:MNDE_CLIENT_PRIVATE_KEY = "C:\ProgramData\MNDe\client_ed25519_private.pem"
$env:MNDE_CLIENT_KEY_ID = "local-client-1"
.\bin\mnde-example-client.cmd --refuse --raw
```

## Receipt Verification

Copy the last line from `C:\ProgramData\MNDe\receipts\receipts.jsonl` to `C:\ProgramData\MNDe\receipt.json`, then run:

```powershell
.\bin\verify-receipt.cmd --receipt C:\ProgramData\MNDe\receipt.json
```

## Single-node Production Command

```powershell
cd C:\MNDe
$env:MNDE_BIND_ADDR = "127.0.0.1:8787"
$env:MNDE_POLICY_FILE = "C:\ProgramData\MNDe\policy.v1.signed.json"
$env:MNDE_CLIENT_KEYS = "C:\ProgramData\MNDe\client_keys.json"
$env:MNDE_RECEIPT_LOG = "C:\ProgramData\MNDe\receipts\receipts.jsonl"
$env:MNDE_SIDECAR_LOG = "C:\ProgramData\MNDe\logs\sidecar.jsonl"
$env:MNDE_PINNED_POLICY_VERSION = "policy.v1"
.\bin\mnde-sidecar.cmd
```

Receipts are stored at `C:\ProgramData\MNDe\receipts\receipts.jsonl`.
Logs are stored at `C:\ProgramData\MNDe\logs\sidecar.jsonl`.
If policy, manifest, client keys, receipt persistence, or runtime evaluation fails, the service returns `REFUSE` or exits before serving traffic.

