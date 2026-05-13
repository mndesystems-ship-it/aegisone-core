# Step 8. Output final structure

Created structure:

- `/mnde-core/index.ts`
- `/preflight/index.ts`
- `/preflight/types.ts`
- `/orbit/index.ts`
- `/orbit/types.ts`
- `/policy/index.ts`
- `/policy/types.ts`
- `/arm/index.ts`
- `/arm/types.ts`
- `/ramona/index.ts`
- `/ramona/types.ts`
- `/shared/index.ts`
- `/shared/types.ts`
- `/shared/json.ts`
- `/shared/hash.ts`
- `/shared/errors.ts`
- `/package.json`
- `/tsconfig.json`

Each layer is isolated to its own folder, each folder has an `index` file and a `types` file, and only `shared` is imported across layer boundaries.

# Step 4. Unify interface

## request_object

```ts
type RequestObject = {
  schema_version: "mnde.request.v1";
  request_id: string;
  submitted_region: string;
  actor: { user_id: string };
  resources: { gpu_type: string; gpu_count: number; hours: number };
  pricing: { gpu_hour_usd: number };
  execution: {
    auto_scale: boolean;
    max_scale_multiplier: number;
    retry_on_fail: boolean;
    max_retries: number;
  };
  orbit_intent: OrbitIntent;
  release_request: {
    execution_id: string;
    hold_state: "NONE" | "PENDING" | "APPROVED";
    already_consumed: boolean;
  };
  runtime_request: {
    kill_switch_active: boolean;
    observed_request_hash: string;
    observed_policy_hash: string;
    actual_gpu_count: number;
    actual_hours: number;
    actual_total_cost_usd: number;
  };
};
```

## policy_object

```ts
type PolicyObject = {
  schema_version: "mnde.policy.v1";
  policy_version: string;
  allowed_request_keys: string[];
  rules: {
    max_total_cost_usd: number;
    allow_auto_scale: boolean;
    max_gpu_count: number;
    max_hours: number;
    require_manual_approval_above_usd: number;
  };
  trust: {
    key_version: "ed25519.v1";
    key_id: string;
    signing_public_key: string;
    signature: string;
  };
};
```

## decision_object

```ts
type DecisionObject = {
  schema_version: "mnde.decision.v1";
  decision: "ALLOW" | "REFUSE" | "HOLD";
  reasons: string[];
  request_hash: string;
  policy_hash: string;
  decision_hash: string;
  validation_hash: string;
  projected_total_cost_usd: number;
  allowed_cost_usd: number;
  prevented_cost_usd: number;
  policy_version: string;
  release_hash?: string;
  runtime_hash?: string;
};
```

Contract rules:

- every layer takes one structured input object and returns one structured output object.
- no layer mutates upstream data semantically; only `preflight` fills derived hashes onto the normalized request object.
- every layer fails closed on parse, trust, release, or runtime ambiguity.

# Step 5. Enforce determinism

Validation-layer determinism implemented in `/shared/json.ts` and `/orbit/index.ts`:

- floats removed: strict parser rejects decimal and exponent forms as `invalid_json_number`.
- timestamps removed: no timestamp fields are accepted in the unified request or Orbit validation path.
- randomness removed: Orbit validation is pure and side-effect free.
- network calls removed: no network calls exist in the new validation path.
- canonical hashing enforced: request, policy, release, runtime, and decision hashes are derived from canonical sorted-key JSON.

# Step 6. Policy Trust implementation

Implemented in `/policy/index.ts`:

- policy hash: `policy_hash` is SHA-256 over the canonical policy payload.
- allowed key list: `allowed_request_keys` is deduplicated and enforced against the unified `request_object`.
- signature verification: Ed25519 verification is performed over the canonical policy payload.
- version lock: `policy_version` must match the pinned version passed to `runMndePipeline`.
- decision binding: `policy_hash` is written into `decision_object`.
- mismatch behavior: trust verification returns `trusted: false` and the pipeline refuses closed.

# Step 7. Build execution pipeline

Implemented order in `/mnde-core/index.ts`:

1. `preflight`
2. `validation`
3. `policy trust`
4. `release`
5. `runtime`

Failure behavior:

- Orbit fail: final decision is `REFUSE`.
- Policy trust fail: final decision is `REFUSE`.
- ARM hold: final decision is `HOLD`.
- ARM refuse: final decision is `REFUSE`.
- RAM0NA runtime fail: final decision is `REFUSE`.

# Step 9. Proof hooks

Added hooks:

- `request_hash`: set by `/preflight/index.ts`.
- `policy_hash`: set by `/policy/index.ts`.
- `decision_hash`: set by `/mnde-core/index.ts`.

Binding rule:

- `decision_hash` is SHA-256 over canonical decision content including `request_hash`, `policy_hash`, `decision`, `reasons`, `validation_hash`, projected cost fields, and downstream release/runtime hashes when present.

# Step 10. Final report

## full layer mapping

See `/mnde-core/FULL_LAYER_MAPPING.md`.

## missing pieces

See `/mnde-core/GAP_REPORT.md`.

## files created

- `C:\Users\Shadow\Desktop\INsol\package.json`
- `C:\Users\Shadow\Desktop\INsol\tsconfig.json`
- `C:\Users\Shadow\Desktop\INsol\shared\json.ts`
- `C:\Users\Shadow\Desktop\INsol\shared\hash.ts`
- `C:\Users\Shadow\Desktop\INsol\shared\errors.ts`
- `C:\Users\Shadow\Desktop\INsol\shared\types.ts`
- `C:\Users\Shadow\Desktop\INsol\shared\index.ts`
- `C:\Users\Shadow\Desktop\INsol\preflight\types.ts`
- `C:\Users\Shadow\Desktop\INsol\preflight\index.ts`
- `C:\Users\Shadow\Desktop\INsol\orbit\types.ts`
- `C:\Users\Shadow\Desktop\INsol\orbit\index.ts`
- `C:\Users\Shadow\Desktop\INsol\policy\types.ts`
- `C:\Users\Shadow\Desktop\INsol\policy\index.ts`
- `C:\Users\Shadow\Desktop\INsol\arm\types.ts`
- `C:\Users\Shadow\Desktop\INsol\arm\index.ts`
- `C:\Users\Shadow\Desktop\INsol\ramona\types.ts`
- `C:\Users\Shadow\Desktop\INsol\ramona\index.ts`
- `C:\Users\Shadow\Desktop\INsol\mnde-core\index.ts`
- `C:\Users\Shadow\Desktop\INsol\mnde-core\FULL_LAYER_MAPPING.md`
- `C:\Users\Shadow\Desktop\INsol\mnde-core\GAP_REPORT.md`
- `C:\Users\Shadow\Desktop\INsol\mnde-core\FINAL_REPORT.md`

## risks remaining

- Orbit still does not verify cryptographic intent signatures; the new stack preserves that gap as a reported weakness instead of inventing semantics for unknown signature material.
- Existing preflight and MNDe logic were extracted from separate repositories into one workspace; behavior was preserved where present, but the unified input envelope is new because no prior single envelope existed.
- The policy signature verifier expects raw 32-byte Ed25519 public keys encoded as hex and a detached signature over the canonical policy payload; existing source repos did not define a standalone signed-policy artifact, so policy issuance tooling still needs to be supplied externally.
