# AegisOne Migration Compatibility

## Scope

AegisOne is a private repository identity transition for the deterministic execution authority runtime. The migration changes repository-facing identity and documentation while preserving the compatibility-sensitive execution surface.

## Unchanged APIs

- `POST /v1/decisions` remains the decision API.
- `GET /healthz`, `GET /readyz`, and `GET /metrics` remain available.
- Local demo routes `/verify`, `/replay`, and the legacy `/decide` alias are unchanged.
- Request and response JSON contracts are unchanged.
- Existing local filenames, launch scripts, and `MNDE_*` environment variables are retained where they are part of deployed operator workflow or compatibility.

## Unchanged Receipt Semantics

- Receipt canonicalization remains unchanged.
- Receipt fields, hash inputs, signature verification, and replay comparison semantics are unchanged.
- Existing receipt proof bundles remain valid for compatibility comparison.
- `ALLOW` and `REFUSE` decision meanings are unchanged.

## Unchanged Determinism Guarantees

- The deterministic core, policy logic, canonical JSON handling, replay behavior, and cryptographic verification path are not modified by this migration.
- Deterministic outputs are expected to remain byte-for-byte compatible for the same policy and request inputs.
- Policy drift, receipt drift, replay mismatch, or signature mismatch is a migration failure.

## Operational Migration Guidance

1. Create or verify a private Git repository named `AegisOne`.
2. Confirm the repository description is `Deterministic execution authority and pre-execution enforcement runtime.`
3. Confirm repository visibility is private before adding any remote.
4. Add only the verified private remote as `origin`.
5. Push only `private/rebrand-aegisone`.
6. Do not copy inherited GitHub Actions secrets, deployment hooks, webhooks, public package publishing tokens, or release automation into the new repository.
7. Keep runtime compatibility names until downstream operators have completed a controlled migration.

## Rollback Strategy

- If validation detects drift, stop before push.
- Remove the private `origin` remote if one was added.
- Keep the local branch for forensic comparison and return operators to the previous validated commit.
- Re-run determinism, replay, hostile verifier, custody, sidecar, startup integrity, and proof bundle checks before any renewed push attempt.

## Private Transition Rationale

AegisOne carries the operating rule: one authority decides and everything else is refused. The repository transition removes public linkage and inherited publication paths while retaining the deterministic execution guarantees that make existing receipts, replay verification, and policy enforcement trustworthy.
