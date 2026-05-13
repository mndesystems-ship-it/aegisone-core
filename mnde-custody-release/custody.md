# Purpose
MNDe custody mode verifies customer-owned signer identities and receipts without holding private signing keys. The production package contains public-key validation, receipt verification, and startup guards only.

# What customer owns
The customer generates and stores private keys outside MNDe, for example in an HSM, KMS, vault, or operator-controlled signing service. The customer also owns tenant IDs, signer IDs, key IDs, and rotation approval.

# What MNDe does
MNDe receives a signer registry containing `tenant_id`, `signer_id`, `key_id`, `public_key`, `public_key_hash`, `key_set_version`, and `status`. MNDe validates tenant isolation, selects signer material from receipt metadata, and verifies signatures with public keys.

# What MNDe never stores
MNDe never imports, generates, persists, or bundles private keys. MNDe never signs internally in production. Any internal signing attempt fails with `ERR_INTERNAL_SIGNING_DISABLED`.

# Signer enrollment steps
1. Customer generates an Ed25519 key outside MNDe.
2. Customer exports only the 32-byte public key hex.
3. Customer adds a signer entry to the registry:
```json
{"tenant_id":"tenant-a","signer_sets":[{"key_set_version":"ks-001","status":"active","signers":[{"signer_id":"signer-a-v1","key_id":"tenant-a-key-v1","public_key":"<64 hex>","public_key_hash":"<sha256 public key hex>"}]}]}
```
4. Run `bin\preflight-check.cmd`; enrollment fails closed on duplicate signer IDs, key ID reuse, or public-key hash collision.

# Receipt verification steps
1. Receive a receipt with `tenant_id`, `request_hash`, `decision_hash`, `policy_hash`, and signature metadata.
2. Verify with registry material:
```cmd
bin\mnde-custody.cmd verify-custody-receipt --registry registry.json --receipt receipt.json
```
3. Verification resolves `tenant_id + key_set_version + signer_id + key_id + public_key_hash`; missing, unknown, or ambiguous metadata refuses.

# Rotation steps
1. Add new signer material as a new `key_set_version` with `status: "pending"`.
2. Activate the new set by changing it to `status: "active"` and the old set to `status: "historical"`.
3. New receipts use the new active `key_set_version`.
4. Old receipts keep their original metadata and continue verifying against the historical signer set.

# Failure conditions
Refuse on `ERR_UNKNOWN_SIGNER`, `ERR_UNKNOWN_KEY_SET_VERSION`, `ERR_KEY_REUSE_ACROSS_TENANTS`, `ERR_PUBLIC_KEY_HASH_COLLISION`, `ERR_SIGNER_COLLISION`, `ERR_INTERNAL_SIGNING_DISABLED`, or `ERR_RECEIPT_KEY_RESOLUTION_FAILED`. No override flags exist.
