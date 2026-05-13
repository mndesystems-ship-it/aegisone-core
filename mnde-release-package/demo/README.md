# MNDe Browser Demo

This demo treats MNDe as a black-box HTTP service.

Architecture:

```text
Browser -> Demo backend on port 3000 -> MNDe sidecar on port 8787
```

The browser never talks directly to MNDe. The backend signs each MNDe request with Ed25519 using the local client private key.

## Run

Start MNDe:

```powershell
.\bin\mnde-sidecar-background.cmd
```

Start the demo backend:

```powershell
.\bin\node\node.exe .\demo\server.mjs
```

Open:

```text
http://127.0.0.1:3000
```

## Expected Safe Case

Input:

```text
gpu_count = 2
hours = 4
gpu_hour_price = 5.00
retry_on_fail = false
auto_scale = false
kill_switch_active = false
```

Expected:

```json
{
  "decision": "ALLOW",
  "reason_code": "OK_ALLOW",
  "total_cost_usd": "40.00",
  "prevented_cost_usd": "0.00"
}
```

## Playable Refusal Cases

The signed demo policy is fixed at 4 GPUs, 8 hours, $100 max cost, max retries 1, and autoscale disabled.

GPU limit:

Input:

```text
gpu_count = 99
hours = 4
```

Expected:

```json
{
  "decision": "REFUSE",
  "reason_code": "ERR_GPU_LIMIT",
  "total_cost_usd": "1980.00",
  "allowed_cost_usd": "100.00",
  "prevented_cost_usd": "1880.00"
}
```

Cost limit:

```json
{
  "gpu_count": 4,
  "hours": 6,
  "gpu_hour_cents": 500,
  "decision": "REFUSE",
  "reason_code": "ERR_COST_LIMIT",
  "total_cost_usd": "120.00",
  "prevented_cost_usd": "20.00"
}
```

Retry storm:

```json
{
  "gpu_count": 2,
  "hours": 4,
  "retry_on_fail": true,
  "max_retries": 3,
  "decision": "REFUSE",
  "reason_code": "ERR_RETRY_LIMIT",
  "total_cost_usd": "160.00",
  "prevented_cost_usd": "60.00"
}
```

Autoscale denied:

```json
{
  "gpu_count": 2,
  "hours": 4,
  "auto_scale": true,
  "max_scale_multiplier": 2,
  "decision": "REFUSE",
  "reason_code": "ERR_AUTO_SCALE_DENIED",
  "total_cost_usd": "80.00",
  "prevented_cost_usd": "0.00"
}
```

Failed autoscale runtime update:

```json
{
  "gpu_count": 2,
  "hours": 4,
  "observed_gpu_count": 6,
  "decision": "REFUSE",
  "reason_code": "ERR_RUNTIME_GPU_DRIFT",
  "total_cost_usd": "40.00",
  "prevented_cost_usd": "0.00"
}
```

Kill switch:

```json
{
  "gpu_count": 2,
  "hours": 4,
  "kill_switch_active": true,
  "decision": "REFUSE",
  "reason_code": "ERR_KILL_SWITCH",
  "total_cost_usd": "40.00",
  "prevented_cost_usd": "0.00"
}
```
