# Audit-Ready Tree

```text
/
  src/
  orbit/
  arm/
  ram0na/
  sidecar/
  shared/
  schemas/
  scripts/
  tests/
  docs/
  proofs/
    determinism/
    replay/
    parity/
    throughput/
    browser-torture/
    security/
    release-integrity/
    custody/
  examples/
  releases/
```

Compatibility source directories also remain at top level where they are part of runtime or release tooling: `preflight/`, `policy/`, `custody/`, `release/`, `app/`, `codex-mnde/`, `sidecar-custody/`, and `rust/`.

Generated proof output is ignored and can be recreated by the commands in `docs/VERIFY.md`.
