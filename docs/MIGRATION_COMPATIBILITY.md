# MNDe Migration Compatibility

MNDe has used earlier private repository identity during repository transition work. This note exists only to preserve compatibility context for historical receipts, release checks, and retained migration evidence.

The public product name is MNDe. Public evaluator docs, package metadata, reviewer kit output, and desktop-facing copy should use MNDe.

Compatibility rules:

1. Preserve deterministic execution surfaces that existing receipts depend on.
2. Preserve receipt schema, canonicalization, replay, and policy verification semantics.
3. Treat historical repository identity as migration context, not product naming.
4. Prefer MNDe in new documentation, reviewer instructions, UI copy, and proof summaries.

The operating rule remains: one authority decides before execution, and anything outside the authorized deterministic path is refused.
