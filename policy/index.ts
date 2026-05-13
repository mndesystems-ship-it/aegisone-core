import { createPublicKey, verify } from "crypto";
import { canonicalizeJson, hashCanonicalJson, sha256Hex } from "../shared/index.ts";
import type { PolicyObject, RequestObject } from "../shared/types.ts";
import type { PolicyTrustResult } from "./types.ts";

const PINNED_POLICY_SCHEMA_VERSION = "mnde.policy.v1";
const PINNED_KEY_VERSION = "ed25519.v1";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ALLOWED_REQUEST_KEYS = [
  "actor",
  "execution",
  "orbit_intent",
  "pricing",
  "release_request",
  "request_id",
  "resources",
  "runtime_request",
  "schema_version",
  "submitted_region"
] as const;

function buildPolicyPayload(policyObject: PolicyObject) {
  return {
    schema_version: policyObject.schema_version,
    policy_version: policyObject.policy_version,
    allowed_request_keys: [...policyObject.allowed_request_keys].sort(),
    rules: policyObject.rules
  };
}

function toPublicKeyObject(publicKeyHex: string) {
  const rawKey = Buffer.from(publicKeyHex, "hex");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
    format: "der",
    type: "spki"
  });
}

function keyIdFromPublicKey(publicKeyHex: string): string {
  return sha256Hex(Buffer.from(publicKeyHex, "hex")).slice(0, 16);
}

export function verifyPolicyTrust(
  policyObject: PolicyObject,
  requestObject: RequestObject,
  pinnedPolicyVersion: string
): PolicyTrustResult {
  const reasons: string[] = [];
  const policyPayload = buildPolicyPayload(policyObject);
  const policyHash = hashCanonicalJson(policyPayload as unknown as import("../shared/json.ts").JsonValue);

  if (policyObject.schema_version !== PINNED_POLICY_SCHEMA_VERSION) {
    reasons.push(`policy.schema_version=${policyObject.schema_version} does not match ${PINNED_POLICY_SCHEMA_VERSION}`);
  }
  if (policyObject.policy_version !== pinnedPolicyVersion) {
    reasons.push(`policy.policy_version=${policyObject.policy_version} does not match pinned version ${pinnedPolicyVersion}`);
  }
  if (policyObject.trust.key_version !== PINNED_KEY_VERSION) {
    reasons.push(`policy.trust.key_version=${policyObject.trust.key_version} does not match ${PINNED_KEY_VERSION}`);
  }

  const allowedKeyUniverse = new Set<string>(ALLOWED_REQUEST_KEYS);
  const dedupedAllowedKeys = new Set(policyObject.allowed_request_keys);
  if (dedupedAllowedKeys.size !== policyObject.allowed_request_keys.length) {
    reasons.push("policy.allowed_request_keys contains duplicates");
  }
  for (const key of policyObject.allowed_request_keys) {
    if (!allowedKeyUniverse.has(key)) {
      reasons.push(`policy.allowed_request_keys contains unsupported key ${key}`);
    }
  }
  for (const key of Object.keys(requestObject)) {
    if (!dedupedAllowedKeys.has(key)) {
      reasons.push(`request_object key ${key} is not allowed by policy.allowed_request_keys`);
    }
  }

  const derivedKeyId = keyIdFromPublicKey(policyObject.trust.signing_public_key);
  if (derivedKeyId !== policyObject.trust.key_id) {
    reasons.push(`policy.trust.key_id=${policyObject.trust.key_id} does not match derived key id ${derivedKeyId}`);
  }

  try {
    const ok = verify(
      null,
      Buffer.from(canonicalizeJson(policyPayload as unknown as import("../shared/json.ts").JsonValue), "utf8"),
      toPublicKeyObject(policyObject.trust.signing_public_key),
      Buffer.from(policyObject.trust.signature, "hex")
    );
    if (!ok) {
      reasons.push("policy signature verification failed");
    }
  } catch {
    reasons.push("policy signature verification raised an error");
  }

  return {
    trusted: reasons.length === 0,
    policy_hash: policyHash,
    reasons,
    key_id: policyObject.trust.key_id,
    policy_version: policyObject.policy_version
  };
}
