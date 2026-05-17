# Threat Model

Primary threats:

- Input tampering or canonicalization ambiguity.
- Policy drift between decision and replay.
- Runtime observation drift after approval.
- Unsigned or unverifiable allow receipts.
- Release package tampering.
- Startup with malformed provenance.
- Concurrency double-allow on the same execution ID.
- Browser-origin overload or socket exhaustion.
- Receipt persistence loss, partial writes, or queue saturation.

Controls:

- Strict parsing and canonical JSON hashing.
- Deterministic refusal codes.
- Signed receipts and replay verification.
- Manifest and provenance verification.
- Admission control, worker queue limits, receipt queue limits, and watchdogs.
- Hostile verifier, browser torture, parity, replay, and release integrity proof suites.
