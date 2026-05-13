import { readFileSync } from "fs";
import path from "path";
import { canonicalizeJson } from "../shared/json.js";
import {
    buildReceiptIndex,
    buildAuditExport,
    deterministicError,
    findReceipts,
    getReceiptStats,
    loadIndexedReceipt,
    parseStrictJsonText,
    replayReceipt,
    replayReceiptLog,
    replayReceipts,
    resolveReceiptProof,
    showReceipt,
    verifyReceipt
} from "./index.js";

function parseFlag(argv, name) {
    const index = argv.indexOf(name);
    return index === -1 || index === argv.length - 1 ? null : argv[index + 1];
}

function writeJson(value) {
    process.stdout.write(`${canonicalizeJson(value)}\n`);
}

function readReceipt(filePath) {
    return parseStrictJsonText(readFileSync(path.resolve(filePath), "utf8").trim());
}

function usage() {
    writeJson({
        schema_version: "mnde.receipts_cli_usage.v1",
        commands: [
            "receipts.verify",
            "receipts.replay",
            "receipts.show",
            "receipts.index",
            "receipts.find",
            "receipts.stats",
            "receipts.proof"
            ,"receipts.export"
        ]
    });
}

async function main() {
    const [command, ...argv] = process.argv.slice(2);
    if (!command || command === "help" || command === "--help") {
        usage();
        return;
    }
    if (command === "receipts.index") {
        writeJson(await buildReceiptIndex({
            receipt_log: parseFlag(argv, "--receipt-log"),
            dir: parseFlag(argv, "--dir"),
            out: parseFlag(argv, "--out"),
            policy_store: parseFlag(argv, "--policy-store"),
            strict: parseFlag(argv, "--strict") !== "false"
        }));
        return;
    }
    if (command === "receipts.verify") {
        const policyStore = parseFlag(argv, "--policy-store");
        const file = parseFlag(argv, "--file");
        if (!policyStore || !file) throw new Error("--file and --policy-store are required");
        const result = verifyReceipt({ receipt: readReceipt(file), policy_store: path.resolve(policyStore) });
        writeJson(result);
        if (result.status !== "VERIFIED") process.exitCode = 1;
        return;
    }
    if (command === "receipts.replay") {
        const policyStore = parseFlag(argv, "--policy-store");
        const file = parseFlag(argv, "--file");
        const receiptLog = parseFlag(argv, "--receipt-log");
        const receiptIndex = parseFlag(argv, "--receipt-index");
        if (!policyStore) throw new Error("--policy-store is required");
        let result;
        if (file) {
            result = replayReceipt({ receipt: readReceipt(file), policy_store: path.resolve(policyStore) });
        } else if (receiptLog) {
            result = await replayReceiptLog(path.resolve(receiptLog), path.resolve(policyStore));
        } else if (receiptIndex) {
            result = replayReceipts((await import("./indexer.js")).loadAllIndexedReceipts(path.resolve(receiptIndex)), path.resolve(policyStore));
        } else {
            throw new Error("--file, --receipt-log, or --receipt-index is required");
        }
        writeJson(result);
        if (result.drift === true || result.drift_count > 0 || result.invalid_count > 0) process.exitCode = 1;
        return;
    }
    if (command === "receipts.show") {
        const file = parseFlag(argv, "--file");
        if (!file) throw new Error("--file is required");
        writeJson(showReceipt({ file: path.resolve(file), translate_reasons: parseFlag(argv, "--translate-reasons") !== "false" }));
        return;
    }
    if (command === "receipts.find") {
        const indexDir = parseFlag(argv, "--index");
        if (!indexDir) throw new Error("--index is required");
        writeJson(findReceipts({
            index_dir: path.resolve(indexDir),
            decision: parseFlag(argv, "--decision"),
            reason_code: parseFlag(argv, "--reason-code"),
            actor: parseFlag(argv, "--actor"),
            policy_version: parseFlag(argv, "--policy-version"),
            execution_id: parseFlag(argv, "--execution-id")
        }));
        return;
    }
    if (command === "receipts.stats") {
        const indexDir = parseFlag(argv, "--index");
        if (!indexDir) throw new Error("--index is required");
        writeJson(getReceiptStats({ index_dir: path.resolve(indexDir) }));
        return;
    }
    if (command === "receipts.proof") {
        const proofRoot = parseFlag(argv, "--proof");
        const file = parseFlag(argv, "--file");
        if (!proofRoot || !file) throw new Error("--file and --proof are required");
        const result = resolveReceiptProof({ receipt: readReceipt(file), proof_root: path.resolve(proofRoot) });
        writeJson(result);
        if (result.status !== "RESOLVED") process.exitCode = 1;
        return;
    }
    if (command === "receipts.export") {
        const result = await buildAuditExport({
            receipts: parseFlag(argv, "--receipts"),
            proof_root: parseFlag(argv, "--proof-root"),
            out: parseFlag(argv, "--out"),
            format: parseFlag(argv, "--format") ?? "dir",
            strict: parseFlag(argv, "--strict") !== "false",
            build_timestamp: parseFlag(argv, "--build-timestamp")
        });
        writeJson(result);
        return;
    }
    if (command === "receipts.from-index") {
        const indexDir = parseFlag(argv, "--index");
        const hash = parseFlag(argv, "--receipt-hash");
        if (!indexDir || !hash) throw new Error("--index and --receipt-hash are required");
        writeJson(loadIndexedReceipt(indexDir, hash).record);
        return;
    }
    throw new Error(`unknown_command_${command}`);
}

void main().catch((error) => {
    process.stderr.write(`${canonicalizeJson(deterministicError(error, "ERR_RECEIPTS_CLI"))}\n`);
    process.exit(2);
});
