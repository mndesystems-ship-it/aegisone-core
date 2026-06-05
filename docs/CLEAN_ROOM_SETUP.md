# MNDe Clean-Room Setup

This guide validates MNDe from a fresh clone without relying on local generated state.

## Clone and Checkout

```powershell
git clone https://github.com/mndesystems-ship-it/aegisone-core.git
cd aegisone-core
git rev-parse HEAD
```

Record the returned commit hash and compare it to the release commit supplied with the validation report. Public clean-room reviews should use the default branch unless the reviewer has been explicitly asked to validate a specific commit or branch.

## Install

```powershell
npm install
cd mnde-sidecar-ui
npm install
cd ..
```

## Bootstrap Development Signing Keys

Generate local development receipt signing keys:

```powershell
npm run bootstrap:dev
```

This creates:

- `shared/receipt_keys/receipt_signing_private.pem`
- `shared/receipt_keys/receipt_signing_public.pem`

The private key is local development material and must not be committed. The command is idempotent and refuses to overwrite existing keys. To intentionally rotate local development keys:

```powershell
node .\scripts\bootstrap_dev_receipt_keys.mjs --force
```

## Start the Sidecar

```powershell
node --experimental-strip-types .\mnde-local-sidecar.mjs
```

Expected startup:

```text
MNDe local sidecar listening on http://127.0.0.1:8787
```

Verify endpoints:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/readyz
Invoke-RestMethod http://127.0.0.1:8787/identity
Invoke-RestMethod http://127.0.0.1:8787/metrics
```

Submit a decision:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/v1/decisions -Method Post -ContentType application/json -InFile .\requests\allow-request.json
```

## Start the Desktop App

```powershell
cd mnde-sidecar-ui
npm run tauri -- dev
```

On a fresh clone without `auth-config.local.json`, the app should launch and show enterprise authentication as not configured. This is expected and fail-closed. Sign-in buttons remain disabled until a valid OIDC provider config exists, and protected live actions remain blocked.

## Supplying Real OIDC Config

Copy the example file and replace every placeholder with real tenant values:

```powershell
Copy-Item .\auth-config.example.json .\auth-config.local.json
```

Then edit `auth-config.local.json` with a valid Microsoft Entra ID or Okta issuer, client ID, audience, redirect URI, scopes, tenant ID, and role mapping. Do not commit `auth-config.local.json`.

## Production Verifier

From `mnde-sidecar-ui`:

```powershell
npm run verify:desktop-production
```

The verifier resolves the repository root relative to its own script, starts an owned sidecar if none is running, and validates `/identity` before trusting any process on `127.0.0.1:8787`. If another process is already bound to that port and cannot prove repo-local identity, verification fails with `ERR_UNTRUSTED_SIDECAR_INSTANCE`.

## Known Fail-Closed States

- Missing receipt signing keys: run `npm run bootstrap:dev`.
- Missing OIDC config: desktop launches, auth remains unavailable, protected actions are blocked.
- Invalid OIDC config: auth remains unavailable until the config validates.
- Untrusted sidecar on port `8787`: production verifier fails with `ERR_UNTRUSTED_SIDECAR_INSTANCE`.
- Missing sidecar and failed launch: production verifier fails with `ERR_SIDECAR_START_FAILED`.
