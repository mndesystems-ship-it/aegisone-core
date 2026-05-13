# AUDIT_PROVENANCE_REPORT

## Result

FAIL: complete release provenance could not be produced from this workspace.

## Provenance Source

No acceptable provenance source was available.

- `.git` directory present: `false`
- `git status --short`: failed with `fatal: not a git repository (or any of the parent directories): .git`
- `MNDE_RELEASE_COMMIT`: not set
- `MNDE_RELEASE_TAG`: not set

The release builder now fails closed unless it can resolve both a non-null 40-character commit hash and a non-null release tag from either real git metadata or explicit environment values.

## Release Tag

Not available.

## Commit Hash

Not available.

## Build Timestamp

No final release build timestamp was emitted because the provenance gate failed before `provenance.json` and `manifest.json` could be finalized.

## Artifact List

No final `mnde-release-package` artifact list is claimed for this run.

The previous partial package directory may exist on disk, but it is not a valid final release package for this provenance run because the build failed before complete provenance and manifest finalization.

## Verification Steps

The following checks were performed:

```powershell
Test-Path .git
$env:MNDE_RELEASE_COMMIT
$env:MNDE_RELEASE_TAG
git status --short
Get-ChildItem -Recurse -Directory -Force -Filter .git
node ./scripts/build_release_package.mjs
```

The following final-package verification steps were not run because the build failed before a valid complete-provenance package existed:

```powershell
cmd /c .\mnde-release-package\bin\verify-release.cmd
cmd /c .\mnde-release-package\bin\mnde-node.cmd version
cmd /c .\mnde-release-package\bin\rust\parity_runner.exe --version
cmd /c .\mnde-release-package\bin\verify-receipt.cmd --receipt .\mnde-release-package\sample-receipt.json --public-key .\mnde-release-package\app\shared\receipt_keys\receipt_signing_public.pem
```

## Verification Transcript

```text
Test-Path .git
False

$env:MNDE_RELEASE_COMMIT
<empty>

$env:MNDE_RELEASE_TAG
<empty>

git status --short
fatal: not a git repository (or any of the parent directories): .git

Get-ChildItem -Recurse -Directory -Force -Filter .git
<no output>

node ./scripts/build_release_package.mjs
Error: Complete release provenance requires a non-null 40-character git commit hash from .git or MNDE_RELEASE_COMMIT.
```

## Diff Summary

Packaging/provenance gate changed:

- `scripts/build_release_package.mjs`: now fails if commit is null, tag is null, or environment-provided provenance conflicts with git metadata.
- `AUDIT_PROVENANCE_REPORT.md`: records this failed complete-provenance run.

Runtime logic unchanged:

- No MNDe decision logic was changed.
- No refusal codes were changed.
- No policy semantics were changed.
- No cost semantics were changed.
- No audit execution path behavior was changed in this run.

## Remaining Blockers

- Provide a real git checkout with `.git` metadata available, or set both `MNDE_RELEASE_COMMIT` and `MNDE_RELEASE_TAG`.
- If both git metadata and environment values are provided, they must match exactly.
- Re-run `node ./scripts/build_release_package.mjs`.
- Then run the final package verification commands listed above.
