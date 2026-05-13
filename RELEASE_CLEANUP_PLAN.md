# MNDe Release Workspace Cleanup Plan

## Current Read

The repository root is a lab and release workspace. It contains source, generated proof bundles, local UI files, release packages, zip artifacts, review docs, and historical outputs in one place.

The cleanest production release candidate is:

```text
mnde-custody-release/
```

The broad historical/full package candidate is:

```text
mnde-release-package/
```

The current release builder writes the custody-only package to `mnde-custody-release/`, which should be treated as the canonical production release unless the full package is intentionally rebuilt and re-scoped.

## Canonical Buckets

### Source Workspace

Keep these at the repository root because they are source or build inputs:

```text
arm/
audit/
benchmark/
config/
custody/
examples/
lifecycle/
mnde-core/
orbit/
policy/
preflight/
ramona/
release/
requests/
rust/
scripts/
shared/
package.json
package-lock.json
tsconfig.json
```

### Current Production Release

Treat this as the canonical shippable custody package:

```text
mnde-custody-release/
mnde-custody-release-v1.0.0-win32-x64.zip
```

Expected release shape:

```text
mnde-custody-release/
  app/
  bin/
  config/
  examples/
  lifecycle/
  custody.md
  operator_runbook.md
  manifest.json
  provenance.json
  install.cmd
  start.cmd
  stop.cmd
  restart.cmd
  status.cmd
  uninstall.cmd
```

### Full / Historical Release Candidate

Keep, but mark as non-canonical until rebuilt or intentionally promoted:

```text
mnde-release-package/
mnde-release-package.zip
mnde-release-package (2).zip
mnde-release-package (3).zip
```

Reason: it contains useful product/evidence material, but also many proof bundles and generated outputs that make it unclear what the reviewer should treat as canonical.

### Evidence Archive

Move or copy these under a dedicated archive boundary after confirming no downstream script expects them at root:

```text
release-evidence/
  audit-proof-bundle/
  stable-proof-bundle/
  volatile-benchmark-bundle/
  controlled-benchmark-bundle/
  mnde-controlled-benchmark-bundle/
  attack-wave-bundle/
  hyper-targeted-10m-bundle/
  proof-expansion-bundle/
  remediation-wave-bundle/
  post-remediation-verification-bundle/
  external-review-drop/
  external-audit-integration-output/
  fresh-machine-proof/
  operations-health-output/
  operations-test-output/
  custody-rotation-output/
  audit_output/
  audit_output.zip
  technical-drop-package/
  technical-drop-package.zip
```

### Product / Review Docs

Keep high-signal docs at root only if the repository root remains the reviewer entrypoint. Otherwise copy them into a `docs/` or `review/` folder:

```text
README.md
CLAIM.md
REVIEWER_PATH.md
TEST_MATRIX.md
BUSINESS_PROOF.md
HOSTILE_REVIEW_PASS.md
AUDIT_HARDENING_REPORT.md
AUDIT_PROVENANCE_REPORT.md
RELEASE_INTEGRITY.md
API_SURFACE.md
OPERATIONS_LAUNCH_CHECKLIST.md
operator_runbook.md
VALIDATION_STATUS.md
```

Private or drafting material should not ship:

```text
IMPLEMENTATION_NOTES.private.md
~$CHNICAL_WHITEPAPER.md
```

## Recommended Final Root Shape

```text
INsol/
  README.md
  CLAIM.md
  RELEASE_CLEANUP_PLAN.md
  package.json
  package-lock.json
  tsconfig.json

  src-equivalent source folders...
  scripts/

  mnde-custody-release/
  mnde-custody-release-v1.0.0-win32-x64.zip

  release-evidence/
  release-archive/
```

## Safe Cleanup Sequence

1. Freeze the current state with `git status --short` and a file inventory.
2. Verify `mnde-custody-release/manifest.json` matches the current files in `mnde-custody-release/`.
3. Treat `mnde-custody-release/` as canonical production release.
4. Move historical proof/output folders into `release-evidence/`.
5. Move old broad release packages and duplicate zips into `release-archive/`.
6. Update root `README.md` so reviewers know:
   - production release is `mnde-custody-release/`
   - evidence archive is `release-evidence/`
   - older full package is non-canonical unless explicitly promoted
7. Run the release verifier from the clean package:

```powershell
.\mnde-custody-release\bin\verify-custody-release.cmd
```

## Do Not Do Yet

Do not delete proof bundles, zip artifacts, or generated outputs until an external reviewer or release owner confirms they are no longer needed.

Do not promote `mnde-release-package/` as the main release until its proof bundles are separated from product files and its manifest/provenance story is re-verified.
