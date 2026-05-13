# Receipt API Contract

Purpose: expose receipt verification, replay, show, index, find, stats, proof, and export through strict JSON POST endpoints.

Base path: `/receipts`.

Endpoints: `POST /receipts/verify`, `/replay`, `/show`, `/index`, `/find`, `/stats`, `/proof`, `/export`.

Inputs: JSON bodies only. Unknown fields, duplicate keys, and paths outside configured allowed roots are refused.

Outputs: API JSON matches the corresponding CLI/library JSON for equivalent input.

Failure codes: `ERR_DUPLICATE_JSON_KEYS`, `ERR_INVALID_JSON`, `ERR_PATH_TRAVERSAL`, `ERR_PATH_NOT_ALLOWED`, `ERR_POLICY_PROOF_UNRESOLVED`, `ERR_RECEIPT_SIGNATURE_INVALID`, `ERR_ROUTE_NOT_FOUND`.

Determinism rules: handlers wrap library functions only, no business logic duplication, no inferred defaults beyond the schema.
