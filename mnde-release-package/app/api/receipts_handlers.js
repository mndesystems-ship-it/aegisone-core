import { readFileSync } from "fs";
import path from "path";
import {
    buildAuditExport,
    buildReceiptIndex,
    findReceipts,
    getReceiptStats,
    parseStrictJsonText,
    replayReceipt,
    replayReceiptLog,
    replayReceipts,
    resolveReceiptProof,
    showReceipt,
    verifyReceipt
} from "../receipts/index.js";
import { loadAllIndexedReceipts } from "../receipts/indexer.js";
import { rejectUnknownFields, REQUEST_FIELDS, validateAllowedPath } from "./receipts_schema.js";

function readReceiptFromBody(body, roots) {
    if (body.receipt) return body.receipt;
    if (body.file) return parseStrictJsonText(readFileSync(validateAllowedPath(body.file, roots), "utf8").trim());
    throw new Error("ERR_RECEIPT_REQUIRED");
}

export async function handleReceiptApi(route, body, allowedRoots) {
    if (route === "/receipts/verify") {
        rejectUnknownFields(body, REQUEST_FIELDS.verify, "receipt_verify_request");
        const policyStore = validateAllowedPath(body.policy_store, allowedRoots);
        return verifyReceipt({ receipt: readReceiptFromBody(body, allowedRoots), policy_store: policyStore });
    }
    if (route === "/receipts/replay") {
        rejectUnknownFields(body, REQUEST_FIELDS.replay, "receipt_replay_request");
        const policyStore = validateAllowedPath(body.policy_store, allowedRoots);
        if (body.receipt || body.file) return replayReceipt({ receipt: readReceiptFromBody(body, allowedRoots), policy_store: policyStore });
        if (body.receipt_log) return replayReceiptLog(validateAllowedPath(body.receipt_log, allowedRoots), policyStore);
        if (body.receipt_index) return replayReceipts(loadAllIndexedReceipts(validateAllowedPath(body.receipt_index, allowedRoots)), policyStore);
        throw new Error("ERR_RECEIPT_REQUIRED");
    }
    if (route === "/receipts/show") {
        rejectUnknownFields(body, REQUEST_FIELDS.show, "receipt_show_request");
        if (body.receipt) return showReceipt({ receipt: body.receipt, translate_reasons: body.translate_reasons !== false });
        return showReceipt({ file: validateAllowedPath(body.file, allowedRoots), translate_reasons: body.translate_reasons !== false });
    }
    if (route === "/receipts/index") {
        rejectUnknownFields(body, REQUEST_FIELDS.index, "receipt_index_request");
        const source = body.receipts ?? body.receipt_log ?? body.dir;
        if (!source) throw new Error("ERR_RECEIPT_SOURCE_REQUIRED");
        const resolvedSource = validateAllowedPath(source, allowedRoots);
        return buildReceiptIndex({
            receipt_log: body.receipt_log || (body.receipts && path.extname(body.receipts).toLowerCase() === ".jsonl" ? resolvedSource : null),
            dir: body.dir || (body.receipts && path.extname(body.receipts).toLowerCase() !== ".jsonl" ? resolvedSource : null),
            out: validateAllowedPath(body.out, allowedRoots),
            policy_store: body.policy_store ? validateAllowedPath(body.policy_store, allowedRoots) : null,
            strict: body.strict === true
        });
    }
    if (route === "/receipts/find") {
        rejectUnknownFields(body, REQUEST_FIELDS.find, "receipt_find_request");
        return findReceipts({
            index_dir: validateAllowedPath(body.index, allowedRoots),
            decision: body.decision ?? null,
            reason_code: body.reason_code ?? null,
            actor: body.actor ?? null,
            policy_version: body.policy_version ?? null,
            execution_id: body.execution_id ?? null
        });
    }
    if (route === "/receipts/stats") {
        rejectUnknownFields(body, REQUEST_FIELDS.stats, "receipt_stats_request");
        return getReceiptStats({ index_dir: validateAllowedPath(body.index, allowedRoots) });
    }
    if (route === "/receipts/proof") {
        rejectUnknownFields(body, REQUEST_FIELDS.proof, "receipt_proof_request");
        return resolveReceiptProof({
            receipt: readReceiptFromBody(body, allowedRoots),
            proof_root: validateAllowedPath(body.proof_root, allowedRoots)
        });
    }
    if (route === "/receipts/export") {
        rejectUnknownFields(body, REQUEST_FIELDS.export, "receipt_export_request");
        return buildAuditExport({
            receipts: validateAllowedPath(body.receipts, allowedRoots),
            proof_root: validateAllowedPath(body.proof_root, allowedRoots),
            out: validateAllowedPath(body.out, allowedRoots),
            format: body.format,
            strict: body.strict,
            build_timestamp: body.build_timestamp
        });
    }
    throw new Error("ERR_ROUTE_NOT_FOUND");
}
