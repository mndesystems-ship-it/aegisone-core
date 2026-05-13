import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeSignerForTenant,
  buildUnsignedCustodyReceipt,
  publicKeyHash,
  receiptSigningPayload,
  validateSignerRegistry,
  verifyCustodyReceipt
} from "../app/shared/custody_keys.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(process.argv[2] ?? path.join(__dirname, "..", "custody-rotation-output"));
const tenant_id = "tenant-a";

function publicKeyRawHex(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(der).subarray(-32).toString("hex");
}

function makeExternalSigner(label) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const public_key = publicKeyRawHex(publicKey);
  return {
    privateKey,
    public_key,
    registrySigner: {
      signer_id: `tenant-a-signer-${label}`,
      key_id: `tenant-a-key-${label}`,
      public_key,
      public_key_hash: publicKeyHash(public_key),
      signature_algorithm: "ED25519",
      created_at: `2026-04-23T00:00:0${label === "v1" ? "1" : "2"}Z`
    }
  };
}

function registryFor(oldSigner, newSigner, activeVersion) {
  return {
    schema_version: "mnde.custody.signer_registry.v1",
    policy: { allow_signer_reuse_across_tenants: false },
    tenants: [
      {
        tenant_id,
        signer_sets: [
          {
            key_set_version: "ks-tenant-a-001",
            status: activeVersion === "ks-tenant-a-001" ? "active" : "historical",
            signers: [oldSigner.registrySigner]
          },
          {
            key_set_version: "ks-tenant-a-002",
            status: activeVersion === "ks-tenant-a-002" ? "active" : "pending",
            signers: [newSigner.registrySigner]
          }
        ]
      }
    ]
  };
}

function hashLabel(label) {
  return createHash("sha256").update(label).digest("hex");
}

function issueReceipt(registry, externalSigner, label) {
  const signer = activeSignerForTenant(registry, tenant_id);
  const unsigned = buildUnsignedCustodyReceipt({
    tenant_id,
    request_hash: hashLabel(`request-${label}`),
    decision_hash: hashLabel(`decision-${label}`),
    policy_hash: hashLabel("policy-v1"),
    decision: "ALLOW",
    reason_code: "OK_ALLOW",
    signer
  });
  const signatureValue = sign(null, Buffer.from(receiptSigningPayload(unsigned), "utf8"), externalSigner.privateKey).toString("hex");
  return {
    ...unsigned,
    signature: {
      ...unsigned.signature,
      value: signatureValue
    }
  };
}

function main() {
  mkdirSync(outputDir, { recursive: true });
  const oldSigner = makeExternalSigner("v1");
  const newSigner = makeExternalSigner("v2");
  const beforeRegistry = registryFor(oldSigner, newSigner, "ks-tenant-a-001");
  validateSignerRegistry(beforeRegistry);
  const beforeReceipt = issueReceipt(beforeRegistry, oldSigner, "before-rotation");

  const afterRegistry = registryFor(oldSigner, newSigner, "ks-tenant-a-002");
  validateSignerRegistry(afterRegistry);
  const afterReceipt = issueReceipt(afterRegistry, newSigner, "after-rotation");

  const beforeVerification = verifyCustodyReceipt(afterRegistry, beforeReceipt);
  const afterVerification = verifyCustodyReceipt(afterRegistry, afterReceipt);

  const registryPath = path.join(outputDir, "tenant-a-registry-after-rotation.json");
  const beforePath = path.join(outputDir, "tenant-a-receipt-before-rotation.json");
  const afterPath = path.join(outputDir, "tenant-a-receipt-after-rotation.json");
  writeFileSync(registryPath, `${JSON.stringify(afterRegistry, null, 2)}\n`, "utf8");
  writeFileSync(beforePath, `${JSON.stringify(beforeReceipt, null, 2)}\n`, "utf8");
  writeFileSync(afterPath, `${JSON.stringify(afterReceipt, null, 2)}\n`, "utf8");

  const output = {
    verdict: "PASS",
    tenant_id,
    old_key_set_version: beforeVerification.key_set_version,
    new_key_set_version: afterVerification.key_set_version,
    old_receipt_verification: "PASS",
    new_receipt_verification: "PASS",
    registry: registryPath,
    before_rotation_receipt: beforePath,
    after_rotation_receipt: afterPath
  };
  process.stdout.write(`PASS\n${JSON.stringify(output, null, 2)}\n`);
}

main();
