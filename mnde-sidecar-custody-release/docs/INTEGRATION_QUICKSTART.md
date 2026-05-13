# Integration Quickstart

Create a customer custody signer config outside the release tree:

```json
{
  "key_set_version": "ksv_2026_01",
  "signers": [
    {
      "id": "customer-prod-signer-1",
      "mode": "external_http",
      "endpoint": "https://signer.customer.example/v1/sign",
      "public_key": "64 lowercase hex characters",
      "timeout_ms": 20,
      "latency_target_ms": 5,
      "latency_slo_ms": 15,
      "enabled": true
    }
  ],
  "threshold": 1
}
```

Start:

```powershell
.\bin\mnde-sidecar-custody.cmd --runtime-dir C:\mnde-runtime --signer-config C:\mnde-runtime\custody.signers.json
```

Call POST /v1/decisions before executing a job or tool call. Continue only when decision is ALLOW.
Receipts are written to the external runtime directory and verified with:

```powershell
.\bin\verify-custody-receipt.cmd --config C:\mnde-runtime\custody.signers.json --receipt C:\path\to\receipt.json
```
