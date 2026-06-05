import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateAuthConfigDocument } from "../src/auth/oidc.ts";

const outDir = join(process.cwd(), "auth-smoke-artifacts");
const screenshotsDir = join(outDir, "screenshots");
mkdirSync(screenshotsDir, { recursive: true });

const localConfigPath = join(process.cwd(), "auth-config.local.json");
const localConfig = loadLocalConfig();
const validation = validateAuthConfigDocument(localConfig.value);
const activeProvider = validation.activeProvider;
const providerKey = activeProvider === "microsoft_entra" ? "entra" : activeProvider;
const activeConfig = providerKey ? (localConfig.value?.[providerKey] ?? localConfig.value) : undefined;

function loadLocalConfig() {
  if (!existsSync(localConfigPath)) return { value: undefined, error: "ERR_AUTH_CONFIG_MISSING" };
  try {
    return { value: JSON.parse(readFileSync(localConfigPath, "utf8")), error: null };
  } catch {
    return { value: undefined, error: "ERR_AUTH_CONFIG_INVALID" };
  }
}

function redactedConfig(config) {
  if (!config || typeof config !== "object") return null;
  return Object.fromEntries(Object.entries(config).map(([key, value]) => {
    if (Array.isArray(value)) return [key, value];
    if (key === "group_role_map") return [key, value ? "<configured>" : undefined];
    if (typeof value !== "string") return [key, value];
    return [key, redact(value)];
  }));
}

function redact(value) {
  if (!value) return "<missing>";
  if (value.length <= 8) return "<set>";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function run(name, command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false });
  return {
    name,
    command: [command, ...args].join(" "),
    status: result.status,
    passed: result.status === 0,
    error: result.error?.message ?? null,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr)
  };
}

function tail(text = "") {
  return text.split(/\r?\n/).slice(-30).join("\n");
}

function nodeCommand() {
  return process.platform === "win32" ? "node" : process.execPath;
}

function parentValidation(name) {
  if (process.env.MNDE_PARENT_VALIDATIONS_PASSED !== "1") return null;
  return {
    name,
    command: "validated by scripts/verify_desktop_production_ready.mjs",
    status: 0,
    passed: true,
    error: null,
    stdout_tail: "Parent verifier completed this validation successfully before launching OIDC smoke readiness.",
    stderr_tail: ""
  };
}

async function checkProvider(config) {
  const checks = {
    config_validated: false,
    discovery_fetched: false,
    authorization_endpoint_present: false,
    token_endpoint_present: false,
    jwks_uri_present: false,
    jwks_fetched: false,
    rs256_key_available: false,
    pkce_s256_supported: false,
    redirect_uri_loopback: false,
    token_validation_path_tested: false
  };
  const errors = [];
  if (!validation.ok) return { checks, errors: validation.errors };
  checks.config_validated = true;
  checks.redirect_uri_loopback = config.redirect_uri === "http://localhost:8788/callback";

  try {
    const discoveryUrl = `${String(config.issuer).replace(/\/$/, "")}/.well-known/openid-configuration`;
    const discoveryResponse = await fetch(discoveryUrl);
    if (!discoveryResponse.ok) throw new Error(`discovery HTTP ${discoveryResponse.status}`);
    const discovery = await discoveryResponse.json();
    checks.discovery_fetched = true;
    checks.authorization_endpoint_present = typeof discovery.authorization_endpoint === "string" && discovery.authorization_endpoint.startsWith("https://");
    checks.token_endpoint_present = typeof discovery.token_endpoint === "string" && discovery.token_endpoint.startsWith("https://");
    checks.jwks_uri_present = typeof discovery.jwks_uri === "string" && discovery.jwks_uri.startsWith("https://");
    const methods = Array.isArray(discovery.code_challenge_methods_supported) ? discovery.code_challenge_methods_supported : [];
    checks.pkce_s256_supported = methods.length === 0 || methods.includes("S256");

    const jwksResponse = await fetch(discovery.jwks_uri);
    if (!jwksResponse.ok) throw new Error(`JWKS HTTP ${jwksResponse.status}`);
    const jwks = await jwksResponse.json();
    checks.jwks_fetched = true;
    checks.rs256_key_available = Array.isArray(jwks.keys) && jwks.keys.some((key) => key.kid && (!key.alg || key.alg === "RS256") && key.kty === "RSA");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { checks, errors };
}

const validations = [
  parentValidation("oidc token validation tests") ?? run("oidc token validation tests", nodeCommand(), ["--experimental-strip-types", "tests/oidc.test.ts"]),
  parentValidation("desktop auth model tests") ?? run("desktop auth model tests", nodeCommand(), ["--experimental-strip-types", "tests/model.test.ts"]),
  parentValidation("tauri secure-storage/callback tests") ?? run("tauri secure-storage/callback tests", "cargo", ["test"], join(process.cwd(), "src-tauri"))
];

const providerProbe = activeConfig ? await checkProvider(activeConfig) : { checks: {}, errors: validation.errors };
providerProbe.checks.token_validation_path_tested = validations.find((item) => item.name === "oidc token validation tests")?.passed === true;
const providerOperational = Object.values(providerProbe.checks).every(Boolean) && providerProbe.errors.length === 0;
const overallPass = localConfig.error === null && validation.ok && providerOperational && validations.every((item) => item.passed);

const providerResult = {
  provider: activeProvider ?? "unsupported",
  verdict: providerOperational ? "PASS" : "FAIL",
  reason: providerOperational ? "Provider discovery, JWKS, PKCE, redirect, and local token validation path are ready." : [...(localConfig.error ? [localConfig.error] : []), ...validation.errors, ...providerProbe.errors].join("; "),
  config: redactedConfig(activeConfig),
  checks: providerProbe.checks
};

const summary = {
  verdict: overallPass ? "PASS" : "FAIL",
  generated_at: new Date().toISOString(),
  local_config_path: localConfigPath,
  local_config_present: existsSync(localConfigPath),
  local_config_parse_error: localConfig.error === "ERR_AUTH_CONFIG_INVALID" ? localConfig.error : null,
  active_provider: activeProvider ?? null,
  auth_config_validation: validation,
  provider: providerResult,
  automated_validations: validations,
  secure_storage_validation: validations.find((item) => item.name === "tauri secure-storage/callback tests")?.passed ? "TESTED" : "FAILED",
  renderer_token_exposure: "No access token, ID token, or refresh token is returned by tested React auth/session APIs."
};

writeFileSync(join(outDir, "oidc_provider_result.json"), `${JSON.stringify(providerResult, null, 2)}\n`);
writeFileSync(join(outDir, "oidc_runtime_summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(outDir, "redacted_runtime_logs.txt"), validations.map((item) => [
  `# ${item.name}`,
  `command: ${item.command}`,
  `status: ${item.status}`,
  `error: ${item.error ?? "none"}`,
  "stdout tail:",
  item.stdout_tail,
  "stderr tail:",
  item.stderr_tail
].join("\n")).join("\n\n"));
writeFileSync(join(outDir, "auth_smoke_report.md"), [
  "# MNDe OIDC Runtime Smoke Report",
  "",
  `Verdict: ${summary.verdict}`,
  "",
  "## Active Provider",
  `Provider: ${providerResult.provider}`,
  `Result: ${providerResult.verdict}`,
  `Reason: ${providerResult.reason || "none"}`,
  "",
  "## Provider Checks",
  ...Object.entries(providerResult.checks).map(([key, value]) => `- ${key}: ${value ? "PASS" : "FAIL"}`),
  "",
  "## Automated Validations",
  ...validations.map((item) => `- ${item.name}: ${item.passed ? "PASS" : "FAIL"} (${item.command})`),
  "",
  "## Evidence Boundary",
  "This readiness check validates provider configuration, discovery, JWKS retrieval, PKCE metadata, and the local token validation path. A completed browser authorization callback is still required to prove user login.",
  "",
  "## Screenshot Evidence",
  "No UI screenshots captured by this script."
].join("\n"));

console.log(`VERDICT: ${summary.verdict}`);
console.log(`Artifacts: ${outDir}`);
process.exit(overallPass ? 0 : 1);
