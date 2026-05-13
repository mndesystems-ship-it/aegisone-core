import { createReadStream } from "fs";
import { createInterface } from "readline";
import { canonicalizeJson } from "../shared/json.js";
import { executeDeterministicPipeline, resetRuntimeState } from "../audit/node_runtime.js";
import { verifyReceiptPublicSignature, verifyReceiptSignature } from "../ramona/engine.js";
import { parseStrictJsonText, usdStringToMicroUsd, canonicalHash } from "./format.js";
import { resolveHistoricalPolicy } from "./policy.js";
import { reasonContextFromReceipt, translateReason } from "./reasons.js";
import { validateReceiptShape } from "./schema.js";

function decisionProjection(decisionOutput) {
    return {
        decision: decisionOutput.decision,
        reason_code: decisionOutput.reason_code,
        decision_hash: decisionOutput.decision_hash,
        total_cost_micro_usd: usdStringToMicroUsd(decisionOutput.total_cost_usd),
        allowed_cost_micro_usd: usdStringToMicroUsd(decisionOutput.allowed_cost_usd),
        prevented_cost_micro_usd: usdStringToMicroUsd(decisionOutput.prevented_cost_usd)
    };
}

export function replayReceipt(input, policyStoreArg = undefined) {
    const receipt = input?.receipt && (input?.policy_store || input?.policyStore) ? input.receipt : input;
    const policyStore = input?.receipt && (input?.policy_store || input?.policyStore) ? (input.policy_store ?? input.policyStore) : policyStoreArg;
    validateReceiptShape(receipt);
    const receiptHash = canonicalHash(receipt);
    const legacyValid = verifyReceiptSignature(receipt);
    const publicValid = verifyReceiptPublicSignature(receipt);
    if (!legacyValid || !publicValid) {
        return {
            schema_version: "mnde.receipt_replay.v1",
            receipt_hash: receiptHash,
            request_hash: receipt.request_hash,
            original: decisionProjection(receipt.decision_output),
            replayed: null,
            drift: true,
            mismatches: [{ field: "signature", original: "valid", replayed: "invalid" }]
        };
    }
    const policy = resolveHistoricalPolicy(policyStore, receipt.decision_output.policy_version, receipt.decision_output.policy_hash);
    const canonicalInput = parseStrictJsonText(receipt.canonical_request);
    resetRuntimeState();
    const replay = executeDeterministicPipeline(canonicalizeJson({ ...canonicalInput, policy_document: policy }));
    if ("parse_boundary" in replay) {
        return {
            schema_version: "mnde.receipt_replay.v1",
            receipt_hash: receiptHash,
            request_hash: receipt.request_hash,
            original: decisionProjection(receipt.decision_output),
            replayed: null,
            drift: true,
            mismatches: [{ field: "replay", original: "receipt", replayed: replay.reason_code }]
        };
    }
    const original = decisionProjection(receipt.decision_output);
    const replayed = decisionProjection(replay.receipt.decision_output);
    const mismatches = [];
    for (const key of Object.keys(original)) {
        if (original[key] !== replayed[key]) {
            mismatches.push({ field: key, original: original[key], replayed: replayed[key] });
        }
    }
    return {
        schema_version: "mnde.receipt_replay.v1",
        receipt_hash: receiptHash,
        request_hash: receipt.request_hash,
        original,
        replayed,
        drift: mismatches.length > 0,
        mismatches
    };
}

export function replayReceipts(receipts, policyStore) {
    const mismatches = [];
    let exactMatches = 0;
    let invalidCount = 0;
    for (const item of receipts) {
        try {
            const replay = replayReceipt(item.receipt, policyStore);
            if (replay.drift) {
                invalidCount += replay.replayed === null ? 1 : 0;
                for (const mismatch of replay.mismatches) {
                    mismatches.push({ receipt_hash: replay.receipt_hash, request_hash: replay.request_hash, ...mismatch });
                }
            } else {
                exactMatches += 1;
            }
        } catch (error) {
            invalidCount += 1;
            mismatches.push({
                receipt_hash: item.receipt ? canonicalHash(item.receipt) : "unknown",
                request_hash: item.receipt?.request_hash ?? "unknown",
                field: "receipt",
                original: "valid",
                replayed: error.message
            });
        }
    }
    const base = {
        schema_version: "mnde.receipt_replay_report.v1",
        total: receipts.length,
        exact_matches: exactMatches,
        drift_count: mismatches.length,
        invalid_count: invalidCount,
        mismatches: mismatches.sort((a, b) => a.receipt_hash.localeCompare(b.receipt_hash) || a.field.localeCompare(b.field))
    };
    return { ...base, report_hash: canonicalHash(base) };
}

export async function replayReceiptLog(receiptLog, policyStore) {
    const reader = createInterface({
        input: createReadStream(receiptLog, { encoding: "utf8" }),
        crlfDelay: Infinity
    });
    const mismatches = [];
    let total = 0;
    let exactMatches = 0;
    let invalidCount = 0;
    let lineNumber = 0;
    for await (const line of reader) {
        lineNumber += 1;
        if (line.length === 0) {
            continue;
        }
        total += 1;
        try {
            const receipt = parseStrictJsonText(line);
            const replay = replayReceipt(receipt, policyStore);
            if (replay.drift) {
                invalidCount += replay.replayed === null ? 1 : 0;
                for (const mismatch of replay.mismatches) {
                    mismatches.push({ receipt_hash: replay.receipt_hash, request_hash: replay.request_hash, line_number: lineNumber, ...mismatch });
                }
            } else {
                exactMatches += 1;
            }
        } catch (error) {
            invalidCount += 1;
            mismatches.push({
                receipt_hash: "unknown",
                request_hash: "unknown",
                line_number: lineNumber,
                field: "receipt",
                original: "valid",
                replayed: error.message
            });
        }
    }
    const base = {
        schema_version: "mnde.receipt_replay_report.v1",
        total,
        exact_matches: exactMatches,
        drift_count: mismatches.length,
        invalid_count: invalidCount,
        mismatches: mismatches.sort((a, b) => a.line_number - b.line_number || a.field.localeCompare(b.field))
    };
    return { ...base, report_hash: canonicalHash(base) };
}

export function replayStatusWithReason(replay) {
    return {
        ...replay,
        reason: replay.original?.reason_code ? translateReason(replay.original.reason_code, reasonContextFromReceipt({ canonical_request: "{}", decision_output: { reason_code: replay.original.reason_code, execution_id: "unknown", policy_version: "unknown" } })) : null
    };
}
