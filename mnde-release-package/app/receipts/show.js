import { readFileSync } from "fs";
import path from "path";
import { canonicalHash, parseStrictJsonText } from "./format.js";
import { reasonContextFromReceipt, translateReason } from "./reasons.js";
import { validateReceiptShape } from "./schema.js";

export function showReceipt(input) {
    const receipt = input.receipt ?? parseStrictJsonText(readFileSync(path.resolve(input.file), "utf8"));
    validateReceiptShape(receipt);
    return {
        schema_version: "mnde.receipt_show.v1",
        receipt_hash: canonicalHash(receipt),
        request_hash: receipt.request_hash,
        policy_hash: receipt.policy_hash,
        policy_version: receipt.decision_output.policy_version,
        decision_hash: receipt.decision_output.decision_hash,
        decision: receipt.decision_output.decision,
        reason_code: receipt.decision_output.reason_code,
        translation: input.translate_reasons === false ? null : translateReason(receipt.decision_output.reason_code, reasonContextFromReceipt(receipt)),
        total_cost_usd: receipt.decision_output.total_cost_usd,
        allowed_cost_usd: receipt.decision_output.allowed_cost_usd,
        prevented_cost_usd: receipt.decision_output.prevented_cost_usd,
        manifest_ref: receipt.manifest_ref,
        key_set_version: receipt.key_set_version,
        translation_version: receipt.translation_version
    };
}
