import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { canonicalizeJson } from "../shared/index.js";
import { executeDeterministicPipeline, resetRuntimeState } from "../audit/node_runtime.js";
import { RECEIPT_PUBLIC_KEY_PEM, verifyReceiptPayloadSignature } from "../shared/receipt-signing.js";
import { verifyReceiptPublicSignature, verifyReceiptSignature } from "../ramona/engine.js";
import { DEFAULT_AUDIT_OUTPUT_DIR, DEFAULT_BENCHMARK_OUTPUT_DIR } from "./paths.js";
import { formatProvenanceForDisplay, readProvenance } from "./provenance.js";
import { verifyManifest } from "./verify_manifest.js";
import { assertReleaseIntegrity, readPublishedHash } from "./integrity.js";
import {
    commitPolicyEvent,
    createChangeRequest,
    diffPolicies,
    draftPolicy,
    initializePolicyStore,
    loadActivePolicy,
    loadPolicyByVersion,
    paths as policyPaths,
    signPolicyDocument,
    signTransaction,
    simulatePolicy,
    verifyPolicyStore
} from "../policy/lifecycle.js";
import { policyHash } from "../shared/policy-trust.js";
import { publicKeyRawHexFromPrivatePem, keyIdFromRawPublicKey } from "../policy/crypto.js";
import { canonicalBoundarySet, compileBoundarySet, diffBoundaryCompiledPolicies, listPresets, parseStrictJsonFileText, presetToBoundarySet, translateReason, validateBoundarySet } from "../boundary/index.js";
import { assignRole, authorizeOrThrow, createRolePolicy, publishRolePolicy, revokeRole, verifyAuthzReceipts } from "../authz/index.js";
import {
    deterministicError,
    buildAuditExport,
    findReceipts,
    getReceiptStats,
    indexReceipts,
    loadAllIndexedReceipts,
    loadIndexedReceipt,
    parseStrictJsonText,
    replayReceipt,
    replayReceiptLog,
    replayReceipts,
    replayStatusWithReason,
    resolveReceiptProof,
    showReceipt,
    validateIndexManifest,
    verifyReceipt
} from "../receipts/index.js";
function readJsonFile(filePath) {
    const bytes = readFileSync(path.resolve(filePath));
    const text = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
    return JSON.parse(text);
}
function readStrictJsonFile(filePath) {
    const bytes = readFileSync(path.resolve(filePath));
    const text = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
    return parseStrictJsonFileText(text);
}
function readReceiptFile(filePath) {
    const bytes = readFileSync(path.resolve(filePath));
    const text = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
    return parseStrictJsonText(text.trim());
}
function readReceiptLogLine(filePath, lineNumber) {
    const resolved = path.resolve(filePath);
    const lines = readFileSync(resolved, "utf8").split(/\r?\n/);
    const line = lines[Number(lineNumber) - 1];
    if (!line) {
        throw new Error("receipt_log_line_not_found");
    }
    return parseStrictJsonText(line);
}
function parseFlag(argv, name) {
    const index = argv.indexOf(name);
    if (index === -1 || index === argv.length - 1) {
        return null;
    }
    return argv[index + 1] ?? null;
}
function printUsage() {
    process.stdout.write([
        "mnde-cli commands:",
        "  version",
        "  artifact-hash --file <manifest-path>",
        "  evaluate --input <file>",
        "  verify-manifest",
        "  verify-receipt --receipt <file> [--public-key <file>]",
        "  run-audit [--output-dir <dir>] [--benchmark-duration-seconds <seconds>]",
        "  benchmark [--output-dir <dir>] [--duration-seconds <seconds>] [--window-seconds <seconds>]"
        ,"  policy <draft|validate|simulate|diff|sign|publish|active|history|rollback|verify>"
        ,"  boundary <create|validate|preview|simulate|diff|publish|reason|preset>"
        ,"  receipts <index|verify|replay>"
    ].join("\n") + "\n");
}
function parseListFlag(argv, name) {
    const values = [];
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === name && index < argv.length - 1) {
            values.push(argv[index + 1]);
        }
    }
    return values;
}
function writeDeterministic(value) {
    process.stdout.write(`${canonicalizeJson(value)}\n`);
}
function writeVibeOrJson(value, vibe) {
    if (!vibe) {
        writeDeterministic(value);
        return;
    }
    const lines = [
        `status: ${value.status ?? (value.drift_count === 0 ? "ZERO_DRIFT" : "DRIFT")}`,
        `decision: ${value.decision ?? value.original?.decision ?? "n/a"}`,
        `reason: ${value.decision_reason_code ?? value.reason_code ?? value.original?.reason_code ?? "n/a"}`,
        `receipt_hash: ${value.receipt_hash ?? "n/a"}`,
        `request_hash: ${value.request_hash ?? "n/a"}`
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
}
function writeJsonIfRequested(value, outputPath) {
    if (!outputPath) {
        writeDeterministic(value);
        return;
    }
    const resolved = path.resolve(outputPath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, `${canonicalizeJson(value)}\n`, { encoding: "utf8", flag: "w" });
    writeDeterministic({ ok: true, path: resolved });
}
function readPolicyRules(argv) {
    const rulesPath = parseFlag(argv, "--rules");
    if (rulesPath) {
        return readJsonFile(rulesPath);
    }
    return {
        max_total_cost_cents: Number(parseFlag(argv, "--max-total-cost-cents")),
        allow_auto_scale: parseFlag(argv, "--allow-auto-scale") === "true",
        max_gpu_count: Number(parseFlag(argv, "--max-gpu-count")),
        max_hours: Number(parseFlag(argv, "--max-hours")),
        require_manual_approval_above_cents: Number(parseFlag(argv, "--require-manual-approval-above-cents")),
        max_retry_count: Number(parseFlag(argv, "--max-retry-count"))
    };
}
function defaultAuthority(privateKeyPem, limits) {
    const public_key = publicKeyRawHexFromPrivatePem(privateKeyPem);
    return {
        schema_version: "mnde.policy_authority.v1",
        authority_id: "local-root",
        authority_type: "root",
        delegated_by: null,
        key_id: keyIdFromRawPublicKey(public_key),
        public_key,
        scope: "global",
        limits,
        not_before: "2026-01-01T00:00:00.000Z",
        expires_at: "2099-12-31T00:00:00.000Z",
        revoked: false
    };
}
function authzOptions(argv, fallbackPrivateKeyPem, scope = null) {
    const authzStore = parseFlag(argv, "--authz-store") ?? process.env.MNDE_AUTHZ_STORE;
    const actorKeyId = parseFlag(argv, "--actor-key-id") ?? process.env.MNDE_ACTOR_KEY_ID;
    if (!authzStore || !actorKeyId) {
        throw new Error("--authz-store and --actor-key-id are required");
    }
    return {
        authzStore: path.resolve(authzStore),
        actorKeyId,
        authzReceiptPrivateKeyPem: fallbackPrivateKeyPem,
        ...scope ? { authzScope: scope } : {}
    };
}
const RELEASE_DIR = path.dirname(fileURLToPath(import.meta.url));
async function main() {
    const [command, ...argv] = process.argv.slice(2);
    if (!command || command === "help" || command === "--help") {
        printUsage();
        return;
    }
    const integrityExemptCommands = new Set([
        "version",
        "--version",
        "artifact-hash",
        "verify-manifest"
    ]);
    if (!integrityExemptCommands.has(command)) {
        assertReleaseIntegrity();
    }
    if (command === "version" || command === "--version") {
        process.stdout.write(`${formatProvenanceForDisplay(readProvenance())}\n`);
        return;
    }
    if (command === "artifact-hash") {
        const file = parseFlag(argv, "--file") ?? parseFlag(argv, "--artifact");
        if (!file) {
            throw new Error("--file is required");
        }
        const result = readPublishedHash(file);
        if (!result) {
            process.stdout.write(`${JSON.stringify({ verdict: "REFUSE", reason: "artifact_not_in_manifest", file }, null, 2)}\n`);
            process.exitCode = 1;
            return;
        }
        process.stdout.write(`${JSON.stringify({ verdict: result.match ? "PASS" : "REFUSE", ...result }, null, 2)}\n`);
        if (!result.match) {
            process.exitCode = 1;
        }
        return;
    }
    if (command === "evaluate") {
        const inputPath = parseFlag(argv, "--input");
        if (!inputPath) {
            throw new Error("--input is required");
        }
        const rawInput = readFileSync(path.resolve(inputPath), "utf8");
        const authzStore = parseFlag(argv, "--authz-store") ?? process.env.MNDE_AUTHZ_STORE;
        const actorKeyId = parseFlag(argv, "--actor-key-id") ?? process.env.MNDE_ACTOR_KEY_ID;
        const authzReceiptKey = parseFlag(argv, "--authz-receipt-private-key") ?? process.env.MNDE_AUTHZ_RECEIPT_PRIVATE_KEY;
        if (!authzStore || !actorKeyId || !authzReceiptKey) {
            throw new Error("--authz-store, --actor-key-id and --authz-receipt-private-key are required");
        }
        authorizeOrThrow(path.resolve(authzStore), {
            actor_key_id: actorKeyId,
            requested_scope: "decision:submit",
            resource_scope: {},
            timestamp: "2026-04-19T00:00:00.000Z",
            action: {
                type: "CLI_EVALUATE",
                input_hash: canonicalizeJson(rawInput)
            }
        }, readFileSync(path.resolve(authzReceiptKey), "utf8"));
        resetRuntimeState();
        const result = executeDeterministicPipeline(rawInput);
        process.stdout.write(`${"parse_boundary" in result ? canonicalizeJson(result) : result.receipt_bytes}\n`);
        return;
    }
    if (command === "verify-manifest") {
        const result = verifyManifest();
        process.stdout.write(`${result.verdict}\n${JSON.stringify(result, null, 2)}\n`);
        if (!result.ok) {
            process.exitCode = 1;
        }
        return;
    }
    if (command === "verify-receipt") {
        const receiptPath = parseFlag(argv, "--receipt");
        if (!receiptPath) {
            throw new Error("--receipt is required");
        }
        const publicKeyPath = parseFlag(argv, "--public-key");
        const receipt = readJsonFile(receiptPath);
        const publicKeyPem = publicKeyPath ? readFileSync(path.resolve(publicKeyPath), "utf8") : RECEIPT_PUBLIC_KEY_PEM;
        const legacyValid = verifyReceiptSignature(receipt);
        const publicValid = verifyReceiptPublicSignature({
            ...receipt,
            ...publicKeyPath ? {} : {}
        });
        process.stdout.write(`${JSON.stringify({
            request_hash: receipt.request_hash,
            decision: receipt.decision_output?.decision ?? null,
            reason_code: receipt.decision_output?.reason_code ?? null,
            legacy_signature_valid: legacyValid,
            public_signature_valid: publicKeyPath && receipt.verifiable_signature ? verifyReceiptPublicSignatureWithKey(receipt, publicKeyPem) : publicValid
        }, null, 2)}\n`);
        if (!legacyValid || !(publicKeyPath && receipt.verifiable_signature ? verifyReceiptPublicSignatureWithKey(receipt, publicKeyPem) : publicValid)) {
            process.exitCode = 1;
        }
        return;
    }
    if (command === "run-audit") {
        const outputDir = parseFlag(argv, "--output-dir") ?? DEFAULT_AUDIT_OUTPUT_DIR;
        const duration = parseFlag(argv, "--benchmark-duration-seconds") ?? "300";
        const result = spawnSync(process.execPath, [
            path.join(RELEASE_DIR, "run_audit.js"),
            "--output-dir",
            outputDir,
            "--benchmark-duration-seconds",
            duration
        ], {
            cwd: path.resolve(RELEASE_DIR, ".."),
            stdio: "inherit"
        });
        process.exit(result.status ?? 1);
        return;
    }
    if (command === "benchmark") {
        const outputDir = parseFlag(argv, "--output-dir") ?? DEFAULT_BENCHMARK_OUTPUT_DIR;
        const duration = parseFlag(argv, "--duration-seconds") ?? "300";
        const windowSeconds = parseFlag(argv, "--window-seconds") ?? "10";
        const result = spawnSync(process.execPath, [
            path.join(RELEASE_DIR, "run_sustained_benchmark.js"),
            "--output-dir",
            outputDir,
            "--duration-seconds",
            duration,
            "--window-seconds",
            windowSeconds
        ], {
            cwd: path.resolve(RELEASE_DIR, ".."),
            stdio: "inherit"
        });
        process.exit(result.status ?? 1);
        return;
    }
    if (command === "policy") {
        const [subcommand, ...policyArgv] = argv;
        const store = path.resolve(parseFlag(policyArgv, "--store") ?? process.env.MNDE_POLICY_STORE ?? process.cwd());
        if (subcommand === "draft") {
            const version = parseFlag(policyArgv, "--version");
            if (!version) throw new Error("--version is required");
            writeDeterministic(draftPolicy({ version, rules: readPolicyRules(policyArgv) }));
            return;
        }
        if (subcommand === "validate") {
            const input = parseFlag(policyArgv, "--policy");
            if (!input) throw new Error("--policy is required");
            const policy = readJsonFile(input);
            const result = (await import("../policy/schema.js")).validatePolicyDocument(policy, { requireTrust: policy.trust !== undefined });
            writeDeterministic({ ok: true, policy_hash: result.policy_hash });
            return;
        }
        if (subcommand === "sign") {
            const input = parseFlag(policyArgv, "--policy");
            const key = parseFlag(policyArgv, "--private-key");
            if (!input || !key) throw new Error("--policy and --private-key are required");
            writeDeterministic(signPolicyDocument(readJsonFile(input), readFileSync(path.resolve(key), "utf8")));
            return;
        }
        if (subcommand === "publish") {
            const input = parseFlag(policyArgv, "--policy");
            const key = parseFlag(policyArgv, "--private-key");
            const base = parseFlag(policyArgv, "--base") ?? "NONE";
            if (!input || !key) throw new Error("--policy and --private-key are required");
            const privateKeyPem = readFileSync(path.resolve(key), "utf8");
            const policy = readJsonFile(input);
            const authority = defaultAuthority(privateKeyPem, policy.rules);
            const changeRequest = createChangeRequest({
                changeId: parseFlag(policyArgv, "--change-id") ?? `change-${policy.policy_version}`,
                basePolicyVersion: base,
                proposedPolicy: policy,
                reason: parseFlag(policyArgv, "--reason") ?? "policy publish",
                createdAt: parseFlag(policyArgv, "--created-at") ?? "2026-04-19T00:00:00.000Z"
            });
            const transaction = signTransaction({
                transactionId: parseFlag(policyArgv, "--transaction-id") ?? `txn-${policy.policy_version}`,
                transactionType: "PUBLISH",
                changeRequest,
                authority,
                privateKeyPem
            });
            writeDeterministic(commitPolicyEvent(store, transaction, { authorityPrivateKeyPem: privateKeyPem, ...authzOptions(policyArgv, privateKeyPem) }));
            return;
        }
        if (subcommand === "simulate") {
            const input = parseFlag(policyArgv, "--policy");
            if (!input) throw new Error("--policy is required");
            writeDeterministic(simulatePolicy(store, readJsonFile(input), parseListFlag(policyArgv, "--receipt-log").map((item) => path.resolve(item))));
            return;
        }
        if (subcommand === "diff") {
            const from = parseFlag(policyArgv, "--from");
            const to = parseFlag(policyArgv, "--to");
            if (!from || !to) throw new Error("--from and --to are required");
            writeDeterministic(diffPolicies(loadPolicyByVersion(store, from), loadPolicyByVersion(store, to)));
            return;
        }
        if (subcommand === "active") {
            const active = loadActivePolicy(store);
            writeDeterministic({ active: active.active, policy_hash: policyHash(active.policy) });
            return;
        }
        if (subcommand === "history") {
            const eventPath = policyPaths(store).events;
            process.stdout.write(existsSync(eventPath) ? readFileSync(eventPath, "utf8") : "");
            return;
        }
        if (subcommand === "rollback") {
            const version = parseFlag(policyArgv, "--version");
            const key = parseFlag(policyArgv, "--private-key");
            if (!version || !key) throw new Error("--version and --private-key are required");
            const privateKeyPem = readFileSync(path.resolve(key), "utf8");
            const target = loadPolicyByVersion(store, version);
            const active = loadActivePolicy(store).policy;
            const authority = defaultAuthority(privateKeyPem, target.rules);
            const changeRequest = createChangeRequest({
                changeId: parseFlag(policyArgv, "--change-id") ?? `rollback-${version}`,
                basePolicyVersion: active.policy_version,
                proposedPolicy: target,
                reason: parseFlag(policyArgv, "--reason") ?? "policy rollback",
                createdAt: parseFlag(policyArgv, "--created-at") ?? "2026-04-19T00:00:00.000Z"
            });
            const transaction = signTransaction({
                transactionId: parseFlag(policyArgv, "--transaction-id") ?? `txn-rollback-${version}`,
                transactionType: "ROLLBACK",
                changeRequest,
                authority,
                privateKeyPem
            });
            writeDeterministic(commitPolicyEvent(store, transaction, { authorityPrivateKeyPem: privateKeyPem, ...authzOptions(policyArgv, privateKeyPem) }));
            return;
        }
        if (subcommand === "verify") {
            writeDeterministic(verifyPolicyStore(store, parseListFlag(policyArgv, "--receipt-log").map((item) => path.resolve(item))));
            return;
        }
        throw new Error(`Unknown policy command: ${subcommand}`);
    }
    if (command === "boundary") {
        const [subcommand, ...boundaryArgv] = argv;
        const store = path.resolve(parseFlag(boundaryArgv, "--store") ?? process.env.MNDE_POLICY_STORE ?? process.cwd());
        initializePolicyStore(store);
        if (subcommand === "preset") {
            const [presetSubcommand, ...presetArgv] = boundaryArgv;
            if (presetSubcommand === "list") {
                writeDeterministic({ schema_version: "mnde.boundary_preset_list.v1", presets: listPresets() });
                return;
            }
            if (presetSubcommand === "use") {
                const name = parseFlag(presetArgv, "--name");
                const version = parseFlag(presetArgv, "--version");
                if (!name || !version) throw new Error("--name and --version are required");
                const boundarySet = presetToBoundarySet(name, { policyVersion: version, boundarySetId: parseFlag(presetArgv, "--boundary-set-id") ?? `bs-${name}-${version}` });
                writeJsonIfRequested(boundarySet, parseFlag(presetArgv, "--out"));
                return;
            }
            throw new Error(`Unknown boundary preset command: ${presetSubcommand}`);
        }
        if (subcommand === "create") {
            const input = parseFlag(boundaryArgv, "--boundary-set");
            if (!input) throw new Error("--boundary-set is required");
            const boundarySet = canonicalBoundarySet(readStrictJsonFile(input));
            validateBoundarySet(boundarySet);
            const draftPath = path.join(policyPaths(store).boundaryDrafts, `${boundarySet.boundary_set_id}.json`);
            if (existsSync(draftPath)) {
                throw new Error("boundary_draft_already_exists");
            }
            writeFileSync(draftPath, `${canonicalizeJson(boundarySet)}\n`, { encoding: "utf8", flag: "wx" });
            writeDeterministic({ ok: true, boundary_set_id: boundarySet.boundary_set_id, path: draftPath });
            return;
        }
        if (subcommand === "validate") {
            const input = parseFlag(boundaryArgv, "--boundary-set");
            if (!input) throw new Error("--boundary-set is required");
            const result = validateBoundarySet(readStrictJsonFile(input));
            writeDeterministic({ ok: true, boundary_set_hash: result.boundary_set_hash });
            return;
        }
        if (subcommand === "preview") {
            const input = parseFlag(boundaryArgv, "--boundary-set");
            if (!input) throw new Error("--boundary-set is required");
            writeDeterministic(compileBoundarySet(readStrictJsonFile(input)));
            return;
        }
        if (subcommand === "simulate") {
            const input = parseFlag(boundaryArgv, "--boundary-set");
            const key = parseFlag(boundaryArgv, "--private-key");
            if (!input || !key) throw new Error("--boundary-set and --private-key are required");
            const privateKeyPem = readFileSync(path.resolve(key), "utf8");
            const compiled = compileBoundarySet(readStrictJsonFile(input));
            const signedPolicy = signPolicyDocument(compiled.policy, privateKeyPem);
            writeDeterministic(simulatePolicy(store, signedPolicy, parseListFlag(boundaryArgv, "--receipt-log").map((item) => path.resolve(item))));
            return;
        }
        if (subcommand === "diff") {
            const input = parseFlag(boundaryArgv, "--boundary-set");
            if (!input) throw new Error("--boundary-set is required");
            const compiled = compileBoundarySet(readStrictJsonFile(input));
            const active = loadActivePolicy(store).policy;
            writeDeterministic(diffBoundaryCompiledPolicies(active, compiled.policy));
            return;
        }
        if (subcommand === "publish") {
            const input = parseFlag(boundaryArgv, "--boundary-set");
            const key = parseFlag(boundaryArgv, "--private-key");
            const base = parseFlag(boundaryArgv, "--base") ?? "NONE";
            if (!input || !key) throw new Error("--boundary-set and --private-key are required");
            const privateKeyPem = readFileSync(path.resolve(key), "utf8");
            const boundarySet = canonicalBoundarySet(readStrictJsonFile(input));
            validateBoundarySet(boundarySet);
            const compiled = compileBoundarySet(boundarySet);
            const signedPolicy = signPolicyDocument(compiled.policy, privateKeyPem);
            const draftPolicyPath = path.join(policyPaths(store).policyDrafts, `${signedPolicy.policy_version}.json`);
            if (!existsSync(draftPolicyPath)) {
                writeFileSync(draftPolicyPath, `${canonicalizeJson(signedPolicy)}\n`, { encoding: "utf8", flag: "wx" });
            }
            const draftBoundaryPath = path.join(policyPaths(store).boundaryDrafts, `${boundarySet.boundary_set_id}.json`);
            if (!existsSync(draftBoundaryPath)) {
                writeFileSync(draftBoundaryPath, `${canonicalizeJson(boundarySet)}\n`, { encoding: "utf8", flag: "wx" });
            }
            const authority = defaultAuthority(privateKeyPem, signedPolicy.rules);
            const changeRequest = createChangeRequest({
                changeId: parseFlag(boundaryArgv, "--change-id") ?? `boundary-change-${signedPolicy.policy_version}`,
                basePolicyVersion: base,
                proposedPolicy: signedPolicy,
                reason: parseFlag(boundaryArgv, "--reason") ?? "boundary policy publish",
                createdAt: parseFlag(boundaryArgv, "--created-at") ?? "2026-04-19T00:00:00.000Z"
            });
            const transaction = signTransaction({
                transactionId: parseFlag(boundaryArgv, "--transaction-id") ?? `boundary-txn-${signedPolicy.policy_version}`,
                transactionType: "PUBLISH",
                changeRequest,
                authority,
                privateKeyPem
            });
            writeDeterministic({
                ...commitPolicyEvent(store, transaction, { authorityPrivateKeyPem: privateKeyPem, ...authzOptions(boundaryArgv, privateKeyPem, "boundary:publish") }),
                boundary_set_hash: compiled.boundary_set_hash
            });
            return;
        }
        if (subcommand === "reason") {
            const code = parseFlag(boundaryArgv, "--code");
            if (!code) throw new Error("--code is required");
            writeDeterministic(translateReason(code));
            return;
        }
        throw new Error(`Unknown boundary command: ${subcommand}`);
    }
    if (command === "receipts") {
        const [subcommand, ...receiptArgv] = argv;
        const vibe = parseFlag(receiptArgv, "--vibe") === "true";
        if (subcommand === "index") {
            const receiptLog = parseFlag(receiptArgv, "--receipt-log");
            const receiptDir = parseFlag(receiptArgv, "--dir");
            const outDir = parseFlag(receiptArgv, "--out");
            const policyStore = parseFlag(receiptArgv, "--policy-store");
            const strict = parseFlag(receiptArgv, "--strict") !== "false";
            if ((!receiptLog && !receiptDir) || !outDir) throw new Error("--receipt-log or --dir, and --out are required");
            const result = await indexReceipts({
                receiptLog: receiptLog ? path.resolve(receiptLog) : null,
                receiptDir: receiptDir ? path.resolve(receiptDir) : null,
                outDir: path.resolve(outDir),
                policyStore: policyStore ? path.resolve(policyStore) : null,
                strict
            });
            writeVibeOrJson(result, vibe);
            if (result.invalid_receipts > 0) {
                process.exitCode = 1;
            }
            return;
        }
        if (subcommand === "show") {
            const receiptFile = parseFlag(receiptArgv, "--file") ?? parseFlag(receiptArgv, "--receipt-file");
            if (!receiptFile) throw new Error("--file is required");
            writeVibeOrJson(showReceipt({ file: path.resolve(receiptFile), translate_reasons: parseFlag(receiptArgv, "--translate-reasons") !== "false" }), vibe);
            return;
        }
        if (subcommand === "find") {
            const indexDir = parseFlag(receiptArgv, "--index") ?? parseFlag(receiptArgv, "--receipt-index");
            if (!indexDir) throw new Error("--index is required");
            writeDeterministic(findReceipts({
                index_dir: path.resolve(indexDir),
                decision: parseFlag(receiptArgv, "--decision"),
                reason_code: parseFlag(receiptArgv, "--reason-code"),
                actor: parseFlag(receiptArgv, "--actor"),
                policy_version: parseFlag(receiptArgv, "--policy-version"),
                execution_id: parseFlag(receiptArgv, "--execution-id")
            }));
            return;
        }
        if (subcommand === "stats") {
            const indexDir = parseFlag(receiptArgv, "--index") ?? parseFlag(receiptArgv, "--receipt-index");
            if (!indexDir) throw new Error("--index is required");
            writeDeterministic(getReceiptStats({ index_dir: path.resolve(indexDir) }));
            return;
        }
        if (subcommand === "proof") {
            const receiptFile = parseFlag(receiptArgv, "--file") ?? parseFlag(receiptArgv, "--receipt-file");
            const proofRoot = parseFlag(receiptArgv, "--proof");
            if (!receiptFile || !proofRoot) throw new Error("--file and --proof are required");
            const result = resolveReceiptProof({ receipt: readReceiptFile(receiptFile), proof_root: path.resolve(proofRoot) });
            writeDeterministic(result);
            if (result.status !== "RESOLVED") process.exitCode = 1;
            return;
        }
        if (subcommand === "export") {
            const result = await buildAuditExport({
                receipts: parseFlag(receiptArgv, "--receipts"),
                proof_root: parseFlag(receiptArgv, "--proof-root"),
                out: parseFlag(receiptArgv, "--out"),
                format: parseFlag(receiptArgv, "--format") ?? "dir",
                strict: parseFlag(receiptArgv, "--strict") !== "false",
                build_timestamp: parseFlag(receiptArgv, "--build-timestamp")
            });
            writeDeterministic(result);
            return;
        }
        if (subcommand === "verify") {
            const policyStore = parseFlag(receiptArgv, "--policy-store");
            if (!policyStore) throw new Error("--policy-store is required");
            let receipt;
            const receiptFile = parseFlag(receiptArgv, "--receipt-file");
            const receiptLog = parseFlag(receiptArgv, "--receipt-log");
            const receiptIndex = parseFlag(receiptArgv, "--receipt-index");
            const receiptHash = parseFlag(receiptArgv, "--receipt-hash");
            if (receiptFile) {
                receipt = readReceiptFile(receiptFile);
            } else if (receiptLog && parseFlag(receiptArgv, "--line")) {
                receipt = readReceiptLogLine(receiptLog, parseFlag(receiptArgv, "--line"));
            } else if (receiptIndex && receiptHash) {
                receipt = loadIndexedReceipt(path.resolve(receiptIndex), receiptHash).receipt;
            } else {
                throw new Error("--receipt-file, --receipt-log with --line, or --receipt-index with --receipt-hash is required");
            }
            const result = verifyReceipt(receipt, path.resolve(policyStore));
            writeVibeOrJson(result, vibe);
            if (result.status !== "VERIFIED") {
                process.exitCode = 1;
            }
            return;
        }
        if (subcommand === "replay") {
            const policyStore = parseFlag(receiptArgv, "--policy-store");
            if (!policyStore) throw new Error("--policy-store is required");
            const receiptFile = parseFlag(receiptArgv, "--receipt-file");
            const receiptLog = parseFlag(receiptArgv, "--receipt-log");
            const receiptIndex = parseFlag(receiptArgv, "--receipt-index");
            let result;
            if (receiptFile) {
                result = replayStatusWithReason(replayReceipt(readReceiptFile(receiptFile), path.resolve(policyStore)));
            } else if (receiptLog) {
                result = await replayReceiptLog(path.resolve(receiptLog), path.resolve(policyStore));
            } else if (receiptIndex) {
                result = replayReceipts(loadAllIndexedReceipts(path.resolve(receiptIndex)), path.resolve(policyStore));
            } else {
                throw new Error("--receipt-file, --receipt-log, or --receipt-index is required");
            }
            const out = parseFlag(receiptArgv, "--out");
            if (out) {
                writeJsonIfRequested(result, out);
            } else {
                writeVibeOrJson(result, vibe);
            }
            if (result.drift === true || result.drift_count > 0 || result.invalid_count > 0) {
                process.exitCode = 1;
            }
            return;
        }
        if (subcommand === "manifest") {
            const receiptIndex = parseFlag(receiptArgv, "--receipt-index");
            if (!receiptIndex) throw new Error("--receipt-index is required");
            writeDeterministic(validateIndexManifest(path.resolve(receiptIndex)));
            return;
        }
        throw new Error(`Unknown receipts command: ${subcommand}`);
    }
    if (command === "authz") {
        const [subcommand, ...authzArgv] = argv;
        const store = path.resolve(parseFlag(authzArgv, "--store") ?? process.env.MNDE_AUTHZ_STORE ?? process.cwd());
        if (subcommand === "role-policy-publish") {
            const key = parseFlag(authzArgv, "--private-key");
            const version = parseFlag(authzArgv, "--version") ?? "roles.v1";
            if (!key) throw new Error("--private-key is required");
            const privateKeyPem = readFileSync(path.resolve(key), "utf8");
            writeDeterministic(publishRolePolicy(store, createRolePolicy(version, privateKeyPem), privateKeyPem, parseFlag(authzArgv, "--created-at") ?? "2026-04-19T00:00:00.000Z"));
            return;
        }
        if (subcommand === "assign") {
            const key = parseFlag(authzArgv, "--private-key");
            if (!key) throw new Error("--private-key is required");
            const privateKeyPem = readFileSync(path.resolve(key), "utf8");
            const actorPublicKey = parseFlag(authzArgv, "--actor-public-key") ?? publicKeyRawHexFromPrivatePem(privateKeyPem);
            const assignment = {
                assignment_id: parseFlag(authzArgv, "--assignment-id"),
                actor_key_id: parseFlag(authzArgv, "--target-actor-key-id") ?? keyIdFromRawPublicKey(actorPublicKey),
                actor_public_key: actorPublicKey,
                role: parseFlag(authzArgv, "--role"),
                scopes: parseListFlag(authzArgv, "--scope-grant"),
                scope: parseFlag(authzArgv, "--resource-scope") ? readJsonFile(parseFlag(authzArgv, "--resource-scope")) : {},
                limits: parseFlag(authzArgv, "--limits") ? readJsonFile(parseFlag(authzArgv, "--limits")) : {},
                not_before: parseFlag(authzArgv, "--not-before") ?? "2026-01-01T00:00:00.000Z",
                expires_at: parseFlag(authzArgv, "--expires-at") ?? "2099-12-31T00:00:00.000Z",
                delegated_by_assignment_id: parseFlag(authzArgv, "--delegated-by")
            };
            writeDeterministic(assignRole(store, assignment, privateKeyPem, parseFlag(authzArgv, "--created-at") ?? "2026-04-19T00:00:01.000Z", assignment.role === "root_admin" && !assignment.delegated_by_assignment_id ? {} : {
                actorKeyId: parseFlag(authzArgv, "--actor-key-id"),
                authzReceiptPrivateKeyPem: privateKeyPem
            }));
            return;
        }
        if (subcommand === "revoke") {
            const key = parseFlag(authzArgv, "--private-key");
            const actorKeyId = parseFlag(authzArgv, "--actor-key-id");
            const assignmentId = parseFlag(authzArgv, "--assignment-id");
            if (!key || !actorKeyId || !assignmentId) throw new Error("--private-key, --actor-key-id and --assignment-id are required");
            const privateKeyPem = readFileSync(path.resolve(key), "utf8");
            writeDeterministic(revokeRole(store, assignmentId, privateKeyPem, parseFlag(authzArgv, "--created-at") ?? "2026-04-19T00:00:02.000Z", { actorKeyId, authzReceiptPrivateKeyPem: privateKeyPem }));
            return;
        }
        if (subcommand === "check") {
            const key = parseFlag(authzArgv, "--receipt-private-key");
            if (!key) throw new Error("--receipt-private-key is required");
            const result = authorizeOrThrow(store, {
                actor_key_id: parseFlag(authzArgv, "--actor-key-id"),
                requested_scope: parseFlag(authzArgv, "--scope"),
                resource_scope: parseFlag(authzArgv, "--resource-scope") ? readJsonFile(parseFlag(authzArgv, "--resource-scope")) : {},
                limits: parseFlag(authzArgv, "--limits") ? readJsonFile(parseFlag(authzArgv, "--limits")) : {},
                timestamp: parseFlag(authzArgv, "--timestamp") ?? "2026-04-19T00:00:00.000Z"
            }, readFileSync(path.resolve(key), "utf8"));
            writeDeterministic(result);
            return;
        }
        if (subcommand === "verify") {
            writeDeterministic(verifyAuthzReceipts(store));
            return;
        }
        throw new Error(`Unknown authz command: ${subcommand}`);
    }
    throw new Error(`Unknown command: ${command}`);
}
function verifyReceiptPublicSignatureWithKey(receipt, publicKeyPem) {
    const { signature: _legacySignature, verifiable_signature, ...payload } = receipt;
    if (!verifiable_signature || typeof verifiable_signature !== "object" || verifiable_signature === null) {
        return false;
    }
    return verifyReceiptPayloadSignature(canonicalizeJson(payload), verifiable_signature.value, publicKeyPem);
}
void main().catch((error) => {
    if (error?.message === "ERR_RELEASE_INTEGRITY_REFUSED" && error.integrity) {
        process.stderr.write(`REFUSE\n${JSON.stringify(error.integrity, null, 2)}\n`);
        process.exit(1);
    }
    process.stderr.write(`${canonicalizeJson(deterministicError(error, "ERR_CLI_INPUT"))}\n`);
    process.exit(2);
});
