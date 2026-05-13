import { createHash, createPublicKey, verify } from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const CUSTODY_ERRORS = Object.freeze({
  unknownSigner: "ERR_UNKNOWN_SIGNER",
  unknownKeySetVersion: "ERR_UNKNOWN_KEY_SET_VERSION",
  keyReuseAcrossTenants: "ERR_KEY_REUSE_ACROSS_TENANTS",
  publicKeyHashCollision: "ERR_PUBLIC_KEY_HASH_COLLISION",
  signerCollision: "ERR_SIGNER_COLLISION",
  internalSigningDisabled: "ERR_INTERNAL_SIGNING_DISABLED",
  receiptKeyResolutionFailed: "ERR_RECEIPT_KEY_RESOLUTION_FAILED",
  missingVersion: "ERR_UNKNOWN_KEY_SET_VERSION",
  ambiguousKeyResolution: "ERR_RECEIPT_KEY_RESOLUTION_FAILED",
  invalidRegistry: "ERR_CUSTODY_REGISTRY_INVALID",
  noActiveSigner: "ERR_CUSTODY_NO_ACTIVE_SIGNER"
});

export function custodyError(code, message, details = {}) {
  const error = new Error(message) ;
  error.code = code;
  error.details = details;
  return error;
}

export function canonicalizeJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw custodyError(CUSTODY_ERRORS.invalidRegistry, "Unsupported JSON number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(",")}}`;
  }
  throw custodyError(CUSTODY_ERRORS.invalidRegistry, "Unsupported JSON value");
}

export function publicKeyHash(publicKey) {
  if (typeof publicKey !== "string" || !/^[0-9a-fA-F]{64}$/.test(publicKey)) {
    throw custodyError(CUSTODY_ERRORS.invalidRegistry, "public_key must be 32-byte hex");
  }
  return createHash("sha256").update(Buffer.from(publicKey, "hex")).digest("hex");
}

export function publicKeyObjectFromRawHex(publicKey) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, "hex")]),
    format: "der",
    type: "spki"
  });
}

function normalizeSigner(tenant, signerSet, signer) {
  if (!tenant.tenant_id || !signer.signer_id || !signer.key_id || !signerSet.key_set_version) {
    throw custodyError(CUSTODY_ERRORS.invalidRegistry, "tenant_id, signer_id, key_id, and key_set_version are required");
  }
  if (signer.private_key || signer.private_key_pem || signer.secret || signer.signing_key) {
    throw custodyError(CUSTODY_ERRORS.internalSigningDisabled, "Private key material is not allowed in custody registry");
  }
  const hash = signer.public_key_hash ?? publicKeyHash(signer.public_key);
  if (signer.public_key && hash !== publicKeyHash(signer.public_key)) {
    throw custodyError(CUSTODY_ERRORS.receiptKeyResolutionFailed, "public_key_hash does not match public_key", {
      tenant_id: tenant.tenant_id,
      signer_id: signer.signer_id,
      key_id: signer.key_id
    });
  }
  return {
    tenant_id: tenant.tenant_id,
    signer_id: signer.signer_id,
    key_id: signer.key_id,
    key_set_version: signerSet.key_set_version,
    key_set_status: signerSet.status ?? "historical",
    signature_algorithm: signer.signature_algorithm ?? "ED25519",
    public_key: signer.public_key,
    public_key_hash: hash,
    created_at: signer.created_at ?? signerSet.created_at ?? "deterministic-custody"
  };
}

export function validateSignerRegistry(registry) {
  if (!registry || typeof registry !== "object" || !Array.isArray(registry.tenants)) {
    throw custodyError(CUSTODY_ERRORS.invalidRegistry, "registry.tenants must be an array");
  }

  const keyIdOwners = new Map();
  const publicKeyHashOwners = new Map();
  const signerOwners = new Map();
  const identityByHash = new Map();
  const normalized = [];

  for (const tenant of registry.tenants) {
    if (!tenant.tenant_id || !Array.isArray(tenant.signer_sets)) {
      throw custodyError(CUSTODY_ERRORS.invalidRegistry, "each tenant requires tenant_id and signer_sets");
    }

    const tenantSignerIds = new Set();
    const tenantKeySetVersions = new Set();
    let activeSets = 0;

    for (const signerSet of tenant.signer_sets) {
      if (!signerSet.key_set_version || tenantKeySetVersions.has(signerSet.key_set_version)) {
        throw custodyError(CUSTODY_ERRORS.unknownKeySetVersion, "key_set_version is missing or duplicated", {
          tenant_id: tenant.tenant_id,
          key_set_version: signerSet.key_set_version ?? null
        });
      }
      tenantKeySetVersions.add(signerSet.key_set_version);
      if (signerSet.status === "active") activeSets += 1;
      if (!Array.isArray(signerSet.signers) || signerSet.signers.length === 0) {
        throw custodyError(CUSTODY_ERRORS.unknownSigner, "key set must contain at least one signer", {
          tenant_id: tenant.tenant_id,
          key_set_version: signerSet.key_set_version
        });
      }
      if (!signerSet.quorum && signerSet.signers.length !== 1) {
        throw custodyError(CUSTODY_ERRORS.receiptKeyResolutionFailed, "exactly one signer is allowed unless quorum is explicit", {
          tenant_id: tenant.tenant_id,
          key_set_version: signerSet.key_set_version
        });
      }

      for (const signer of signerSet.signers) {
        const entry = normalizeSigner(tenant, signerSet, signer);
        if (tenantSignerIds.has(entry.signer_id)) {
          throw custodyError(CUSTODY_ERRORS.signerCollision, "duplicate signer_id within tenant", {
            tenant_id: entry.tenant_id,
            signer_id: entry.signer_id
          });
        }
        tenantSignerIds.add(entry.signer_id);

        const signerOwner = signerOwners.get(entry.signer_id);
        if (signerOwner && signerOwner !== entry.tenant_id && registry.policy?.allow_signer_reuse_across_tenants !== true) {
          throw custodyError(CUSTODY_ERRORS.signerCollision, "signer_id reuse across tenants is prohibited", {
            signer_id: entry.signer_id,
            first_tenant: signerOwner,
            second_tenant: entry.tenant_id
          });
        }
        signerOwners.set(entry.signer_id, entry.tenant_id);

        const keyOwner = keyIdOwners.get(entry.key_id);
        if (keyOwner && keyOwner !== entry.tenant_id) {
          throw custodyError(CUSTODY_ERRORS.keyReuseAcrossTenants, "key_id reuse across tenants is prohibited", {
            key_id: entry.key_id,
            first_tenant: keyOwner,
            second_tenant: entry.tenant_id
          });
        }
        keyIdOwners.set(entry.key_id, entry.tenant_id);

        const hashOwner = publicKeyHashOwners.get(entry.public_key_hash);
        if (hashOwner && hashOwner !== entry.tenant_id) {
          throw custodyError(CUSTODY_ERRORS.publicKeyHashCollision, "public key hash reuse across tenants is prohibited", {
            public_key_hash: entry.public_key_hash,
            first_tenant: hashOwner,
            second_tenant: entry.tenant_id
          });
        }
        publicKeyHashOwners.set(entry.public_key_hash, entry.tenant_id);

        const identity = `${entry.tenant_id}/${entry.signer_id}/${entry.key_id}`;
        const priorIdentity = identityByHash.get(entry.public_key_hash);
        if (priorIdentity && priorIdentity !== identity) {
          throw custodyError(CUSTODY_ERRORS.publicKeyHashCollision, "same key hash is referenced under different identities", {
            public_key_hash: entry.public_key_hash,
            first_identity: priorIdentity,
            second_identity: identity
          });
        }
        identityByHash.set(entry.public_key_hash, identity);
        normalized.push(entry);
      }
    }

    if (activeSets !== 1) {
      throw custodyError(CUSTODY_ERRORS.noActiveSigner, "tenant must have exactly one active signer set", {
        tenant_id: tenant.tenant_id,
        active_sets: activeSets
      });
    }
  }

  return normalized;
}

export function resolveReceiptSigner(registry, receipt) {
  const entries = validateSignerRegistry(registry);
  const metadata = receipt?.signature;
  if (!receipt?.tenant_id || !metadata?.key_set_version) {
    throw custodyError(CUSTODY_ERRORS.unknownKeySetVersion, "receipt is missing tenant_id or key_set_version");
  }
  if (!metadata.signer_id || !metadata.key_id || !metadata.public_key_hash || !metadata.algorithm) {
    throw custodyError(CUSTODY_ERRORS.receiptKeyResolutionFailed, "receipt signature metadata is incomplete");
  }
  const matches = entries.filter((entry) =>
    entry.tenant_id === receipt.tenant_id &&
    entry.key_set_version === metadata.key_set_version &&
    entry.signer_id === metadata.signer_id &&
    entry.key_id === metadata.key_id &&
    entry.public_key_hash === metadata.public_key_hash &&
    entry.signature_algorithm === metadata.algorithm
  );
  if (matches.length === 0) {
    const versionExists = entries.some((entry) => entry.tenant_id === receipt.tenant_id && entry.key_set_version === metadata.key_set_version);
    if (!versionExists) {
      throw custodyError(CUSTODY_ERRORS.unknownKeySetVersion, "unknown key_set_version", {
        tenant_id: receipt.tenant_id,
        key_set_version: metadata.key_set_version
      });
    }
    throw custodyError(CUSTODY_ERRORS.unknownSigner, "unknown signer metadata", {
      tenant_id: receipt.tenant_id,
      key_set_version: metadata.key_set_version,
      signer_id: metadata.signer_id,
      key_id: metadata.key_id
    });
  }
  if (matches.length > 1) {
    throw custodyError(CUSTODY_ERRORS.receiptKeyResolutionFailed, "ambiguous receipt key resolution", {
      tenant_id: receipt.tenant_id,
      key_set_version: metadata.key_set_version,
      signer_id: metadata.signer_id,
      key_id: metadata.key_id
    });
  }
  return matches[0];
}

export function receiptSigningPayload(receipt) {
  const { signature: _signature, ...payload } = receipt;
  return canonicalizeJson(payload);
}

export function verifyCustodyReceipt(registry, receipt) {
  const signer = resolveReceiptSigner(registry, receipt);
  const signature = receipt.signature;
  if (signature.algorithm !== "ED25519") {
    throw custodyError(CUSTODY_ERRORS.receiptKeyResolutionFailed, "unsupported signature algorithm", {
      algorithm: signature.algorithm
    });
  }
  const valid = verify(
    null,
    Buffer.from(receiptSigningPayload(receipt), "utf8"),
    publicKeyObjectFromRawHex(signer.public_key),
    Buffer.from(signature.value, "hex")
  );
  if (!valid) {
    throw custodyError(CUSTODY_ERRORS.receiptKeyResolutionFailed, "receipt signature verification failed", {
      tenant_id: receipt.tenant_id,
      key_set_version: signature.key_set_version,
      signer_id: signature.signer_id,
      key_id: signature.key_id
    });
  }
  return {
    ok: true,
    tenant_id: receipt.tenant_id,
    signer_id: signature.signer_id,
    key_id: signature.key_id,
    key_set_version: signature.key_set_version,
    public_key_hash: signature.public_key_hash
  };
}

export function activeSignerForTenant(registry, tenantId) {
  const entries = validateSignerRegistry(registry);
  const active = entries.filter((entry) => entry.tenant_id === tenantId && entry.key_set_status === "active");
  if (active.length !== 1) {
    throw custodyError(CUSTODY_ERRORS.noActiveSigner, "tenant must resolve to exactly one active signer", {
      tenant_id: tenantId,
      active_signers: active.length
    });
  }
  return active[0];
}

export function buildUnsignedCustodyReceipt({ tenant_id, request_hash, decision_hash, policy_hash, decision, reason_code, signer }) {
  return {
    schema_version: "mnde.custody.receipt.v1",
    tenant_id,
    request_hash,
    decision_hash,
    policy_hash,
    decision,
    reason_code,
    signature: {
      algorithm: signer.signature_algorithm,
      signer_id: signer.signer_id,
      key_id: signer.key_id,
      key_set_version: signer.key_set_version,
      public_key_hash: signer.public_key_hash,
      value: null
    }
  };
}
