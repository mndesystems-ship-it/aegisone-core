import type { AuthProvider, AuthRole, AuthSession } from "./model";

export interface OidcProviderConfig {
  provider: Extract<AuthProvider, "microsoft_entra" | "okta">;
  issuer: string;
  client_id: string;
  redirect_uri: string;
  scopes: string[];
  audience: string;
  tenant_id?: string;
  group_role_map?: Record<string, AuthRole>;
}

export interface OidcReadiness {
  provider: OidcProviderConfig["provider"];
  configured: boolean;
  errors: string[];
}

export interface AuthConfigValidation {
  ok: boolean;
  activeProvider?: OidcProviderConfig["provider"];
  providers: Partial<Record<OidcProviderConfig["provider"], OidcReadiness>>;
  errors: string[];
}

export interface PkceMaterial {
  verifier: string;
  challenge: string;
  state: string;
  nonce: string;
}

export interface ValidatedOidcToken {
  session: AuthSession;
  claims: Record<string, unknown>;
}

export interface JsonWebKeySet {
  keys: JsonWebKey[];
}

const MAX_ID_TOKEN_BYTES = 16 * 1024;
const ALLOWED_AUTH_DOC_KEYS = new Set(["provider", "entra", "okta", "issuer", "client_id", "redirect_uri", "scopes", "audience", "tenant_id", "group_role_map"]);
const ALLOWED_PROVIDER_KEYS = new Set(["provider", "issuer", "client_id", "redirect_uri", "scopes", "audience", "tenant_id", "group_role_map"]);

export function validateOidcConfig(config: Partial<OidcProviderConfig>): OidcReadiness {
  const provider = config.provider ?? "microsoft_entra";
  const errors: string[] = [];
  if (!["microsoft_entra", "okta"].includes(provider)) errors.push("ERR_AUTH_PROVIDER_UNSUPPORTED");
  if (!isHttpsUrl(config.issuer)) errors.push("ERR_AUTH_ISSUER_INVALID");
  if (!config.client_id?.trim()) errors.push("ERR_AUTH_CONFIG_INVALID:client_id");
  if (!config.audience?.trim()) errors.push("ERR_AUTH_AUDIENCE_INVALID");
  if (!isLoopbackRedirect(config.redirect_uri)) errors.push("ERR_AUTH_REDIRECT_INVALID");
  if (!Array.isArray(config.scopes) || config.scopes.length === 0 || !config.scopes.every((scope) => typeof scope === "string" && scope.trim()) || !config.scopes.includes("openid")) {
    errors.push("ERR_AUTH_CONFIG_INVALID:scopes");
  }
  if (provider === "microsoft_entra") {
    if (!config.tenant_id?.trim()) errors.push("ERR_AUTH_CONFIG_INVALID:tenant_id");
    if (config.tenant_id && !isGuid(config.tenant_id)) errors.push("ERR_AUTH_CONFIG_INVALID:tenant_id_format");
    if (config.issuer && config.tenant_id && !trimSlash(config.issuer).endsWith(`/${config.tenant_id}/v2.0`)) errors.push("ERR_AUTH_ISSUER_INVALID:tenant_mismatch");
  }
  return { provider, configured: errors.length === 0, errors };
}

export function validateAuthConfigDocument(input: unknown): AuthConfigValidation {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, providers: {}, errors: ["ERR_AUTH_CONFIG_MISSING"] };
  }
  const doc = input as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!ALLOWED_AUTH_DOC_KEYS.has(key)) errors.push(`ERR_AUTH_CONFIG_INVALID:${key}`);
  }
  const provider = normalizeProvider(doc.provider);
  if (!provider) errors.push("ERR_AUTH_PROVIDER_UNSUPPORTED");

  const providers: AuthConfigValidation["providers"] = {};
  const hasFlatConfig = ["issuer", "client_id", "redirect_uri", "scopes", "audience", "tenant_id", "group_role_map"].some((key) => doc[key] !== undefined);
  if (provider && hasFlatConfig) {
    const label = provider === "microsoft_entra" ? "entra" : "okta";
    providers[provider] = validateProviderDocument(provider, doc, errors, label);
  }
  if (doc.entra !== undefined) providers.microsoft_entra = validateProviderDocument("microsoft_entra", doc.entra, errors, "entra");
  if (doc.okta !== undefined) providers.okta = validateProviderDocument("okta", doc.okta, errors, "okta");
  if (provider && !providers[provider]) errors.push("ERR_AUTH_CONFIG_MISSING");

  return {
    ok: errors.length === 0 && Boolean(provider && providers[provider]?.configured),
    activeProvider: provider,
    providers,
    errors
  };
}

export async function generatePkceMaterial(): Promise<PkceMaterial> {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return {
    verifier,
    challenge,
    state: base64Url(randomBytes(24)),
    nonce: base64Url(randomBytes(24))
  };
}

export function buildAuthorizationUrl(config: OidcProviderConfig, material: PkceMaterial): string {
  const url = new URL(`${trimSlash(config.issuer)}/oauth2/v2.0/authorize`);
  if (config.provider === "okta") {
    url.pathname = `${new URL(config.issuer).pathname.replace(/\/$/, "")}/v1/authorize`.replace(/^\/\//, "/");
  }
  url.searchParams.set("client_id", config.client_id);
  url.searchParams.set("redirect_uri", config.redirect_uri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("code_challenge", material.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", material.state);
  url.searchParams.set("nonce", material.nonce);
  if (config.audience) url.searchParams.set("audience", config.audience);
  return url.toString();
}

export function validateCallback(url: string, expectedState: string): { code: string; state: string } {
  const parsed = new URL(url);
  const state = parsed.searchParams.get("state");
  const code = parsed.searchParams.get("code");
  if (!state || state !== expectedState) throw new Error("ERR_OIDC_STATE_MISMATCH");
  if (!code) throw new Error("ERR_OIDC_CODE_MISSING");
  return { code, state };
}

export async function validateIdToken(params: {
  idToken: string;
  config: OidcProviderConfig;
  jwks: JsonWebKeySet;
  expectedNonce: string;
  nowSeconds?: number;
}): Promise<ValidatedOidcToken> {
  if (new TextEncoder().encode(params.idToken).byteLength > MAX_ID_TOKEN_BYTES) throw new Error("ERR_TOKEN_TOO_LARGE");
  const [rawHeader, rawPayload, rawSignature] = params.idToken.split(".");
  if (!rawHeader || !rawPayload || !rawSignature) throw new Error("ERR_TOKEN_MALFORMED");
  const header = parseJwtPart(rawHeader);
  const claims = parseJwtPart(rawPayload);
  if (header.alg !== "RS256") throw new Error("ERR_TOKEN_UNSIGNED_OR_UNSUPPORTED");
  if (typeof header.kid !== "string" || !header.kid.trim()) throw new Error("ERR_TOKEN_KID_MISSING");
  const key = params.jwks.keys.find((candidate: JsonWebKey & { kid?: string }) => candidate.kid === header.kid);
  if (!key) throw new Error("ERR_JWKS_KEY_NOT_FOUND");
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    base64UrlDecode(rawSignature),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
  );
  if (!valid) throw new Error("ERR_TOKEN_SIGNATURE_INVALID");

  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== params.config.issuer) throw new Error("ERR_TOKEN_ISSUER_INVALID");
  if (!audienceMatches(claims.aud, params.config.audience ?? params.config.client_id)) throw new Error("ERR_TOKEN_AUDIENCE_INVALID");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("ERR_TOKEN_EXPIRED");
  if (claims.nonce !== params.expectedNonce) throw new Error("ERR_TOKEN_NONCE_MISMATCH");
  if (params.config.tenant_id && claims.tid !== params.config.tenant_id) throw new Error("ERR_TOKEN_TENANT_INVALID");
  const email = stringClaim(claims, "email") ?? stringClaim(claims, "preferred_username") ?? stringClaim(claims, "upn");
  const userId = stringClaim(claims, "sub") ?? stringClaim(claims, "oid");
  if (!email) throw new Error("ERR_TOKEN_EMAIL_MISSING");
  if (!userId) throw new Error("ERR_TOKEN_SUBJECT_MISSING");
  if (params.config.tenant_id && !stringClaim(claims, "tid")) throw new Error("ERR_TOKEN_TENANT_MISSING");

  const role = mapRoleFromClaims(claims, params.config.group_role_map ?? {});
  const login = new Date((claims.iat && typeof claims.iat === "number" ? claims.iat : now) * 1000).toISOString();
  const expiry = new Date(claims.exp * 1000).toISOString();
  return {
    claims,
    session: {
      user_id: userId,
      display_name: stringClaim(claims, "name") ?? email,
      email,
      tenant_id: stringClaim(claims, "tid") ?? params.config.tenant_id ?? "unknown",
      provider: params.config.provider,
      role,
      login_time: login,
      session_expiry: expiry
    }
  };
}

export function mapRoleFromClaims(claims: Record<string, unknown>, groupRoleMap: Record<string, AuthRole>): AuthRole {
  const direct = stringClaim(claims, "mnde_role")?.toUpperCase();
  if (direct && isRole(direct)) return direct;
  const groups = Array.isArray(claims.groups) ? claims.groups.filter((group): group is string => typeof group === "string") : [];
  for (const group of groups) {
    const role = groupRoleMap[group];
    if (role) return role;
  }
  return "VIEWER";
}

function validateProviderDocument(provider: OidcProviderConfig["provider"], input: unknown, errors: string[], label: "entra" | "okta"): OidcReadiness {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    errors.push(`ERR_AUTH_CONFIG_INVALID:${label}`);
    return { provider, configured: false, errors: [`ERR_AUTH_CONFIG_INVALID:${label}`] };
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_PROVIDER_KEYS.has(key)) errors.push(`ERR_AUTH_CONFIG_INVALID:${label}.${key}`);
  }
  const nestedProvider = raw.provider === undefined ? provider : normalizeProvider(raw.provider);
  if (nestedProvider !== provider) errors.push("ERR_AUTH_PROVIDER_UNSUPPORTED");
  const config: Partial<OidcProviderConfig> = {
    provider,
    issuer: stringValue(raw.issuer),
    client_id: stringValue(raw.client_id),
    redirect_uri: stringValue(raw.redirect_uri),
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((scope): scope is string => typeof scope === "string") : undefined,
    audience: stringValue(raw.audience),
    tenant_id: stringValue(raw.tenant_id),
    group_role_map: isRoleMap(raw.group_role_map) ? raw.group_role_map : undefined
  };
  if (raw.group_role_map !== undefined && !isRoleMap(raw.group_role_map)) errors.push(`ERR_AUTH_CONFIG_INVALID:${label}.group_role_map`);
  const readiness = validateOidcConfig(config);
  errors.push(...readiness.errors);
  return readiness;
}

function normalizeProvider(value: unknown): OidcProviderConfig["provider"] | undefined {
  if (value === "entra" || value === "microsoft_entra") return "microsoft_entra";
  if (value === "okta") return "okta";
  return undefined;
}

function isHttpsUrl(value?: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isLoopbackRedirect(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "localhost" && url.port === "8788" && url.pathname === "/callback" && !url.pathname.includes("*");
  } catch {
    return false;
  }
}

function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRoleMap(value: unknown): value is Record<string, AuthRole> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((role) => typeof role === "string" && isRole(role));
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function isRole(value: string): value is AuthRole {
  return ["ADMIN", "OPERATOR", "AUDITOR", "VIEWER"].includes(value);
}

function stringClaim(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function audienceMatches(actual: unknown, expected: string): boolean {
  if (typeof actual === "string") return actual === expected;
  return Array.isArray(actual) && actual.includes(expected);
}

function parseJwtPart(part: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
  } catch {
    throw new Error("ERR_TOKEN_MALFORMED");
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
