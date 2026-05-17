# MNDe Sidecar Custody Release

This package combines MNDe execution-control sidecar behavior with custody-clean release hygiene.

Endpoints:

- GET /healthz
- GET /readyz
- POST /v1/decisions

Runtime state defaults to C:\mnde-runtime and can be changed with --runtime-dir or MNDE_RUNTIME_DIR.

Production startup requires a valid customer custody signer config. If --signer-config or
MNDE_CUSTODY_SIGNER_CONFIG is not supplied, the sidecar looks for custody.signers.json in the
runtime directory and fails closed if it is missing or invalid. The sidecar never creates receipt
signing keys inside the runtime directory.

Supported signer modes:

- external_http
- aws_kms
- azure_key_vault
- gcp_cloud_kms
- offline_operator

Only external_http is executed directly by this package. Cloud and offline modes are accepted by
the schema for customer custody integration but return deterministic REFUSE until their adapters
are supplied by the deploying operator.
