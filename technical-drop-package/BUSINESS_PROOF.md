# Business Proof

## Runaway Autoscale

Execution request: 8 GPUs for 20 hours with autoscale enabled and a scale multiplier of 20.

Why it would have run without this system: the request is structurally valid and carries an approved release state, so a weak gate could have treated it as a normal batch job.

Why it was refused: ARM computed the projected exposure and returned `ERR_COST_LIMIT`.

Prevented cost: `11000.00` USD

Reason code: `ERR_COST_LIMIT`

## Excessive GPU Allocation

Execution request: 64 H100 GPUs for 24 hours.

Why it would have run without this system: the request is otherwise well-formed and signed, and a scheduler without policy enforcement could try to place it.

Why it was refused: ARM enforced the GPU ceiling and returned `ERR_GPU_LIMIT`.

Prevented cost: `2680.00` USD

Reason code: `ERR_GPU_LIMIT`

## Retry Amplification

Execution request: 8 GPUs for 20 hours with 12 retries enabled.

Why it would have run without this system: retry configuration is often treated as operational metadata, even though it multiplies total spend.

Why it was refused: ARM enforced the retry ceiling and returned `ERR_RETRY_LIMIT`.

Prevented cost: `5400.00` USD

Reason code: `ERR_RETRY_LIMIT`
