# AUDIT_HARDENING_REPORT

## What Changed

- Added a release builder at `scripts/build_release_package.mjs` that freezes the current TypeScript workspace into plain shipped JavaScript under `mnde-release-package/app/`.
- Added a bundled runtime release format with wrapper commands in `mnde-release-package/bin/` and a copied Node runtime binary.
- Updated `rust/parity_runner` so the shipped Rust executable resolves the bundled Node runtime and compiled parity bridge from the release package instead of calling source-time TypeScript.
- Added `provenance.json` generation with release version, git commit hash if available, tag if available, build timestamp, target platform, and toolchain versions.
- Added `manifest.json` generation with exact SHA-256 and byte size for each shipped artifact in the release package.
- Added a public-key-verifiable receipt signature lane using Ed25519 in parallel with the existing HMAC signature field.
- Added a manifest verifier, receipt verifier, audit runner, and sustained benchmark entrypoints under `release/`.
- Added a sustained benchmark mode that emits strict 10-second window throughput plus `p50`, `p95`, `p99`, and `p999`.

## What Did Not Change

- No MNDe decision logic was changed.
- No refusal logic was changed.
- No policy semantics were changed.
- No cost semantics were changed.
- The existing HMAC receipt field remains in place for compatibility.
- The runtime still evaluates the same request payloads and returns the same decision outcomes for identical inputs.

## Why These Changes Were Needed

- Independent audit requires a shipped runtime that can execute without `cargo run`, `node --experimental-strip-types`, or source presence.
- Independent audit requires a file-level manifest that pins exactly what is executed.
- Independent audit requires provenance that ties the shipped package back to a release version, toolchain, and commit when available.
- Independent audit requires receipt verification that does not depend on a shared secret, so an Ed25519 verifier was added alongside the legacy HMAC.
- Independent audit requires a single shipped audit entrypoint and machine-readable sustained benchmark artifacts.

## How To Build The Shipped Package

Run:

```powershell
npm run release:build
```

This writes the release package to `mnde-release-package/`.

If the workspace is not a git checkout, set these before building to get complete provenance:

```powershell
$env:MNDE_RELEASE_COMMIT = "<40-char git commit hash>"
$env:MNDE_RELEASE_TAG = "<release tag>"
```

## How To Run The Shipped Artifacts

Node runtime artifact:

```powershell
.\mnde-release-package\bin\mnde-node.cmd version
.\mnde-release-package\bin\mnde-node.cmd evaluate --input .\path\to\request.json
```

Rust runtime artifact:

```powershell
.\mnde-release-package\bin\rust\parity_runner.exe --version
.\mnde-release-package\bin\rust\parity_runner.exe .\mnde-release-package\audit-proof-bundle\proof_bundle\parity_vectors.json
```

## How To Verify Manifest Hashes

Run:

```powershell
.\mnde-release-package\bin\verify-release.cmd
```

This fails closed if any shipped artifact is missing, has the wrong byte size, or has the wrong SHA-256.

## How To Verify Receipt Signatures

Run with the shipped public key:

```powershell
.\mnde-release-package\bin\verify-receipt.cmd --receipt .\path\to\receipt.json
```

Run with an explicit public key file:

```powershell
.\mnde-release-package\bin\verify-receipt.cmd --receipt .\path\to\receipt.json --public-key .\path\to\receipt_signing_public.pem
```

The verifier checks the legacy HMAC field for compatibility and the new Ed25519 signature for third-party verification.

## How To Execute The Audit Without Rebuilding

Run:

```powershell
.\mnde-release-package\bin\run-audit.cmd
```

This uses only shipped artifacts:

- bundled `node.exe`
- compiled JS in `app/`
- shipped Rust parity executable

It does not call:

- `cargo run`
- `ts-node`
- `node --experimental-strip-types`
- any dependency fetch step

## Known Provenance Limitation In This Workspace

- The current workspace is a package drop, not a git checkout.
- The release builder therefore records `provenance_status: "incomplete"` unless `MNDE_RELEASE_COMMIT` is supplied or the repo is rebuilt from a real git checkout.
- All other hardening work is wired so the same shipped package format can become fully auditable once real commit provenance is available.
