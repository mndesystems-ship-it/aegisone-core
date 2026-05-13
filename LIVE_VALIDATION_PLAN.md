# Live Validation Plan

## Validation Surface

Agent tool execution

This is the simplest live surface because the system already reasons over tool ordering, retries, runtime observations, and cost exposure.

## One Real Validation Case

Use a real execution request that would otherwise run in an internal automation or agent workflow.

Recommended case:

- a tool sequence that requests GPU-backed execution
- retries enabled above the normal operational ceiling
- a release state that would otherwise allow execution

## Steps

1. Capture the real request as submitted.
Include the exact execution request payload, policy document, and pricing data used for that environment.

2. Run the request through the existing bundle path.
Use `npm run audit` for the fixed proof bundle, and use the same production decision path to evaluate the live request without changing the contract.

3. Record the expected result before execution.
Write down whether the request should be allowed or refused, and which control should trigger first.

4. Compare expected versus actual outcome.
Confirm:
- decision
- request hash
- decision hash
- reason code
- cost fields

5. Record the enforcement result.
If refused, capture the prevented cost or the enforced boundary that blocked execution.

6. Save one concrete validation record.
Store:
- raw request
- canonical request
- receipt
- final decision
- reviewer notes

## What Counts As Success

- the real request is evaluated through the same control path
- the observed decision matches the expected control boundary
- the refusal or allow result is understandable from the receipt and reason code alone
- the reviewer does not need an explanation call to verify what happened
