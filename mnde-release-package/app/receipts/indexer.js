import { createHash } from "crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import path from "path";
import { canonicalizeJson } from "../shared/json.js";
import { parseStrictJsonText, canonicalHash, usdStringToMicroUsd } from "./format.js";
import { reasonContextFromReceipt, translateReason } from "./reasons.js";
import { validateReceiptShape } from "./schema.js";
import { verifyReceipt } from "./verify.js";

const INDEX_FILES = [
    "by_actor.json",
    "by_decision.json",
    "by_execution_id.json",
    "by_hash.json",
    "by_policy_version.json",
    "by_project.json",
    "by_reason_code.json",
    "by_team.json",
    "summary.json"
];

function sha256File(filePath) {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function addToBucket(index, key, receiptHash) {
    const bucketKey = key === null || key === undefined || key === "" ? "unknown" : String(key);
    if (!index[bucketKey]) {
        index[bucketKey] = [];
    }
    index[bucketKey].push(receiptHash);
}

function sortObjectDeep(value) {
    if (Array.isArray(value)) {
        return value.map(sortObjectDeep);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectDeep(value[key])]));
    }
    return value;
}

function sortedBuckets(index) {
    const result = {};
    for (const key of Object.keys(index).sort()) {
        result[key] = [...index[key]].sort();
    }
    return result;
}

function readRequestFields(receipt) {
    const input = parseStrictJsonText(receipt.canonical_request);
    const request = input.execution_request ?? {};
    return {
        actor: request.actor?.user_id ?? request.actor?.actor_id ?? null,
        team: request.actor?.team_id ?? request.team_id ?? null,
        project: request.actor?.project_id ?? request.project_id ?? null,
        execution_id: request.release_request?.execution_id ?? null
    };
}

function recordForReceipt(receipt, receiptHash, sourceLog, lineNumber, verificationStatus) {
    const fields = readRequestFields(receipt);
    return {
        receipt_hash: receiptHash,
        request_hash: receipt.request_hash,
        decision_hash: receipt.decision_output.decision_hash,
        decision: receipt.decision_output.decision,
        reason_code: receipt.decision_output.reason_code,
        human_reason: translateReason(receipt.decision_output.reason_code, reasonContextFromReceipt(receipt)),
        execution_id: receipt.decision_output.execution_id ?? fields.execution_id ?? "unknown",
        policy_version: receipt.decision_output.policy_version,
        policy_hash: receipt.decision_output.policy_hash,
        actor: fields.actor ?? "unknown",
        team: fields.team ?? "unknown",
        project: fields.project ?? "unknown",
        total_cost_micro_usd: usdStringToMicroUsd(receipt.decision_output.total_cost_usd),
        allowed_cost_micro_usd: usdStringToMicroUsd(receipt.decision_output.allowed_cost_usd),
        prevented_cost_micro_usd: usdStringToMicroUsd(receipt.decision_output.prevented_cost_usd),
        source_log: sourceLog,
        line_number: lineNumber,
        verification_status: verificationStatus
    };
}

async function* jsonlReceipts(filePath) {
    const resolved = path.resolve(filePath);
    const reader = createInterface({
        input: createReadStream(resolved, { encoding: "utf8" }),
        crlfDelay: Infinity
    });
    let lineNumber = 0;
    for await (const line of reader) {
        lineNumber += 1;
        if (line.length === 0) {
            continue;
        }
        yield { line, lineNumber, sourceLog: resolved };
    }
}

async function* receiptDirectoryItems(dirPath) {
    const resolved = path.resolve(dirPath);
    const files = readdirSync(resolved, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => path.join(resolved, entry.name))
        .sort();
    for (const file of files) {
        yield { line: readFileSync(file, "utf8").trim(), lineNumber: 1, sourceLog: file };
    }
}

export async function readReceiptLog(filePath) {
    const receipts = [];
    for await (const item of jsonlReceipts(filePath)) {
        receipts.push({ receipt: parseStrictJsonText(item.line), line_number: item.lineNumber, source_log: item.sourceLog });
    }
    return receipts;
}

export async function indexReceipts({ receiptLog, receiptDir = null, dir = null, outDir, policyStore = null, strict = false, portable = false }) {
    const sourceDir = receiptDir ?? dir;
    if (!receiptLog && !sourceDir) {
        throw new Error("receipt_source_required");
    }
    const resolvedLog = receiptLog ? path.resolve(receiptLog) : null;
    const resolvedSourceDir = sourceDir ? path.resolve(sourceDir) : null;
    const resolvedOut = path.resolve(outDir ?? path.join(resolvedLog ? path.dirname(resolvedLog) : resolvedSourceDir, "receipt-index"));
    mkdirSync(resolvedOut, { recursive: true });
    const byHash = {};
    const byExecutionId = {};
    const byPolicyVersion = {};
    const byReasonCode = {};
    const byDecision = {};
    const byActor = {};
    const byTeam = {};
    const byProject = {};
    const invalid = [];
    let total = 0;
    let verifiedCount = 0;
    let totalCost = 0;
    let allowedCost = 0;
    let preventedCost = 0;
    const iterator = resolvedLog ? jsonlReceipts(resolvedLog) : receiptDirectoryItems(resolvedSourceDir);
    for await (const item of iterator) {
        total += 1;
        try {
            const receipt = parseStrictJsonText(item.line);
            validateReceiptShape(receipt);
            const receiptHash = canonicalHash(receipt);
            if (byHash[receiptHash]) {
                throw new Error("duplicate_receipt_hash");
            }
            let verificationStatus = "UNVERIFIED";
            if (policyStore) {
                const verification = verifyReceipt(receipt, path.resolve(policyStore));
                verificationStatus = verification.status;
                if (verification.status === "VERIFIED") {
                    verifiedCount += 1;
                } else if (strict) {
                    throw new Error(verification.reason_code);
                }
            }
            const displaySource = portable ? path.relative(path.dirname(resolvedOut), item.sourceLog).replaceAll("\\", "/") : item.sourceLog;
            const record = recordForReceipt(receipt, receiptHash, displaySource, item.lineNumber, verificationStatus);
            byHash[receiptHash] = record;
            addToBucket(byExecutionId, record.execution_id, receiptHash);
            addToBucket(byPolicyVersion, record.policy_version, receiptHash);
            addToBucket(byReasonCode, record.reason_code, receiptHash);
            addToBucket(byDecision, record.decision, receiptHash);
            addToBucket(byActor, record.actor, receiptHash);
            addToBucket(byTeam, record.team, receiptHash);
            addToBucket(byProject, record.project, receiptHash);
            totalCost += record.total_cost_micro_usd;
            allowedCost += record.allowed_cost_micro_usd;
            preventedCost += record.prevented_cost_micro_usd;
        } catch (error) {
            const failed = {
                line_number: item.lineNumber,
                source_log: item.sourceLog,
                reason_code: error.message
            };
            invalid.push(failed);
            if (strict) {
                throw new Error(`receipt_index_failed_line_${item.lineNumber}_${error.message}`);
            }
        }
    }
    const reasonCounts = Object.keys(byReasonCode).sort().map((reason_code) => ({ reason_code, count: byReasonCode[reason_code].length }));
    const summaryBase = {
        schema_version: "mnde.receipt_index_summary.v1",
        source_log: portable ? path.relative(path.dirname(resolvedOut), resolvedLog ?? resolvedSourceDir).replaceAll("\\", "/") : (resolvedLog ?? resolvedSourceDir),
        total_receipts: total,
        indexed_receipts: Object.keys(byHash).length,
        invalid_receipts: invalid.length,
        verified_receipts: verifiedCount,
        total_cost_micro_usd: totalCost,
        allowed_cost_micro_usd: allowedCost,
        prevented_cost_micro_usd: preventedCost,
        decisions: Object.keys(byDecision).sort().map((decision) => ({ decision, count: byDecision[decision].length })),
        reasons: reasonCounts,
        invalid
    };
    const summary = { ...summaryBase, index_hash: canonicalHash(summaryBase) };
    const files = {
        "by_actor.json": sortedBuckets(byActor),
        "by_decision.json": sortedBuckets(byDecision),
        "by_execution_id.json": sortedBuckets(byExecutionId),
        "by_hash.json": sortObjectDeep(byHash),
        "by_policy_version.json": sortedBuckets(byPolicyVersion),
        "by_project.json": sortedBuckets(byProject),
        "by_reason_code.json": sortedBuckets(byReasonCode),
        "by_team.json": sortedBuckets(byTeam),
        "summary.json": summary
    };
    for (const fileName of INDEX_FILES) {
        writeFileSync(path.join(resolvedOut, fileName), `${canonicalizeJson(files[fileName])}\n`, "utf8");
    }
    const manifestBase = {
        schema_version: "mnde.receipt_index_manifest.v1",
        index_hash: summary.index_hash,
        files: INDEX_FILES.map((file_name) => ({ file_name, file_hash: sha256File(path.join(resolvedOut, file_name)) }))
    };
    const manifest = { ...manifestBase, manifest_hash: canonicalHash(manifestBase) };
    writeFileSync(path.join(resolvedOut, "manifest.json"), `${canonicalizeJson(manifest)}\n`, "utf8");
    return { ...summary, index_dir: resolvedOut, manifest_hash: manifest.manifest_hash };
}

export async function buildReceiptIndex(input) {
    return indexReceipts({
        receiptLog: input.receipt_log ?? input.receiptLog,
        receiptDir: input.dir ?? input.receipt_dir ?? input.receiptDir,
        outDir: input.out ?? input.out_dir ?? input.outDir,
        policyStore: input.policy_store ?? input.policyStore,
        strict: input.strict ?? true,
        portable: input.portable ?? false
    });
}

export function validateIndexManifest(indexDir) {
    const resolved = path.resolve(indexDir);
    const manifest = parseStrictJsonText(readFileSync(path.join(resolved, "manifest.json"), "utf8"));
    const { manifest_hash: storedManifestHash, ...manifestBase } = manifest;
    if (canonicalHash(manifestBase) !== storedManifestHash) {
        throw new Error("receipt_index_manifest_hash_mismatch");
    }
    for (const file of manifest.files) {
        const filePath = path.join(resolved, file.file_name);
        if (!existsSync(filePath)) {
            throw new Error(`receipt_index_file_missing_${file.file_name}`);
        }
        if (sha256File(filePath) !== file.file_hash) {
            throw new Error(`receipt_index_file_hash_mismatch_${file.file_name}`);
        }
    }
    return manifest;
}

export function loadIndexedReceipt(indexDir, receiptHash) {
    const resolved = path.resolve(indexDir);
    validateIndexManifest(resolved);
    const byHash = parseStrictJsonText(readFileSync(path.join(resolved, "by_hash.json"), "utf8"));
    const record = byHash[receiptHash];
    if (!record) {
        throw new Error("receipt_hash_not_found");
    }
    const sourcePath = path.isAbsolute(record.source_log) ? record.source_log : path.join(path.dirname(resolved), record.source_log);
    const lines = readFileSync(sourcePath, "utf8").split(/\r?\n/);
    const line = lines[record.line_number - 1];
    if (!line) {
        throw new Error("indexed_receipt_source_line_missing");
    }
    const receipt = parseStrictJsonText(line);
    if (canonicalHash(receipt) !== receiptHash) {
        throw new Error("indexed_receipt_hash_mismatch");
    }
    return { receipt, record };
}

export function loadAllIndexedReceipts(indexDir) {
    const resolved = path.resolve(indexDir);
    validateIndexManifest(resolved);
    const byHash = parseStrictJsonText(readFileSync(path.join(resolved, "by_hash.json"), "utf8"));
    return Object.keys(byHash).sort().map((receiptHash) => loadIndexedReceipt(resolved, receiptHash));
}
