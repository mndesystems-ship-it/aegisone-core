# Private Implementation Notes

## What changed

- Reworked the audit bundle entrypoint so the supported production path is `audit/run_bundle.ps1`.
- Kept hashing, canonicalization, decision shaping, and receipt signing centralized in `audit/node_runtime.ts`.
- Kept the report writer focused in `audit/run.ts`, with parity treated as an input artifact rather than a hidden child process side effect.
- Preserved the four pipeline stages in one deterministic path: `Preflight -> Orbit -> ARM -> RAM0NA`.

## Why the orchestration changed

- The desktop sandbox allows shell execution but blocks some nested `node -> child_process -> cargo` flows.
- Moving the cross-runtime orchestration to a thin PowerShell edge keeps the production path deterministic and operationally clear.
- Node now fails loudly if parity output is missing instead of trying to guess or partially continue.

## Specific fixes

- Added adversarial coverage for:
  - partial input
  - policy tamper
  - receipt tamper
  - unrelated request contamination
  - boundary numeric case
- Tightened the cost prevention fixtures so all three scenarios produce meaningful prevented cost.
- Kept replay verification strict: signature validation, exact receipt bytes, exact decision, and exact decision hash all must match.
- Kept manifest ordering deterministic and limited to the audit artifacts that matter in review.

## Follow-up judgment calls

- Receipt signing still uses a pinned HMAC secret because the current repo did not have a production key management path already wired in.
- If this moves beyond local proof generation, the next clean step is to load signing material from a controlled file or HSM-backed edge without changing the receipt contract.
