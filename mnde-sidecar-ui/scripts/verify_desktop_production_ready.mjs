import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { validateAuthConfigDocument } from "../src/auth/oidc.ts";

const baseUrl = "http://127.0.0.1:8787";
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

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return await response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mnde-authority-context": JSON.stringify(authority) },
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
  const result = await postJson("/receipts/verify", { receipt: { malformed: true } });
  if (result.status === "VALID") throw new Error("malformed receipt returned VALID");
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
  const sidecar = spawnSync(process.execPath, ["--experimental-strip-types", "../INsol/scripts/test_desktop_production_api.mjs"], { stdio: "inherit", shell: false });
  if (sidecar.status !== 0) throw new Error("sidecar production API tests failed");
  const desktop = spawnSync(process.execPath, ["--experimental-strip-types", "tests/model.test.ts"], { stdio: "inherit", shell: false });
  if (desktop.status !== 0) throw new Error("desktop model tests failed");
  const oidc = spawnSync(process.execPath, ["--experimental-strip-types", "tests/oidc.test.ts"], { stdio: "inherit", shell: false });
  if (oidc.status !== 0) throw new Error("OIDC token validation tests failed");
});

await check("OIDC config validation reports fail-closed readiness", async () => {
  if (!existsSync("auth-config.local.json")) throw new Error("ERR_AUTH_CONFIG_MISSING");
  const config = JSON.parse(readFileSync("auth-config.local.json", "utf8"));
  const validation = validateAuthConfigDocument(config);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
});

await check("OIDC smoke readiness passes", async () => {
  const smoke = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/run_oidc_smoke_readiness.mjs"], {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, MNDE_PARENT_VALIDATIONS_PASSED: "1" }
  });
  if (smoke.status !== 0) throw new Error("OIDC smoke readiness failed");
});

if (failures.length > 0) {
  console.log(`VERDICT: FAIL`);
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}

console.log("VERDICT: PASS");
