# AegisOne Migration Audit Report

Generated on 2026-05-12 in `C:\Users\Shadow\Downloads\INsol\INsol` from branch `private/rebrand-aegisone`.

## Remotes

- `git remote -v` returned no configured remotes at audit time.
- No `origin`, public upstream, or legacy remote URL was present locally.

## CI/CD Integrations

- No `.github` directory was present.
- No GitHub Actions workflows were present in the repository working tree.
- No `vercel.json`, `netlify.toml`, or `wrangler.toml` deployment config was found.
- `.codex/config.toml` contains local-only policy enforcement configuration and blocks sandbox escape while requiring guarded handling for network and Git push actions.

## Webhook References

- Text search did not identify webhook endpoint configuration in the active source/config surface.
- No inherited deployment webhook file was found.

## GitHub Actions

- No GitHub Actions workflows were found.
- No inherited GitHub Actions secrets are present in the local repository because GitHub Actions secrets are repository-hosted metadata, not checked-in files.
- Migration control: do not copy secrets or environments into the private `AegisOne` repository.

## Package Publishing Targets

- Root `package.json` has `"private": true`.
- No `publishConfig` block was present in root `package.json`.
- No `.npmrc` file was found.
- No npm registry publishing target was found in active package metadata.

## Docker Registry References

- `mnde-release-package/Dockerfile` builds a local image from `node:24-bookworm-slim`.
- No checked-in container registry push target was found.
- No `ghcr.io`, `docker.io` push workflow, `quay.io`, or `gcr.io` publication target was found.

## Telemetry Endpoints

- No external telemetry, analytics, Sentry, PostHog, Segment, Mixpanel, or Google Analytics endpoint was found in the active search pass.
- Local runtime metrics endpoints such as `/metrics` remain local operational surfaces and are not external telemetry.

## Secrets Exposure Risks

- Search terms for `secret`, `token`, `password`, `api_key`, `private_key`, and PEM private key headers found no active external credential leakage in the audited source/config surface.
- Existing proof fixtures and local custody examples should still be treated as test material only and reviewed before any distribution bundle is generated.
- The local Git identity was changed from old MNDe-associated metadata to `AegisOne <aegisone@private.local>` for future commits in this repository.

## Artifact Publishing Flows

- Release and proof bundle scripts exist for local artifact generation.
- No automatic public artifact publication workflow was found.
- Existing archive files and proof bundles are local artifacts and should be regenerated after private transition validation if they are needed downstream.

## Release Automation

- Root package scripts include local release build commands:
  - `release:build`
  - `release:build:sidecar-custody`
- No automatic release workflow or public release publication target was found.

## Hidden Branding References

- Compatibility-sensitive MNDe references remain in filenames, scripts, environment variables, proof bundles, and existing protocol-facing documentation.
- These are intentionally preserved where changing them could alter operator workflows, receipt compatibility, replay behavior, or API contracts.
- Public-facing repository identity was changed to AegisOne in root package metadata and README framing.

## Required Private Controls

- Create or verify the private repository `AegisOne` before adding `origin`.
- Add only a verified private remote URL.
- Do not copy old remotes, public webhooks, Actions secrets, deployment hooks, package publishing tokens, or registry credentials.
- Push only the `private/rebrand-aegisone` branch after all integrity validation passes.

## Validation Gate Result

### Before Fix

- `proof:full` failed during top-5 concurrency verification.
- `test:local:concurrency` reproduced the failure with `winner_count: 0` instead of the expected `100`.
- Audit evidence reported `FAIL_AUTHORITY_GAP` while preserving `drift_mismatch_count: 0` and `replay_mismatch_count: 0`.
- Root cause: the Orbit multiple-action guard treated any top-level request with more than one declared `tool_call` as unauthorized. That broke the legacy compatibility contract where the matched `compile -> verify` tool-call sequence is a single ordered execution authority. ARM therefore never produced the first winner in the concurrency authority probe.

### Fix Applied

- `orbit/engine.ts` now treats matched top-level `tool_calls` and `orbit_intent.payload.tool_calls` as the compatibility-preserved execution plan.
- Nested action markers inside free-form `parameters` remain refused as `ERR_ORBIT_MULTIPLE_ACTIONS`.
- Tool-call mismatch validation now runs before nested action-marker validation so divergent Orbit payloads keep the expected `ERR_TOOL_CALL_SEQUENCE` priority.
- No package-name hash, receipt authority field, policy authority field, lock name, route, script, filename, or proof semantic was changed for this fix.

### After Fix

- `cmd /c npm run proof:full`: PASS.
- `cmd /c npm run test:local:concurrency`: PASS.
- `winner_count: 100`.
- `loser_count: 100`.
- `duplicate_allows: 0`.
- `final_verdict: PASS_READY_FOR_PROOF_EXPANSION`.
- `drift_mismatch_count: 0`.
- `replay_mismatch_count: 0`.
- Full proof reported attack wave `20/20`, remediation wave `12/12`, executive total `546/546`, and benchmark `zero_drift: true`, `zero_replay_mismatch: true`.

### Remaining Push Gate

- No private remote visibility has been verified in this session.
- Keep commit and push blocked until a private `origin` exists, `git remote -v` shows only that private origin, and repository visibility is verified as private.
