export const receiptListContract = Object.freeze({
  fields: ["receipt_hash", "decision", "reason_code", "policy_version", "policy_hash", "request_hash"],
});

export const proofPanelContract = Object.freeze({
  fields: [
    "status",
    "policy_version",
    "policy_hash",
    "manifest_path",
    "signature_envelope_path",
    "key_set_version",
    "key_set_path",
    "valid_signatures",
  ],
});

export const bundleContract = Object.freeze({
  fields: ["bundle_version", "generated_at", "root_hash", "receipt_count", "policy_versions", "key_set_versions", "deterministic"],
});
