# MNDe Adoption Package

## Phase 1. Integration Examples

### 1. API Gateway Pattern

Where MNDe sits:

```text
Client -> API Gateway -> MNDe Sidecar -> Internal Service
```

Before flow:

```text
Client sends request to API Gateway.
API Gateway authenticates request.
API Gateway forwards request directly to internal service.
Internal service performs action.
```

After flow:

```text
Client sends request to API Gateway.
API Gateway authenticates request.
API Gateway transforms request into MNDe execution_request.
API Gateway signs MNDe request.
API Gateway calls POST /v1/decisions.
If ALLOW, API Gateway forwards original request to internal service.
If REFUSE, API Gateway returns blocked response and stores receipt.
```

Exact request transformation:

```json
{
  "original": {
    "path": "/v1/gpu/jobs",
    "method": "POST",
    "user_id": "svc-training",
    "body": {
      "gpu_type": "a10g",
      "gpu_count": 2,
      "hours": 4,
      "retry_on_fail": false
    }
  },
  "mnde": {
    "execution_request": {
      "request_id": "gw-job-1001",
      "submitted_region": "us-west-2",
      "actor": { "user_id": "svc-training" },
      "resources": { "gpu_type": "a10g", "gpu_count": 2, "hours": 4 },
      "execution": {
        "auto_scale": false,
        "max_scale_multiplier": 1,
        "retry_on_fail": false,
        "max_retries": 0
      },
      "tool_calls": [{ "tool": "create-gpu-job", "priority": 1 }],
      "orbit_intent": {
        "orbit_version": "2.0",
        "action": "execute",
        "boundary": "api-gateway-gpu-jobs",
        "payload": { "tool_calls": [{ "tool": "create-gpu-job", "priority": 1 }] },
        "lifecycle_state": "ARMED",
        "signatures": [{ "alg": "ed25519.v1", "sig": "gateway-action-signature" }]
      },
      "release_request": {
        "execution_id": "exec-gw-job-1001",
        "hold_state": "APPROVED",
        "already_consumed": false
      },
      "runtime_observation": {
        "kill_switch_active": false,
        "actual_gpu_count": 2,
        "actual_hours": 4,
        "actual_total_cost_cents": 4000
      }
    },
    "pricing_data": { "gpu_hour_cents": 500 }
  }
}
```

Exact API call:

```powershell
.\bin\mnde-example-client.cmd --raw
```

Equivalent endpoint:

```http
POST http://127.0.0.1:8787/v1/decisions
X-MNDE-Key-Id: local-client-1
X-MNDE-Timestamp: 2026-04-19T07:53:05.469Z
X-MNDE-Nonce: 705eaae5c2ce76c03d01131e6b99da8b
X-MNDE-Body-SHA256: bfac098fc026ea4c1c8c74f5b866f2fa03a6e3b1748d9205d66e85241eed90ec
X-MNDE-Signature-Alg: ed25519.v1
X-MNDE-Signature: 9b91089b4c1ea56979c8418b57ab98bedaaff9597969c02016d36175092c7a7a0d30e7393eda889374e26e775e8daec41ac69da51908e38c05855c3b370adc0d
```

### 2. Agent Runtime Pattern

Where MNDe sits:

```text
Agent Planner -> MNDe Sidecar -> Tool Executor
```

Before flow:

```text
Agent plans a tool call.
Agent runtime calls the tool executor.
Tool executor provisions resources or performs action.
Failures, retries, or excessive resources are handled after execution starts.
```

After flow:

```text
Agent plans a tool call.
Agent runtime converts proposed action to MNDe execution_request.
Agent runtime signs request and calls POST /v1/decisions.
If ALLOW, tool executor runs.
If REFUSE, tool executor is never called and the receipt is stored in agent memory.
```

How refusal stops execution:

```js
const decision = await mnde.decide(actionRequest);

if (decision.decision !== "ALLOW") {
  await agentMemory.write({
    type: "mnde_refusal",
    reason_code: decision.reason_code,
    request_hash: decision.request_hash,
    prevented_cost_usd: decision.prevented_cost_usd,
    receipt: decision.receipt
  });
  return { status: "blocked", reason_code: decision.reason_code };
}

return await toolExecutor.run(proposedToolCall);
```

Exact API call example:

```powershell
.\bin\mnde-example-client.cmd --refuse --raw
```

Verified refusal shape:

```json
{
  "decision": "REFUSE",
  "reason_code": "ERR_GPU_LIMIT",
  "request_hash": "810d17dfae616b5dfb940fc545324768d0c8744a68c9423cd1785e771594a6bf",
  "decision_hash": "a82b78c206af24dfc69d04cc3429f9ae5f8bdb82173bef4437842dbbefd44312",
  "prevented_cost_usd": "1880.00"
}
```

### 3. Batch Or Job System Pattern

Where MNDe sits:

```text
Job Submitter -> MNDe Sidecar -> Queue/Scheduler -> Worker
```

Before flow:

```text
User submits job.
Scheduler accepts job.
Worker starts job.
Cost, retries, resource limits, and release approval are enforced by scheduler settings or manual review.
```

After flow:

```text
User submits job.
Submitter converts job spec to MNDe execution_request.
Submitter calls POST /v1/decisions.
If ALLOW, submitter enqueues job with decision_hash.
Worker verifies job contains approved execution_id and decision_hash.
If REFUSE, job is not enqueued.
```

How jobs are pre-authorized:

```json
{
  "job_id": "batch-2026-04-19-001",
  "execution_id": "exec-example-allow-1776585185469",
  "decision_hash": "d997a8b9aa596ecdd562c76609a0c206db0c14779d011ba5fe0c568c2b5137e4",
  "mnde_decision": "ALLOW"
}
```

How release is enforced:

```text
Scheduler accepts only jobs with decision == ALLOW.
Worker starts only jobs with the same execution_id approved by MNDe.
Duplicate execution_id is refused by MNDe replay controls.
Policy version is pinned by MNDE_PINNED_POLICY_VERSION.
```

Exact API call:

```powershell
.\bin\mnde-example-client.cmd --raw
```

Verified allow shape:

```json
{
  "decision": "ALLOW",
  "reason_code": "OK_ALLOW",
  "request_hash": "7edc05c664b9caeb2eaa7c9979aba7b954c6fa34400df45bde91192bd1cd6757",
  "decision_hash": "d997a8b9aa596ecdd562c76609a0c206db0c14779d011ba5fe0c568c2b5137e4"
}
```

## Phase 2. Minimal Sales Package

### One Page Explanation

MNDe Execution Control Sidecar is a local HTTP service that allows or refuses execution requests before they run. It protects systems that launch jobs, call tools, allocate GPUs, retry workloads, or release controlled actions. The customer sends a signed request to MNDe, receives `ALLOW` or `REFUSE`, and stores a signed receipt. Determinism matters because the same input produces the same decision and replayable proof. That makes the control enforceable, auditable, and suitable for regulated or cost-sensitive environments. MNDe does not replace the application. It sits before execution and gives the application a verifiable decision gate.

### Proof Summary

The verified package contains 117 manifest-tracked artifacts and passes release verification with zero mismatches. Audit proof records show `total_runs: 1012080`, `determinism_mismatch_rate: 0`, `parity_mismatch_rate: 0`, `replay_drift_rate: 0`, and `rejection_accuracy: 100`. Receipt verification is live: the verified refusal receipt returned `legacy_signature_valid: true` and `public_signature_valid: true`. The sidecar returned valid ALLOW and REFUSE decisions over signed HTTP requests. The verified refusal was `ERR_GPU_LIMIT` with `prevented_cost_usd: "1880.00"`.

### Use Cases

GPU cost control: MNDe blocks jobs that exceed pinned GPU, hour, retry, or total-cost policy before cloud resources are created.

Retry storm prevention: MNDe refuses execution requests that exceed the configured retry count or replay a previously consumed execution id.

Policy enforcement: MNDe loads a signed policy at startup, pins the policy version, refuses mismatches, and exits fail-closed if policy trust is invalid.

## Phase 3. First Customer Target

Exact type of company:

```text
Mid-market AI infrastructure company running customer training and inference jobs on rented GPUs.
```

Exact system they run:

```text
Internal job submission API that accepts GPU job specs and enqueues work into a batch scheduler.
```

Exact failure MNDe stops:

```text
A submitted job asks for 99 A10G GPUs for 4 hours while production policy allows 4 GPUs. MNDe refuses before the job enters the queue.
```

Minimum deployment:

```text
Install MNDe sidecar on the same Windows server or VM that runs the job submission API.
Bind to 127.0.0.1:8787.
Route only GPU job creation requests through MNDe.
Block requests where decision != ALLOW.
Store receipts beside the job-submission audit log.
```

Small scope:

```text
Only protect POST /gpu/jobs.
Only enforce max_gpu_count, max_hours, max_retry_count, max_total_cost_cents, and policy version.
Do not gate user login, read APIs, dashboards, or existing running jobs.
```

## Phase 4. Pricing Model

Pricing unit:

```text
Verified decision
```

What is billed:

```text
Every POST /v1/decisions response with a non-null request_hash.
```

Exact structure:

```text
$0.002 per verified decision.
$500 monthly minimum per production environment.
One production environment is one deployed MNDe policy boundary.
Receipt verification, health checks, readiness checks, and metrics are not billed.
```

Why it aligns with value:

```text
The customer pays only when MNDe evaluates an execution decision. The unit matches the protected action: job, agent tool call, transaction, or release request.
```

## Phase 5. First Outreach Asset

### Cold Message

Subject: Stop runaway GPU jobs before they start

Hi,

MNDe is a local sidecar that sits before GPU job execution and returns `ALLOW` or `REFUSE` with a signed receipt. In the verified package, audit proof shows 1,012,080 runs, zero determinism mismatch, zero replay drift, and 100 rejection accuracy. A live refusal blocked a 99-GPU request against a 4-GPU policy and recorded `$1880.00` prevented cost.

If you run customer-submitted GPU jobs, I can show a 5 minute local demo: start sidecar, send safe job, send runaway job, verify receipt.

### Technical Message

MNDe integrates as a localhost HTTP decision gate:

```text
POST /v1/decisions -> ALLOW or REFUSE + signed receipt
```

It verifies Ed25519 request signatures, rejects timestamp skew and nonce replay, loads a signed pinned policy, and fails closed on manifest, policy, auth, runtime, or receipt persistence errors. The release contains 117 manifest-tracked artifacts and `verify-release.cmd` passes with zero mismatches. The sidecar runs on Windows with bundled Node; no external Node install is required.

Integration point: call MNDe before enqueuing GPU jobs or executing agent tools. Execute only when `decision == "ALLOW"`.

### Short Demo Script

```powershell
.\bin\verify-release.cmd
.\bin\mnde-sidecar-background.cmd
Invoke-RestMethod http://127.0.0.1:8787/healthz
.\bin\mnde-example-client.cmd --raw
.\bin\mnde-example-client.cmd --refuse --raw
$line = Get-Content .\sidecar-local\receipts.jsonl | Select-Object -Last 1
Set-Content .\sidecar-local\last-receipt.json $line
.\bin\verify-receipt.cmd --receipt .\sidecar-local\last-receipt.json
```

## Phase 6. Demo Flow

5 minute live demo:

1. Verify package integrity.

```powershell
.\bin\verify-release.cmd
```

Expected:

```json
{
  "ok": true,
  "checked_files": 117,
  "mismatches": []
}
```

2. Start service.

```powershell
.\bin\mnde-sidecar-background.cmd
```

Expected:

```text
MNDe sidecar started: pid=<pid> bind=127.0.0.1:8787
```

3. Check health.

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/readyz
```

Expected:

```json
{
  "startup_state": "READY",
  "active_policy_version": "policy.v1"
}
```

4. Send safe request.

```powershell
.\bin\mnde-example-client.cmd --raw
```

Expected:

```json
{
  "decision": "ALLOW",
  "reason_code": "OK_ALLOW"
}
```

5. Send runaway request.

```powershell
.\bin\mnde-example-client.cmd --refuse --raw
```

Expected:

```json
{
  "decision": "REFUSE",
  "reason_code": "ERR_GPU_LIMIT",
  "prevented_cost_usd": "1880.00"
}
```

6. Verify receipt.

```powershell
$line = Get-Content .\sidecar-local\receipts.jsonl | Select-Object -Last 1
Set-Content .\sidecar-local\last-receipt.json $line
.\bin\verify-receipt.cmd --receipt .\sidecar-local\last-receipt.json
```

Expected:

```json
{
  "legacy_signature_valid": true,
  "public_signature_valid": true
}
```

