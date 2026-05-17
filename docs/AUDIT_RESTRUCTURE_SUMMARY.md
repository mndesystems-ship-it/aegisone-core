# Audit Restructure Summary

This cleanup separates runtime code from proof evidence while preserving deterministic verification capability.

Moved or retained:

- Latest compact summaries and verifier artifacts moved to `proofs/*/artifacts/`.
- Reproducible verification entry points documented in each `proofs/*/README.md`.
- Release manifests, signatures, and provenance copied to `releases/`.
- Receipt and API schemas copied to `schemas/`.
- Runtime compatibility paths preserved except `ramona/` was renamed to `ram0na/` with import updates.

Removed from active tracked structure:

- ZIP release packages.
- raw `.jsonl` receipt streams.
- latency CSVs and transient logs.
- JMeter result trees.
- duplicated external review drops.
- generated release package folders.
- Rust target build output.

Security-sensitive behavior was not weakened. Receipt formats, schemas, replay semantics, signed receipt validation, release integrity checks, custody checks, browser-origin torture verification, and concurrency integrity checks remain auditable through committed scripts.
