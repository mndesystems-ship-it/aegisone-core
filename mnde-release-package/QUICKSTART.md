# MNDe Quickstart

## 1. Verify

```powershell
.\bin\verify-release.cmd
```

## 2. Start

```powershell
.\bin\mnde-sidecar.cmd
```

This creates local signed fixtures under `sidecar-local` if they do not exist and starts the sidecar on `127.0.0.1:8787`.

## 3. Health

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/readyz
```

## 4. Allow Example

```powershell
.\bin\mnde-example-client.cmd --raw
```

Expected decision:

```json
{
  "decision": "ALLOW",
  "reason_code": "OK_ALLOW"
}
```

## 5. Refuse Example

```powershell
.\bin\mnde-example-client.cmd --refuse --raw
```

Expected decision:

```json
{
  "decision": "REFUSE",
  "reason_code": "ERR_GPU_LIMIT"
}
```

## 6. Verify Receipt

```powershell
$line = Get-Content .\sidecar-local\receipts.jsonl | Select-Object -Last 1
Set-Content -Path .\sidecar-local\last-receipt.json -Value $line
.\bin\verify-receipt.cmd --receipt .\sidecar-local\last-receipt.json
```

