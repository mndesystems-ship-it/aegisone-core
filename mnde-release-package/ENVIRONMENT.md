# MNDe Environment Specification

Required variables for production sidecar operation:

```powershell
$env:MNDE_BIND_ADDR = "127.0.0.1:8787"
$env:MNDE_POLICY_FILE = "C:\ProgramData\MNDe\policy.v1.signed.json"
$env:MNDE_CLIENT_KEYS = "C:\ProgramData\MNDe\client_keys.json"
$env:MNDE_RECEIPT_LOG = "C:\ProgramData\MNDe\receipts\receipts.jsonl"
$env:MNDE_PINNED_POLICY_VERSION = "policy.v1"
```

Optional variables:

```powershell
$env:MNDE_SIDECAR_LOG = "C:\ProgramData\MNDe\logs\sidecar.jsonl"
$env:MNDE_LOG_MAX_BYTES = "10485760"
$env:MNDE_CLIENT_PRIVATE_KEY = "C:\ProgramData\MNDe\client_ed25519_private.pem"
$env:MNDE_CLIENT_KEY_ID = "local-client-1"
$env:MNDE_URL = "http://127.0.0.1:8787/v1/decisions"
```

Valid `MNDE_CLIENT_KEYS` format:

```json
{
  "keys": [
    {
      "key_id": "local-client-1",
      "public_key": "1b91f48684958e0d2e2874dcf4a1d9c32e14f5de20b7b7a8e862974c9f0b5ced",
      "status": "active"
    }
  ]
}
```

Valid policy file:

```json
{
  "schema_version": "ecs.policy.v1",
  "policy_version": "policy.v1",
  "rules": {
    "max_total_cost_cents": 10000,
    "allow_auto_scale": false,
    "max_gpu_count": 4,
    "max_hours": 8,
    "require_manual_approval_above_cents": 5000,
    "max_retry_count": 1
  },
  "trust": {
    "key_version": "ed25519.v1",
    "key_id": "85535d7b96bdd743",
    "public_key": "55ddc014f25e30d393b6ef3057c5df5f8394cb1c466d4c1e9d9ef1e00d4e53f5",
    "signature": "91d19e35fe5158b0154bc8516946ad1111d8abb49002b5048e1af12cac6367b8906bfe6e21c54fb731fc19a080e4a52ddd48e5bb887ac6eed99a938e92ed6a0d"
  }
}
```
