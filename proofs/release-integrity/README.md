# Release Integrity Proof

Purpose: verify release manifests, provenance, and deterministic startup refusal on tampering or malformed release material.

Verification:

```powershell
npm run test:release:integrity
npm run test:release:provenance
```

PASS criteria: malformed manifest and malformed provenance fail closed with deterministic refusal; valid provenance remains structurally verifiable.

Artifacts retain compact release manifests, signatures, and provenance under `artifacts/` and `releases/`.
