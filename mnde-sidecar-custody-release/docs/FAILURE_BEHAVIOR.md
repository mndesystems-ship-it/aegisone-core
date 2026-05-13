# Failure Behavior

- Release integrity failure: startup refuses.
- Forbidden artifact in release tree: startup refuses.
- Missing or malformed custody signer config: startup refuses.
- Unknown signer mode, duplicate signer id, duplicate public key, or missing public key: startup refuses.
- Missing external_http endpoint: startup refuses.
- Custody signer timeout: deterministic REFUSE.
- Invalid signer response or signature verification failure: deterministic REFUSE.
- Unknown signer id or key set version: deterministic REFUSE.
- Invalid request body: request refuses.
- Risk threshold exceeded: decision REFUSE with a customer-custody signed receipt.
- Internal custody signing attempt: ERR_INTERNAL_SIGNING_DISABLED.
- Runtime logs and receipts are outside the release tree.
