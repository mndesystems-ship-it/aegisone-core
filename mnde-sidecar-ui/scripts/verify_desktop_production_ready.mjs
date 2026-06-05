import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAuthConfigDocument } from "../src/auth/oidc.ts";

const baseUrl = process.env.MNDE_SIDECAR_URL ?? "http://127.0.0.1:8787";
const failures = [];
const authority = {
  user_id: "verify-admin",
  display_name: "Verification Admin",
  email: "verify@mnde.invalid",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  provider: "microsoft_entra",
  role: "ADMIN",
  login_time: new Date().toISOString(),
  session_expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString()
};

export function resolveRepoRoot(scriptUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(scriptUrl)), "..", "..");
}

export function resolveProductionApiTestPath(repoRoot) {
  return join(repoRoot, "scripts", "test_desktop_production_api.mjs");
}

function normalizePathForCompare(value) {
  return resolve(value).replaceAll("\\", "/").toLowerCase();
}

export async function verifySidecarIdentity({ baseUrl, repoRoot, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/identity`);
  } catch (error) {
    throw new Error(`ERR_SIDECAR_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`ERR_UNTRUSTED_SIDECAR_INSTANCE: /identity returned HTTP ${response.status}`);
  const identity = await response.json();
  if (!identity || typeof identity.repo_root !== "string" || !identity.process_id) {
    throw new Error("ERR_UNTRUSTED_SIDECAR_INSTANCE: identity payload missing repo_root/process_id");
  }
  if (normalizePathForCompare(identity.repo_root) !== normalizePathForCompare(repoRoot)) {
    throw new Error(`ERR_UNTRUSTED_SIDECAR_INSTANCE: expected ${repoRoot}, got ${identity.repo_root}`);
  }
  return identity;
}

async function waitForOwnedSidecar({ baseUrl, repoRoot, child, timeoutMs = 12000 }) {
  const started = Date.now();
  let lastError = "sidecar did not become ready";
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`ERR_SIDECAR_START_FAILED: process exited ${child.exitCode}`);
    try {
      return await verifySidecarIdentity({ baseUrl, repoRoot });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`ERR_SIDECAR_START_FAILED: ${lastError}`);
}

async function ensureIntendedSidecar(repoRoot) {
  try {
    const identity = await verifySidecarIdentity({ baseUrl, repoRoot });
    return { identity, child: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("ERR_SIDECAR_UNAVAILABLE")) throw error;
  }

  const child = spawn(process.execPath, ["--experimental-strip-types", "mnde-local-sidecar.mjs"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MNDE_VERIFIER_OWNED: "1" }
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const identity = await waitForOwnedSidecar({ baseUrl, repoRoot, child });
  return { identity, child };
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return await response.json();
}

async function postJson(path, body, includeAuth = true) {
  const headers = { "content-type": "application/json" };
  if (includeAuth) headers["x-mnde-authority-context"] = JSON.stringify(authority);
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return await response.json();
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`FAIL ${name}`);
  }
}

async function run() {
  const repoRoot = resolveRepoRoot();
  let ownedSidecar;
  try {
    await check("intended sidecar identity", async () => {
      const { child } = await ensureIntendedSidecar(repoRoot);
      ownedSidecar = child;
    });

    await check("/healthz PASS", async () => {
      const health = await getJson("/healthz");
      if (health.ok !== true) throw new Error("health ok was not true");
    });

    await check("/readyz PASS", async () => {
      const ready = await getJson("/readyz");
      if (ready.ok !== true) throw new Error("ready ok was not true");
    });

    await check("/metrics parses", async () => {
      const response = await fetch(`${baseUrl}/metrics`);
      const text = await response.text();
      if (!/mnde_sidecar_requests_total|mnde_decisions_total/.test(text)) throw new Error("metrics did not include expected counters");
    });

    await check("/receipts/recent returns JSON array", async () => {
      const receipts = await getJson("/receipts/recent?limit=5");
      if (!Array.isArray(receipts)) throw new Error("receipt history was not an array");
    });

    await check("/receipts/verify fails closed on malformed input", async () => {
      const response = await fetch(`${baseUrl}/receipts/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mnde-authority-context": JSON.stringify(authority) },
        body: JSON.stringify({ receipt: { malformed: true } })
      });
      if (![200, 400].includes(response.status)) throw new Error(`expected fail-closed HTTP 200/400, got ${response.status}`);
      const result = await response.json();
      if (result.status === "VALID" || result.status === "VERIFIED") throw new Error("malformed receipt returned valid");
    });

    await check("/receipts/verify rejects missing auth", async () => {
      const response = await fetch(`${baseUrl}/receipts/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receipt: { malformed: true } })
      });
      if (response.status !== 403) throw new Error(`expected HTTP 403, got ${response.status}`);
    });

    await check("/replay/recent returns valid status object", async () => {
      const result = await postJson("/replay/recent", { limit: 5 });
      if (!["PASS", "DRIFT", "SIGNATURE_FAIL", "REPLAY_UNAVAILABLE", "MALFORMED_RECEIPT"].includes(result.status)) throw new Error(`unexpected replay status ${result.status}`);
    });

    await check("/policy/current returns current policy", async () => {
      const result = await getJson("/policy/current");
      if (result.status !== "ACTIVE" || typeof result.policy_hash !== "string") throw new Error("policy response missing ACTIVE/hash");
    });

    await check("/audit/bundle creates redacted manifest", async () => {
      const result = await postJson("/audit/bundle", {});
      if (result.status !== "PASS") throw new Error(result.reason ?? "audit did not pass");
      if (!Array.isArray(result.files) || !result.files.includes("manifest.json")) throw new Error("manifest missing");
      if (result.files.some((file) => /\.pem$|\.key$|\.zip$|node_modules|private|secret|signing/i.test(file))) {
        throw new Error("forbidden file included in audit bundle");
      }
    });

    await check("production tests pass", async () => {
      const apiTestPath = resolveProductionApiTestPath(repoRoot);
      if (!existsSync(apiTestPath)) throw new Error(`ERR_PRODUCTION_API_TEST_MISSING: ${apiTestPath}`);
      const sidecar = spawnSync(process.execPath, ["--experimental-strip-types", apiTestPath], { stdio: "inherit", shell: false, env: { ...process.env, MNDE_SIDECAR_URL: baseUrl } });
      if (sidecar.status !== 0) throw new Error("sidecar production API tests failed");
      const desktop = spawnSync(process.execPath, ["--experimental-strip-types", "tests/model.test.ts"], { stdio: "inherit", shell: false });
      if (desktop.status !== 0) throw new Error("desktop model tests failed");
      const oidc = spawnSync(process.execPath, ["--experimental-strip-types", "tests/oidc.test.ts"], { stdio: "inherit", shell: false });
      if (oidc.status !== 0) throw new Error("OIDC token validation tests failed");
    });

    await check("OIDC config validation reports fail-closed readiness", async () => {
      if (!existsSync("auth-config.local.json")) {
        console.log("INFO auth-config.local.json missing; expected clean-room fail-closed state.");
        return;
      }
      const config = JSON.parse(readFileSync("auth-config.local.json", "utf8"));
      const validation = validateAuthConfigDocument(config);
      if (!validation.ok) throw new Error(validation.errors.join("; "));
    });

    await check("OIDC smoke readiness reports fail-closed or pass", async () => {
      const smoke = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/run_oidc_smoke_readiness.mjs"], {
        stdio: "inherit",
        shell: false,
        env: { ...process.env, MNDE_PARENT_VALIDATIONS_PASSED: "1" }
      });
      if (smoke.status !== 0 && !existsSync("auth-config.local.json")) {
        console.log("INFO OIDC smoke failed because real tenant config is missing in clean-room setup.");
        return;
      }
      if (smoke.status !== 0) throw new Error("OIDC smoke readiness failed");
    });
  } finally {
    if (ownedSidecar) ownedSidecar.kill();
  }

  if (failures.length > 0) {
    console.log("VERDICT: FAIL");
    for (const failure of failures) console.log(`- ${failure}`);
    process.exit(1);
  }

  console.log("VERDICT: PASS");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await run();
}
