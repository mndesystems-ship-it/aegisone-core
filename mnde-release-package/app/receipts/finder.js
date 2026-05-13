import { readFileSync } from "fs";
import path from "path";
import { parseStrictJsonText } from "./format.js";
import { validateIndexManifest } from "./indexer.js";

function readIndex(indexDir) {
    const resolved = path.resolve(indexDir);
    validateIndexManifest(resolved);
    return parseStrictJsonText(readFileSync(path.join(resolved, "by_hash.json"), "utf8"));
}

export function findReceipts(input) {
    const byHash = readIndex(input.index_dir);
    const records = Object.keys(byHash).sort().map((hash) => byHash[hash]).filter((record) => {
        if (input.decision && record.decision !== input.decision) return false;
        if (input.reason_code && record.reason_code !== input.reason_code) return false;
        if (input.actor && record.actor !== input.actor) return false;
        if (input.policy_version && record.policy_version !== input.policy_version) return false;
        if (input.execution_id && record.execution_id !== input.execution_id) return false;
        return true;
    });
    return {
        schema_version: "mnde.receipt_find.v1",
        count: records.length,
        receipts: records
    };
}
