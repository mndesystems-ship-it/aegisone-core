# MNDe OIDC Smoke Test

This smoke test proves the native Tauri OIDC runtime against real Microsoft Entra ID and Okta tenants. Mocked token tests are not procurement-clearing proof.

## Private Config

Copy `auth-config.example.json` to `auth-config.local.json`.

`auth-config.local.json` is ignored by git. Do not commit tenant IDs, client IDs, group IDs, or secrets.

MNDe uses public/native-app authorization-code with PKCE. Do not configure a client secret for the desktop app.

## Microsoft Entra Setup

1. In Microsoft Entra admin center, create an App Registration.
2. Set platform type to public/native client.
3. Add redirect URI:
   - `http://127.0.0.1:49152/oidc/callback`
4. Enable ID tokens for the app if required by your tenant policy.
5. Configure delegated scopes:
   - `openid`
   - `profile`
   - `email`
   - `offline_access`
6. Add group claims to the token, or add an `mnde_role` claim through claims mapping.
7. Put Entra group object IDs in `group_role_map`.
8. Fill the `entra` section in `auth-config.local.json`.

Required Entra fields:

- `issuer`
- `client_id`
- `redirect_uri`
- `scopes`
- `audience`
- `tenant_id`
- `group_role_map`

## Okta Setup

1. In Okta Admin, create an OIDC Native Application.
2. Add sign-in redirect URI:
   - `http://127.0.0.1:49153/oidc/callback`
3. Allow refresh tokens for the native app.
4. Configure scopes:
   - `openid`
   - `profile`
   - `email`
   - `offline_access`
   - `groups`
5. Add a groups claim or `mnde_role` claim to the ID token.
6. Fill the `okta` section in `auth-config.local.json`.

Required Okta fields:

- `issuer`
- `client_id`
- `redirect_uri`
- `scopes`
- `audience`
- `group_role_map`

## Run Smoke Test

From `C:\Users\Shadow\Downloads\INsol\mnde-sidecar-ui`:

```powershell
node --experimental-strip-types scripts\run_oidc_smoke_readiness.mjs
```

Then run the desktop app and click each provider sign-in button. A procurement-clearing run must produce:

- Entra callback received
- Entra token exchange succeeded
- Entra JWKS fetched and cached
- Entra ID token validated in Rust
- Entra refresh token stored only in OS secure storage
- Entra logout purged token
- Okta callback received
- Okta token exchange succeeded
- Okta JWKS fetched and cached
- Okta ID token validated in Rust
- Okta refresh token stored only in OS secure storage
- Okta logout purged token

## Expected Artifacts

Smoke output is written to `auth-smoke-artifacts/`:

- `auth_smoke_report.md`
- `entra_smoke_result.json`
- `okta_smoke_result.json`
- `oidc_runtime_summary.json`
- `redacted_runtime_logs.txt`
- `direct_validation_results.json`
- `screenshots/`

## Procurement-Clearing Proof

The procurement blocker is cleared only when:

- Microsoft Entra result is `PASS`
- Okta result is `PASS`
- Reports contain redacted provider metadata
- Session metadata contains no access token, ID token, or refresh token
- Refresh token storage is OS secure storage
- Logout purge is verified
- Screenshots or console logs show both successful provider runs

If either provider is missing, unconfigured, or not interactively tested, the final gate remains `FAIL`.
