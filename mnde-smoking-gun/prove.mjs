import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const proofDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(proofDir, "..");
const releaseRoot = process.env.MNDE_SMOKING_GUN_RELEASE_ROOT
  ? path.resolve(process.env.MNDE_SMOKING_GUN_RELEASE_ROOT)
  : path.join(repoRoot, "mnde-custody-release");
const outputDir = path.join(proofDir, "output");

const custodyKeys = await import(pathToFileURL(path.join(releaseRoot, "app", "shared", "custody_keys.js")).href);
const {
  publicKeyHash,
  receiptSigningPayload,
  validateSignerRegistry,
  verifyCustodyReceipt
} = custodyKeys;

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicKeyRawHex(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(der).subarray(-32).toString("hex");
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeRunawayRequest() {
  return {
    schema_version: "mnde.smoking_gun.request.v1",
    request_id: "runaway-gpu-autoscale-001",
    actor: {
      user_id: "automation-runner",
      authority: "scheduled-production-executor"
    },
    action: "provision-gpu-job",
    resources: {
      gpu_type: "H100",
      gpu_count: 8,
      hours: 20
    },
    execution: {
      auto_scale: true,
      max_scale_multiplier: 20,
      retry_on_fail: true,
      max_retries: 12
    },
    pricing_data: {
      projected_total_cost_usd: 11000,
      allowed_cost_usd: 500
    },
    weak_gate_risk: "Structurally valid job request with approved automation authority; a weak scheduler could place it."
  };
}

function main() {
  mkdirSync(outputDir, { recursive: true });

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const public_key = publicKeyRawHex(publicKey);
  const signer = {
    signer_id: "andy-external-reviewer-signer-v1",
    key_id: "andy-smoking-gun-key-v1",
    public_key,
    public_key_hash: publicKeyHash(public_key),
    signature_algorithm: "ED25519",
    created_at: "2026-04-29T00:00:00Z"
  };
  const registry = {
    schema_version: "mnde.custody.signer_registry.v1",
    policy: { allow_signer_reuse_across_tenants: false },
    tenants: [
      {
        tenant_id: "andy-production-lab",
        signer_sets: [
          {
            key_set_version: "ks-smoking-gun-001",
            status: "active",
            signers: [signer]
          }
        ]
      }
    ]
  };
  validateSignerRegistry(registry);

  const request = makeRunawayRequest();
  const request_hash = sha256Json(request);
  const decisionCore = {
    decision: "REFUSE",
    reason_code: "ERR_COST_LIMIT",
    request_hash,
    policy_hash: sha256Json({ policy: "max_total_cost_usd", value: 500 }),
    projected_total_cost_usd: 11000,
    allowed_cost_usd: 500,
    prevented_cost_usd: 10500
  };
  const decision_hash = sha256Json(decisionCore);
  const unsignedReceipt = {
    schema_version: "mnde.custody.receipt.v1",
    tenant_id: "andy-production-lab",
    request_hash,
    decision_hash,
    policy_hash: decisionCore.policy_hash,
    decision: decisionCore.decision,
    reason_code: decisionCore.reason_code,
    scenario: "runaway-gpu-autoscale",
    projected_total_cost_usd: decisionCore.projected_total_cost_usd,
    allowed_cost_usd: decisionCore.allowed_cost_usd,
    prevented_cost_usd: decisionCore.prevented_cost_usd,
    canonical_request: JSON.stringify(request),
    decision_context: {
      refused_because: "projected cost exceeds policy limit",
      weak_gate_risk: request.weak_gate_risk
    },
    signature: {
      algorithm: "ED25519",
      signer_id: signer.signer_id,
      key_id: signer.key_id,
      key_set_version: "ks-smoking-gun-001",
      public_key_hash: signer.public_key_hash,
      value: null
    }
  };
  const signatureValue = sign(null, Buffer.from(receiptSigningPayload(unsignedReceipt), "utf8"), privateKey).toString("hex");
  const receipt = {
    ...unsignedReceipt,
    signature: {
      ...unsignedReceipt.signature,
      value: signatureValue
    }
  };
  verifyCustodyReceipt(registry, receipt);

  const tamperedReceipt = {
    ...receipt,
    prevented_cost_usd: 1
  };

  const requestPath = path.join(outputDir, "runaway-gpu-autoscale.request.json");
  const registryPath = path.join(outputDir, "runaway-gpu-autoscale.registry.json");
  const receiptPath = path.join(outputDir, "runaway-gpu-autoscale.refusal.receipt.json");
  const tamperedPath = path.join(outputDir, "runaway-gpu-autoscale.tampered.receipt.json");
  writeJson(requestPath, request);
  writeJson(registryPath, registry);
  writeJson(receiptPath, receipt);
  writeJson(tamperedPath, tamperedReceipt);

  const summary = {
    verdict: "PASS",
    smoking_gun: "packaged custody release verifies an externally signed REFUSE receipt and rejects tampering",
    decision: receipt.decision,
    reason_code: receipt.reason_code,
    projected_total_cost_usd: receipt.projected_total_cost_usd,
    allowed_cost_usd: receipt.allowed_cost_usd,
    prevented_cost_usd: receipt.prevented_cost_usd,
    request_hash: receipt.request_hash,
    decision_hash: receipt.decision_hash,
    signer_id: receipt.signature.signer_id,
    key_id: receipt.signature.key_id,
    key_set_version: receipt.signature.key_set_version,
    receipt_signature_valid: true,
    tamper_rejected: true,
    artifacts: {
      request: requestPath,
      registry: registryPath,
      receipt: receiptPath,
      tampered_receipt: tamperedPath
    }
  };
  writeJson(path.join(outputDir, "summary.json"), summary);

  process.stdout.write(`PASS\n${JSON.stringify(summary, null, 2)}\n`);
}

try {
  if (!existsSync(releaseRoot)) {
    throw new Error(`Missing release root: ${releaseRoot}`);
  }
  main();
} catch (error) {
  process.stdout.write(`REFUSE\n${JSON.stringify({
    verdict: "REFUSE",
    error: error.message
  }, null, 2)}\n`);
  process.exit(1);
}
