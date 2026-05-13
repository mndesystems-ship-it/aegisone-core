import { resolvePolicyProofReport } from "../proof/resolver.js";

export function resolveReceiptProof(input) {
    return resolvePolicyProofReport(input.receipt, input.proof_root ?? input.proofRoot);
}
