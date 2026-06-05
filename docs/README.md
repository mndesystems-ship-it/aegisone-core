# MNDe Documentation

This index separates first-time evaluation material from deeper proof and operational material.

## First-Time Evaluators

Start here if you are trying to understand MNDe quickly:

- [../START_HERE.md](../START_HERE.md)
- [../README.md](../README.md)
- [../REVIEWER_QUICKSTART.md](../REVIEWER_QUICKSTART.md)
- [../REVIEW.md](../REVIEW.md)

## Reviewer Evidence

Use these when validating the external review path:

- [reviewer-kit.md](reviewer-kit.md)
- [independent-verification.md](independent-verification.md)
- [../reviewer-kit/README.md](../reviewer-kit/README.md)
- [../reviewer-kit/VERIFY.md](../reviewer-kit/VERIFY.md)

## Product And Runtime Model

Use these after the reviewer kit passes:

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [OPERATIONAL_MODEL.md](OPERATIONAL_MODEL.md)
- [SECURITY_MODEL.md](SECURITY_MODEL.md)
- [CLEAN_ROOM_SETUP.md](CLEAN_ROOM_SETUP.md)

## Desktop And OIDC

The desktop app can run in demo mode without enterprise identity. Live protected actions require configured OIDC authority and are expected to fail closed when OIDC is absent.

- [../mnde-sidecar-ui/docs/HOW_TO_USE_MNDE_SIDECAR_UI.md](../mnde-sidecar-ui/docs/HOW_TO_USE_MNDE_SIDECAR_UI.md)
- [../mnde-sidecar-ui/docs/OIDC_SMOKE_TEST.md](../mnde-sidecar-ui/docs/OIDC_SMOKE_TEST.md)

## Deeper Proof Catalog

Retained evidence lives under `../proofs/`. Generated logs, receipt streams, benchmark outputs, and temporary review artifacts are intentionally ignored unless retained as expected fixtures.

Primary proof areas:

- `../proofs/determinism/`
- `../proofs/replay/`
- `../proofs/parity/`
- `../proofs/security/`
- `../proofs/throughput/`
- `../proofs/external-reviews/`

Internal audit reports, migration notes, and benchmark bundles are secondary diligence material. They are not required for a first successful review.
