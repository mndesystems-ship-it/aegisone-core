import { readFileSync } from "fs";
import path from "path";
import { parseStrictJsonText } from "./format.js";
import { validateIndexManifest } from "./indexer.js";

export function getReceiptStats(input) {
    const resolved = path.resolve(input.index_dir);
    validateIndexManifest(resolved);
    const summary = parseStrictJsonText(readFileSync(path.join(resolved, "summary.json"), "utf8"));
    return {
        schema_version: "mnde.receipt_stats.v1",
        total_receipts: summary.total_receipts,
        indexed_receipts: summary.indexed_receipts,
        invalid_receipts: summary.invalid_receipts,
        verified_receipts: summary.verified_receipts,
        total_cost_micro_usd: summary.total_cost_micro_usd,
        allowed_cost_micro_usd: summary.allowed_cost_micro_usd,
        prevented_cost_micro_usd: summary.prevented_cost_micro_usd,
        decisions: summary.decisions,
        reasons: summary.reasons,
        index_hash: summary.index_hash
    };
}
