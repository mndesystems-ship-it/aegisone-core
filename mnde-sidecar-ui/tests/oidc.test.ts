import { strict as assert } from "node:assert";
import { webcrypto } from "node:crypto";
import { test } from "node:test";

import {
  buildAuthorizationUrl,
  generatePkceMaterial,
  mapRoleFromClaims,
  validateAuthConfigDocument,
  validateCallback,
  validateIdToken,
  validateOidcConfig,
  type OidcProviderConfig
} from "../src/auth/oidc.ts";

Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const config: OidcProviderConfig = {
  provider: "microsoft_entra",
  issuer: "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0",
  client_id: "22222222-2222-4222-8222-222222222222",
  redirect_uri: "http://localhost:8788/callback",
  scopes: ["openid", "profile", "email", "offline_access"],
  audience: "22222222-2222-4222-8222-222222222222",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  group_role_map: {
    "33333333-3333-4333-8333-333333333333": "ADMIN",
    "44444444-4444-4444-8444-444444444444": "OPERATOR",
    "55555555-5555-4555-8555-555555555555": "AUDITOR"
  }
};

const productionFlatConfig = {
  provider: "entra",
  issuer: "https://login.microsoftonline.com/71c8162e-fc56-45e3-8b3b-7f11eed19758/v2.0",
  client_id: "6c02e8c6-e36e-4db8-a505-52c322b485d6",
  audience: "6c02e8c6-e36e-4db8-a505-52c322b485d6",
  tenant_id: "71c8162e-fc56-45e3-8b3b-7f11eed19758",
  redirect_uri: "http://localhost:8788/callback",
  scopes: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "User.Read"
  ]
};

test("oidc config validates required Entra fields", () => {
  assert.equal(validateOidcConfig(config).configured, true);
  const invalid = validateOidcConfig({ ...config, tenant_id: "", redirect_uri: "https://auth.invalid/callback" });
  assert.equal(invalid.configured, false);
  assert.ok(invalid.errors.includes("ERR_AUTH_CONFIG_INVALID:tenant_id"));
  assert.ok(invalid.errors.includes("ERR_AUTH_REDIRECT_INVALID"));
});

test("auth config document rejects unsupported provider unknown fields and missing audience", () => {
  const valid = validateAuthConfigDocument({
    provider: "entra",
    entra: config
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.activeProvider, "microsoft_entra");

  const unsupported = validateAuthConfigDocument({ provider: "github" });
  assert.equal(unsupported.ok, false);
  assert.ok(unsupported.errors.includes("ERR_AUTH_PROVIDER_UNSUPPORTED"));

  const unknown = validateAuthConfigDocument({ provider: "entra", entra: { ...config, extra: true } });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.includes("ERR_AUTH_CONFIG_INVALID:entra.extra"));

  const missingAudience = validateAuthConfigDocument({ provider: "entra", entra: { ...config, audience: "" } });
  assert.equal(missingAudience.ok, false);
  assert.ok(missingAudience.errors.includes("ERR_AUTH_AUDIENCE_INVALID"));
});

test("flat production Entra config validates strict localhost callback assumptions", () => {
  const valid = validateAuthConfigDocument(productionFlatConfig);
  assert.equal(valid.ok, true);
  assert.equal(valid.activeProvider, "microsoft_entra");
  assert.equal(valid.providers.microsoft_entra?.configured, true);

  const wildcardRedirect = validateAuthConfigDocument({ ...productionFlatConfig, redirect_uri: "http://localhost:8788/*" });
  assert.equal(wildcardRedirect.ok, false);
  assert.ok(wildcardRedirect.errors.includes("ERR_AUTH_REDIRECT_INVALID"));

  const wrongPort = validateAuthConfigDocument({ ...productionFlatConfig, redirect_uri: "http://localhost:49152/callback" });
  assert.equal(wrongPort.ok, false);
  assert.ok(wrongPort.errors.includes("ERR_AUTH_REDIRECT_INVALID"));

  const wrongPath = validateAuthConfigDocument({ ...productionFlatConfig, redirect_uri: "http://localhost:8788/oidc/callback" });
  assert.equal(wrongPath.ok, false);
  assert.ok(wrongPath.errors.includes("ERR_AUTH_REDIRECT_INVALID"));
});

test("pkce material and authorize URL include state nonce and S256 challenge", async () => {
  const material = await generatePkceMaterial();
  assert.notEqual(material.verifier, material.challenge);
  const url = new URL(buildAuthorizationUrl(config, material));
  assert.equal(url.searchParams.get("state"), material.state);
  assert.equal(url.searchParams.get("nonce"), material.nonce);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("callback rejects state mismatch and accepts matching code", () => {
  assert.deepEqual(validateCallback("http://localhost:8788/callback?code=abc&state=good", "good"), { code: "abc", state: "good" });
  assert.throws(() => validateCallback("http://localhost:8788/callback?code=abc&state=bad", "good"), /ERR_OIDC_STATE_MISMATCH/);
});

test("valid Entra login fixture validates and maps role", async () => {
  const { token, jwks } = await signedToken({ groups: ["33333333-3333-4333-8333-333333333333"], nonce: "nonce-1" });
  const result = await validateIdToken({ idToken: token, config, jwks, expectedNonce: "nonce-1", nowSeconds: 100 });
  assert.equal(result.session.provider, "microsoft_entra");
  assert.equal(result.session.role, "ADMIN");
  assert.equal(result.session.email, "alex@mnde.invalid");
  assert.equal(result.session.tenant_id, "11111111-1111-4111-8111-111111111111");
  assert.equal("access_token" in result.session, false);
});

test("token validation rejects invalid issuer audience expiry nonce tenant and missing claims", async () => {
  await rejectsToken({ iss: "https://login.microsoftonline.com/99999999-9999-4999-8999-999999999999/v2.0" }, /ERR_TOKEN_ISSUER_INVALID/);
  await rejectsToken({ aud: "wrong-client" }, /ERR_TOKEN_AUDIENCE_INVALID/);
  await rejectsToken({ exp: 10 }, /ERR_TOKEN_EXPIRED/, 100);
  await rejectsToken({ nonce: "wrong" }, /ERR_TOKEN_NONCE_MISMATCH/);
  await rejectsToken({ tid: "wrong-tenant" }, /ERR_TOKEN_TENANT_INVALID/);
  await rejectsToken({ email: undefined, preferred_username: undefined, upn: undefined }, /ERR_TOKEN_EMAIL_MISSING/);
});

test("token validation rejects unsigned missing kid oversized and malformed JWTs", async () => {
  await assert.rejects(() => validateIdToken({ idToken: `${encode({ alg: "none", typ: "JWT" })}.${encode({})}.sig`, config, jwks: { keys: [] }, expectedNonce: "nonce-1" }), /ERR_TOKEN_UNSIGNED_OR_UNSUPPORTED/);
  const { token, jwks } = await signedToken({ nonce: "nonce-1" }, {});
  await assert.rejects(() => validateIdToken({ idToken: token, config, jwks, expectedNonce: "nonce-1", nowSeconds: 100 }), /ERR_TOKEN_KID_MISSING/);
  await assert.rejects(() => validateIdToken({ idToken: `${"a".repeat(20000)}.b.c`, config, jwks, expectedNonce: "nonce-1" }), /ERR_TOKEN_TOO_LARGE/);
  await assert.rejects(() => validateIdToken({ idToken: "not-a-jwt", config, jwks, expectedNonce: "nonce-1" }), /ERR_TOKEN_MALFORMED/);
});

test("tampered token is rejected", async () => {
  const { token, jwks } = await signedToken({ nonce: "nonce-1" });
  const parts = token.split(".");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  payload.email = "attacker@mnde.invalid";
  parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
  await assert.rejects(() => validateIdToken({ idToken: parts.join("."), config, jwks, expectedNonce: "nonce-1", nowSeconds: 100 }), /ERR_TOKEN_SIGNATURE_INVALID/);
});

test("role mapping downgrades unknown groups to viewer", () => {
  assert.equal(mapRoleFromClaims({ groups: ["44444444-4444-4444-8444-444444444444"] }, config.group_role_map), "OPERATOR");
  assert.equal(mapRoleFromClaims({ groups: ["unknown"] }, config.group_role_map), "VIEWER");
});

async function rejectsToken(overrides: Record<string, unknown>, pattern: RegExp, nowSeconds = 100) {
  const { token, jwks } = await signedToken({ nonce: "nonce-1", ...overrides });
  await assert.rejects(() => validateIdToken({ idToken: token, config, jwks, expectedNonce: "nonce-1", nowSeconds }), pattern);
}

async function signedToken(overrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = { kid: "kid-1" }) {
  const keyPair = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.kid = "kid-1";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const header = { alg: "RS256", typ: "JWT", ...headerOverrides };
  const claims = {
    iss: config.issuer,
    aud: config.client_id,
    exp: 9999999999,
    iat: 100,
    nonce: "nonce-1",
    sub: "user-1",
    name: "Alex Operator",
    email: "alex@mnde.invalid",
    tid: "11111111-1111-4111-8111-111111111111",
    groups: ["44444444-4444-4444-8444-444444444444"],
    ...overrides
  };
  for (const [key, value] of Object.entries(claims)) {
    if (value === undefined) delete (claims as Record<string, unknown>)[key];
  }
  const input = `${encode(header)}.${encode(claims)}`;
  const signature = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(input));
  return {
    token: `${input}.${Buffer.from(signature).toString("base64url")}`,
    jwks: { keys: [publicJwk] }
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
