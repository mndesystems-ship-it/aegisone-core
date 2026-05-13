# Step 1. Discover

## Entry points

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`

- `main`: Starts the preflight CLI process and delegates to `run`.
- `run`: Dispatches `version`, `analyze`, `store append`, `replay`, `proof-bundle`, `mnde-proof`, and `gen-key` commands.

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`

- `buildMNDeProofBundle`: Builds the MNDe decision, receipt, replay, and manifest proof bundle from one input file.

`C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\cli.ts`

- `runCli`: Reads raw input, rejects malformed JSON deterministically, and emits the Orbit validation result.

## Validation logic

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`

- `parseWorkflow`: Parses one workflow document, rejects aliases and duplicate keys, and hands off to strict schema validation.
- `validateWorkflowRoot`: Enforces the allowed top-level workflow keys and materializes the normalized workflow object.
- `validateJobs`: Enforces that `jobs` is a non-empty mapping of valid job definitions.
- `validateJob`: Rejects unsupported dynamic workflow features and validates each job’s static execution fields.
- `validateSteps`: Enforces that steps are a sequence of valid step mappings.
- `validateStep`: Rejects unknown step keys and enforces `run` or `uses` presence.
- `parsePricing`: Parses pricing JSON with duplicate-key rejection, integer-only values, and strict allowed fields.
- `parseStrictJSON`: Parses one JSON value with deterministic integer decoding and trailing-token rejection.
- `readJSONValue`: Recursively decodes strict JSON while rejecting duplicate object keys.
- `evaluate`: Refuses workflows whose `runs-on` SKUs are not present in the pricing map.

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`

- `parseMNDeIncidentInput`: Parses the MNDe request/policy incident input and rejects unknown fields.
- `parseMNDeRequest`: Validates the top-level request shape and required nested objects.
- `parseMNDeResources`: Validates `gpu_type`, `gpu_count`, and `hours`.
- `parseMNDePricing`: Validates integer GPU hourly pricing.
- `parseMNDeExecution`: Validates autoscale and retry execution knobs.
- `parseMNDePolicy`: Validates the cost and execution guardrails policy object.
- `parseMNDeStrictJSON`: Parses one MNDe JSON value with duplicate-key rejection and integer-only decoding.
- `readMNDeJSONValue`: Recursively decodes strict JSON for the MNDe incident format.

`C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\parse.ts`

- `parseJsonWithDuplicateKeyRejection`: Parses raw JSON while refusing duplicate keys before object normalization.

`C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\validate.ts`

- `validateIntent`: Enforces the Orbit 2.0 schema, top-level key allowlist, lifecycle requirements, and signature record shape.
- `buildDecisionResult`: Locks one structured output envelope for every Orbit pass/fail result.
- `buildPassResult`: Builds the authorized validation output.
- `buildFailResult`: Builds the fail-closed validation output.
- `buildFailDecisionHash`: Produces a deterministic fail hash when canonical request bytes are unavailable.
- `getDeterminismContract`: Exposes the pinned canonicalization, hashing, and validation order contract.

## Policy handling

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`

- `parseMNDePolicy`: Validates policy field presence, type, and integer bounds.
- `decideMNDeIncident`: Applies policy limits to requested cost, autoscale, retries, GPU count, and hours.

## Signature or hashing logic

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`

- `createSignedReceipt`: Wraps a receipt with Ed25519 metadata and signature when a key is supplied.
- `computeRequestHash`: Hashes the canonical input snapshot into `request_hash`.
- `computeDecisionHash`: Hashes the canonical decision payload into `decision_hash`.
- `verifySignature`: Verifies signed receipt integrity against the embedded public key and key metadata.
- `loadSigningKey`: Loads a raw Ed25519 private key from disk.
- `keyIDFromPublicKey`: Derives a stable key id from the public key bytes.
- `hashBytes`: Produces a SHA-256 hex digest.
- `canonicalJSON`: Canonicalizes JSON via Go’s deterministic struct/map marshaling in this code path.

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`

- `signMNDeReceipt`: Signs the MNDe receipt with Ed25519 and fills key metadata.
- `verifyMNDESignature`: Verifies MNDe receipt signatures against the embedded public key and key id.
- `mustCanonicalJSON`: Panics on canonical serialization failure so downstream hashes stay deterministic.

`C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\canonicalize.ts`

- `canonicalizeRfc8785Json`: Canonicalizes JSON using sorted keys and RFC8785-compatible number/string serialization.

`C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\validate.ts`

- `hashCanonicalArtifact`: Hashes a canonical Orbit artifact.

## Release or gating logic

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`

- `decide`: Refuses preflight analysis when workflow/pricing parse or SKU evaluation fails.
- `evaluate`: Gates workflow execution on a strict pricing SKU allowlist.

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`

- `decideMNDeIncident`: Gates execution on projected cost, autoscale allowance, GPU count, hours, and retry amplification.

`C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\validate.ts`

- `validateIntent`: Refuses any Orbit intent whose lifecycle state is not `ARMED`.

## Runtime checks or kill switches

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`

- `replayStore`: Recomputes request and decision hashes from stored receipts and emits drift/replay reports.
- `compareReceipt`: Detects request hash, decision, refusal code, decision hash, and signature drift in stored receipts.

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`

- `replayMNDeStore`: Recomputes MNDe decisions from stored receipts and emits drift/replay reports.
- `compareMNDeReceipt`: Detects request hash, decision, reasons, costs, decision hash, schema, and signature drift.

## Receipt or logging systems

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`

- `appendReceiptCommand`: Appends canonical signed receipts to an append-only JSONL receipt store.
- `buildProofBundle`: Writes a sample receipt, receipt store, drift report, replay report, manifest, and copied adversarial report.
- `parseSignedReceipt`: Strictly decodes a signed receipt payload.
- `splitReceiptLines`: Splits non-empty receipt JSONL lines for replay.

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`

- `appendMNDESignedReceipt`: Appends canonical MNDe signed receipts to an append-only JSONL store.
- `buildMNDeProofBundle`: Writes decision, receipt, receipt store, drift report, replay report, and manifest files.
- `parseMNDESignedReceipt`: Strictly decodes a stored MNDe signed receipt.

## Orphaned but retained components

`C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\adversarial.ts`

- `main`: Runs adversarial drift, malformed input, ext, and fail-closed CLI probes for audit evidence.

`C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\selftest.ts`

- `readVector`: Loads Orbit fixture vectors for self-test execution.

`C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`

- `generateKeyFile`: Generates a raw Ed25519 private key file for signing; useful operationally but not a control layer.

# Step 2. Map to layers

## Intake and Preflight

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `parseWorkflow`
  responsibility: Parse one workflow document and reject aliases, duplicates, and multi-document YAML.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `validateWorkflowRoot`
  responsibility: Enforce the allowed top-level workflow schema and normalize the root object.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `validateJobs`
  responsibility: Validate that the workflow jobs map is present, non-empty, and statically structured.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `validateJob`
  responsibility: Reject dynamic job features and validate `runs-on`, `timeout-minutes`, and steps.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `validateSteps`
  responsibility: Validate the sequence of steps for each job.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `validateStep`
  responsibility: Reject unknown step keys and require a static `run` or `uses` action.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `parsePricing`
  responsibility: Parse pricing JSON with integer-only decoding and an explicit allowed-field set.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`
  function: `parseMNDeIncidentInput`
  responsibility: Parse the top-level MNDe request and policy envelope with strict unknown-field rejection.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`
  function: `parseMNDeRequest`
  responsibility: Validate the structured MNDe request payload.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`
  function: `parseMNDeResources`
  responsibility: Validate resource counts and hours as positive integers.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`
  function: `parseMNDePricing`
  responsibility: Validate deterministic pricing input for the request.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`
  function: `parseMNDeExecution`
  responsibility: Validate autoscale and retry execution controls before policy evaluation.

## Deterministic Validation (Orbit)

- file: `C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\parse.ts`
  function: `parseJsonWithDuplicateKeyRejection`
  responsibility: Parse raw JSON deterministically and reject duplicate keys before normalization.

- file: `C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\validate.ts`
  function: `validateIntent`
  responsibility: Validate the Orbit 2.0 request shape, lifecycle, and signature record schema.

- file: `C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\validate.ts`
  function: `buildDecisionResult`
  responsibility: Emit one deterministic output shape for every Orbit validation result.

- file: `C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\validate.ts`
  function: `buildFailDecisionHash`
  responsibility: Produce a deterministic fail hash when parse-boundary validation cannot trust canonical request bytes.

- file: `C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\canonicalize.ts`
  function: `canonicalizeRfc8785Json`
  responsibility: Canonicalize Orbit artifacts into a stable hashable byte representation.

## Policy Trust

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`
  function: `parseMNDePolicy`
  responsibility: Validate the policy object fields and integer bounds before policy application.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `verifySignature`
  responsibility: Verify signed receipt integrity using embedded Ed25519 metadata.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`
  function: `verifyMNDESignature`
  responsibility: Verify MNDe signed receipt integrity using embedded Ed25519 metadata.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `keyIDFromPublicKey`
  responsibility: Derive a stable key id from the public key bytes.

## Release Control (ARM)

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `evaluate`
  responsibility: Gate workflow execution on a strict pricing SKU allowlist.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `decide`
  responsibility: Refuse the preflight request when strict parsing or SKU gating fails.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`
  function: `decideMNDeIncident`
  responsibility: Compute projected exposure and refuse requests that violate cost or execution policy.

- file: `C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\validate.ts`
  function: `validateIntent`
  responsibility: Refuse any request whose lifecycle is not `ARMED`, which is the closest existing release-state gate.

## Runtime Refusal (RAM0NA)

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `replayStore`
  responsibility: Re-run stored decisions and emit drift reports for receipt replay.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `compareReceipt`
  responsibility: Detect request hash, decision, refusal code, decision hash, and signature drift.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`
  function: `replayMNDeStore`
  responsibility: Re-run stored MNDe decisions and emit drift reports for receipt replay.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`
  function: `compareMNDeReceipt`
  responsibility: Detect runtime drift across request hash, reasons, costs, decision hash, schema, and signature.

## orphan

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `appendReceiptCommand`
  responsibility: Append signed receipts to the JSONL store without being part of a single control layer.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\main.go`
  function: `buildProofBundle`
  responsibility: Assemble audit proof artifacts across multiple concerns.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`
  function: `appendMNDESignedReceipt`
  responsibility: Append MNDe signed receipts to the JSONL store without fitting a control layer.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`
  function: `buildMNDeProofBundle`
  responsibility: Assemble MNDe proof artifacts across multiple concerns.

- file: `C:\Users\Shadow\Desktop\mnde-preflight\preflight\mnde_proof.go`
  function: `generateKeyFile`
  responsibility: Generate signing material for operations rather than for one isolated layer.

- file: `C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\cli.ts`
  function: `runCli`
  responsibility: Provide a CLI boundary around Orbit validation rather than a reusable layer primitive.

- file: `C:\Users\Shadow\Desktop\orbit-v2\packages\orbit-core\src\adversarial.ts`
  function: `main`
  responsibility: Produce adversarial audit evidence rather than participate in execution control.
