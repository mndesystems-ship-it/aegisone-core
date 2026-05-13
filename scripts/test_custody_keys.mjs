import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activeSignerForTenant,
  buildUnsignedCustodyReceipt,
  CUSTODY_ERRORS,
  publicKeyHash,
  receiptSigningPayload,
  validateSignerRegistry,
  verifyCustodyReceipt
} from "../shared/custody_keys.js";
import { scanForbiddenContent } from "../shared/forbidden_content.js";
import { signInternally } from "../custody/runtime.ts";
import { runCustodyTimeoutHarness } from "./custody_timeout_harness.mjs";

function publicKeyRawHex(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(der).subarray(-32).toString("hex");
}

function makeExternalSigner(name) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const public_key = publicKeyRawHex(publicKey);
  return {
    privateKey,
    signer: {
      signer_id: `${name}-signer`,
      key_id: `${name}-key`,
      public_key,
      public_key_hash: publicKeyHash(public_key),
      signature_algorithm: "ED25519"
    }
  };
}

function registryFor(tenantId, signer, version = "ks-001", status = "active") {
  return {
    schema_version: "mnde.custody.signer_registry.v1",
    tenants: [
      {
        tenant_id: tenantId,
        signer_sets: [
          {
            key_set_version: version,
            status,
            signers: [signer]
          }
        ]
      }
    ]
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

function issue(registry, tenantId, externalSigner, suffix) {
  const signer = activeSignerForTenant(registry, tenantId);
  const receipt = buildUnsignedCustodyReceipt({
    tenant_id: tenantId,
    request_hash: `request-${suffix}`.padEnd(64, "0").slice(0, 64),
    decision_hash: `decision-${suffix}`.padEnd(64, "0").slice(0, 64),
    policy_hash: "policy".padEnd(64, "0"),
    decision: "ALLOW",
    reason_code: "OK_ALLOW",
    signer
  });
  return {
    ...receipt,
    signature: {
      ...receipt.signature,
      value: sign(null, Buffer.from(receiptSigningPayload(receipt), "utf8"), externalSigner.privateKey).toString("hex")
    }
  };
}

function testInternalSigningDisabled() {
  expectCode(() => signInternally(), CUSTODY_ERRORS.internalSigningDisabled);
}

function testTenantIsolationFailures() {
  const a = makeExternalSigner("a");
  const b = makeExternalSigner("b");
  expectCode(() => validateSignerRegistry({
    tenants: [{
      tenant_id: "tenant-a",
      signer_sets: [
        { key_set_version: "ks-1", status: "active", signers: [a.signer] },
        { key_set_version: "ks-2", status: "historical", signers: [{ ...b.signer, signer_id: a.signer.signer_id }] }
      ]
    }]
  }), CUSTODY_ERRORS.signerCollision);

  expectCode(() => validateSignerRegistry({
    tenants: [
      { tenant_id: "tenant-a", signer_sets: [{ key_set_version: "ks-a", status: "active", signers: [a.signer] }] },
      { tenant_id: "tenant-b", signer_sets: [{ key_set_version: "ks-b", status: "active", signers: [{ ...b.signer, key_id: a.signer.key_id }] }] }
    ]
  }), CUSTODY_ERRORS.keyReuseAcrossTenants);

  expectCode(() => validateSignerRegistry({
    tenants: [
      { tenant_id: "tenant-a", signer_sets: [{ key_set_version: "ks-a", status: "active", signers: [a.signer] }] },
      { tenant_id: "tenant-b", signer_sets: [{ key_set_version: "ks-b", status: "active", signers: [{ ...b.signer, public_key: a.signer.public_key, public_key_hash: a.signer.public_key_hash }] }] }
    ]
  }), CUSTODY_ERRORS.publicKeyHashCollision);
}

function testRotationVerification() {
  const oldSigner = makeExternalSigner("tenant-a-v1");
  const newSigner = makeExternalSigner("tenant-a-v2");
  const beforeRegistry = {
    tenants: [{
      tenant_id: "tenant-a",
      signer_sets: [
        { key_set_version: "ks-old", status: "active", signers: [oldSigner.signer] },
        { key_set_version: "ks-new", status: "pending", signers: [newSigner.signer] }
      ]
    }]
  };
  const oldReceipt = issue(beforeRegistry, "tenant-a", oldSigner, "old");
  const afterRegistry = {
    tenants: [{
      tenant_id: "tenant-a",
      signer_sets: [
        { key_set_version: "ks-old", status: "historical", signers: [oldSigner.signer] },
        { key_set_version: "ks-new", status: "active", signers: [newSigner.signer] }
      ]
    }]
  };
  const newReceipt = issue(afterRegistry, "tenant-a", newSigner, "new");
  assert.equal(verifyCustodyReceipt(afterRegistry, oldReceipt).key_set_version, "ks-old");
  assert.equal(verifyCustodyReceipt(afterRegistry, newReceipt).key_set_version, "ks-new");

  const unknownVersion = { ...oldReceipt, signature: { ...oldReceipt.signature, key_set_version: "ks-missing" } };
  expectCode(() => verifyCustodyReceipt(afterRegistry, unknownVersion), CUSTODY_ERRORS.unknownKeySetVersion);

  const ambiguousRegistry = {
    tenants: [
      { tenant_id: "tenant-a", signer_sets: [{ key_set_version: "ks-old", status: "active", signers: [oldSigner.signer] }] },
      { tenant_id: "tenant-a", signer_sets: [{ key_set_version: "ks-old", status: "active", signers: [oldSigner.signer] }] }
    ]
  };
  expectCode(() => verifyCustodyReceipt(ambiguousRegistry, oldReceipt), CUSTODY_ERRORS.receiptKeyResolutionFailed);
}

function testProductionPathHasNoForbiddenContent() {
  const releaseDir = path.resolve("mnde-custody-release");
  if (!existsSync(releaseDir)) return;
  assert.deepEqual(scanForbiddenContent(releaseDir), []);
}

async function testSignerTimeoutArtifacts() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnde-custody-timeout-"));
  try {
    const result = await runCustodyTimeoutHarness(root, { signer_timeout_ms: 5, signer_delay_ms: 15 });
    assert.equal(result.receipt.decision, "REFUSE");
    assert.equal(result.receipt.reason_code, "ERR_CUSTODY_SIGNER_TIMEOUT");
    assert.equal(result.summary.signer_timeouts, 1);
    assert.equal(result.summary.signer_late_responses, 1);
    assert.equal(result.summary.late_response_upgrades, 0);
    assert.equal(result.summary.unsigned_allows, 0);
    assert.equal(existsSync(path.join(root, "custody-timeout-receipt.json")), true);
    assert.equal(existsSync(path.join(root, "custody-late-response-log.json")), true);
    assert.equal(existsSync(path.join(root, "custody-timeout-summary.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testPackageScanRejectsSigningMaterial() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnde-forbidden-"));
  try {
    writeFileSync(path.join(root, "internal-signer.js"), "const SIGNING_SECRET = 'bad'; createHmac('sha256', SIGNING_SECRET);\n");
    const offenders = scanForbiddenContent(root);
    assert.equal(offenders.length > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

testInternalSigningDisabled();
testTenantIsolationFailures();
testRotationVerification();
testProductionPathHasNoForbiddenContent();
await testSignerTimeoutArtifacts();
testPackageScanRejectsSigningMaterial();
process.stdout.write("PASS custody key tests\n");
