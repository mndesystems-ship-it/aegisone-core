import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveRepoRoot, resolveProductionApiTestPath, verifySidecarIdentity } from "../scripts/verify_desktop_production_ready.mjs";

test("production verifier resolves repo files without an absolute INsol path assumption", () => {
  const repoRoot = resolveRepoRoot(new URL("../scripts/verify_desktop_production_ready.mjs", import.meta.url));
  const apiTestPath = resolveProductionApiTestPath(repoRoot);
  assert.match(apiTestPath, /scripts[\\/]test_desktop_production_api\.mjs$/);
  assert.equal(apiTestPath.includes(`${repoRoot}${repoRoot.includes("\\") ? "\\INsol\\" : "/INsol/"}`), false);
});

test("production verifier rejects sidecars that cannot prove repo-local identity", async () => {
  await assert.rejects(
    () => verifySidecarIdentity({
      baseUrl: "http://127.0.0.1:8787",
      repoRoot: "C:\\expected\\repo",
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    }),
    /ERR_UNTRUSTED_SIDECAR_INSTANCE/
  );
});

test("production verifier accepts sidecars that report the expected repo root", async () => {
  const repoRoot = process.cwd();
  await verifySidecarIdentity({
    baseUrl: "http://127.0.0.1:8787",
    repoRoot,
    fetchImpl: async () => new Response(JSON.stringify({ repo_root: repoRoot, process_id: 1234 }), { status: 200 })
  });
});
