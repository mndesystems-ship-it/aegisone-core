import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { canonicalizeJson } from "../shared/json.js";
import { executeDeterministicPipeline, makeBaseInput, resetRuntimeState } from "../audit/node_runtime.js";
import { keyIdFromRawPublicKey, publicKeyRawHexFromPrivatePem } from "../policy/crypto.js";
import {
    commitPolicyEvent,
    copyLogsForProof,
    createChangeRequest,
    initializePolicyStore,
    loadActivePolicy,
    loadPolicyByVersion,
    signPolicyDocument,
    signTransaction,
    simulatePolicy,
    verifyPolicyStore
} from "../policy/lifecycle.js";
import { assignRole, copyAuthzLogs, createRolePolicy, publishRolePolicy, verifyAuthzReceipts } from "../authz/lifecycle.js";
import { compileBoundarySet } from "./compiler.js";
import { presetToBoundarySet } from "./presets.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_OUTPUT = path.join(ROOT, "boundary-proof-bundle");
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICWe8yJMfTdHyBVYMPAyeUYav4APtN2SMUsEaVuZLM+E
-----END PRIVATE KEY-----
`;

function writeJson(filePath, value) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendLine(filePath, value) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${value}\n`, { encoding: "utf8", flag: "a" });
}

function authority(limits) {
    const public_key = publicKeyRawHexFromPrivatePem(PRIVATE_KEY);
    return {
        schema_version: "mnde.policy_authority.v1",
        authority_id: "boundary-root-authority",
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

function authzStoreForPolicyStore(store) {
    return path.join(path.dirname(store), "authz-store");
}

function publishBoundarySet(store, boundarySet, base, suffix, createdAt) {
    const compiled = compileBoundarySet(boundarySet);
    const signedPolicy = signPolicyDocument(compiled.policy, PRIVATE_KEY);
    const authorityDoc = authority({
        max_total_cost_cents: 1000000,
        allow_auto_scale: false,
        max_gpu_count: 64,
        max_hours: 168,
        require_manual_approval_above_cents: 1000000,
        max_retry_count: 10
    });
    const changeRequest = createChangeRequest({
        changeId: `boundary-change-${suffix}`,
        basePolicyVersion: base,
        proposedPolicy: signedPolicy,
        reason: `boundary proof ${suffix}`,
        createdAt
    });
    const transaction = signTransaction({
        transactionId: `boundary-txn-${suffix}`,
        transactionType: "PUBLISH",
        changeRequest,
        authority: authorityDoc,
        privateKeyPem: PRIVATE_KEY
    });
    const committed = commitPolicyEvent(store, transaction, {
        authorityPrivateKeyPem: PRIVATE_KEY,
        authzStore: authzStoreForPolicyStore(store),
        actorKeyId: authorityDoc.key_id,
        authzReceiptPrivateKeyPem: PRIVATE_KEY,
        authzScope: "boundary:publish"
    });
    return { compiled, signedPolicy, committed };
}

function rollback(store, targetPolicy, activePolicyVersion) {
    const authorityDoc = authority({
        max_total_cost_cents: 1000000,
        allow_auto_scale: false,
        max_gpu_count: 64,
        max_hours: 168,
        require_manual_approval_above_cents: 1000000,
        max_retry_count: 10
    });
    const changeRequest = createChangeRequest({
        changeId: "boundary-change-rollback",
        basePolicyVersion: activePolicyVersion,
        proposedPolicy: targetPolicy,
        reason: "boundary proof rollback",
        createdAt: "2026-04-19T00:00:09.000Z"
    });
    const transaction = signTransaction({
        transactionId: "boundary-txn-rollback",
        transactionType: "ROLLBACK",
        changeRequest,
        authority: authorityDoc,
        privateKeyPem: PRIVATE_KEY
    });
    return commitPolicyEvent(store, transaction, {
        authorityPrivateKeyPem: PRIVATE_KEY,
        authzStore: authzStoreForPolicyStore(store),
        actorKeyId: authorityDoc.key_id,
        authzReceiptPrivateKeyPem: PRIVATE_KEY
    });
}

function runExecution(policy, requestId, overrides, receiptLog) {
    resetRuntimeState();
    const input = makeBaseInput({
        ...overrides,
        execution_request: {
            ...overrides.execution_request,
            request_id: requestId,
            release_request: {
                execution_id: `exec-${requestId}`,
                hold_state: "APPROVED",
                already_consumed: false,
                ...overrides.execution_request?.release_request
            }
        },
        policy_document: policy
    });
    const result = executeDeterministicPipeline(canonicalizeJson(input));
    if ("parse_boundary" in result) {
        throw new Error(`boundary_proof_execution_failed_${requestId}_${result.reason_code}`);
    }
    appendLine(receiptLog, result.receipt_bytes);
    return result.receipt;
}

export function runBoundaryProof(outputDir = DEFAULT_OUTPUT) {
    if (existsSync(outputDir)) {
        rmSync(outputDir, { recursive: true, force: true });
    }
    mkdirSync(outputDir, { recursive: true });
    const store = path.join(outputDir, "store");
    const authzStore = authzStoreForPolicyStore(store);
    initializePolicyStore(store);
    const authzAuthority = authority({
        max_total_cost_cents: 1000000,
        allow_auto_scale: false,
        max_gpu_count: 64,
        max_hours: 168,
        require_manual_approval_above_cents: 1000000,
        max_retry_count: 10
    });
    publishRolePolicy(authzStore, createRolePolicy("roles.v1", PRIVATE_KEY), PRIVATE_KEY, "2026-04-19T00:00:00.000Z");
    assignRole(authzStore, {
        assignment_id: "assign-boundary-root-admin",
        actor_key_id: authzAuthority.key_id,
        actor_public_key: authzAuthority.public_key,
        role: "root_admin",
        scopes: ["*"],
        scope: {},
        limits: authzAuthority.limits,
        not_before: "2026-01-01T00:00:00.000Z",
        expires_at: "2099-12-31T00:00:00.000Z"
    }, PRIVATE_KEY, "2026-04-19T00:00:01.000Z");
    const receiptLog = path.join(outputDir, "decision_receipts.jsonl");
    const baseBoundarySet = presetToBoundarySet("gpu-experiment", {
        policyVersion: "boundary.policy.v1",
        boundarySetId: "bs-proof-gpu"
    });
    const repeatedCompileA = compileBoundarySet(baseBoundarySet);
    const repeatedCompileB = compileBoundarySet(baseBoundarySet);
    const basePublish = publishBoundarySet(store, baseBoundarySet, "NONE", "publish-v1", "2026-04-19T00:00:01.000Z");
    const activeBase = loadActivePolicy(store).policy;
    const allowReceipt = runExecution(activeBase, "boundary-proof-allow", { execution_request: { resources: { gpu_count: 1, hours: 1 }, runtime_observation: { actual_gpu_count: 1, actual_hours: 1, actual_total_cost_cents: 500 } } }, receiptLog);
    const refuseReceipt = runExecution(activeBase, "boundary-proof-refuse", { execution_request: { resources: { gpu_count: 2 } } }, receiptLog);
    const nextBoundarySet = presetToBoundarySet("ship-mode", {
        policyVersion: "boundary.policy.v2",
        boundarySetId: "bs-proof-ship"
    });
    const nextCompiled = compileBoundarySet(nextBoundarySet);
    const nextSignedPolicy = signPolicyDocument(nextCompiled.policy, PRIVATE_KEY);
    const simulation = simulatePolicy(store, nextSignedPolicy, [receiptLog]);
    writeJson(path.join(outputDir, "simulation_report.json"), simulation);
    publishBoundarySet(store, nextBoundarySet, "boundary.policy.v1", "publish-v2", "2026-04-19T00:00:02.000Z");
    const activeNext = loadActivePolicy(store).policy;
    const afterReceipt = runExecution(activeNext, "boundary-proof-after", { execution_request: { resources: { gpu_count: 2, hours: 2 }, runtime_observation: { actual_gpu_count: 2, actual_hours: 2, actual_total_cost_cents: 2000 } } }, receiptLog);
    rollback(store, loadPolicyByVersion(store, "boundary.policy.v1"), "boundary.policy.v2");
    const activeRollback = loadActivePolicy(store).policy;
    const rollbackReceipt = runExecution(activeRollback, "boundary-proof-rollback", { execution_request: { resources: { gpu_count: 2 } } }, receiptLog);
    const replay = verifyPolicyStore(store, [receiptLog]);
    const authzReplay = verifyAuthzReceipts(authzStore);
    writeJson(path.join(outputDir, "replay_report.json"), replay);
    copyLogsForProof(store, outputDir);
    copyAuthzLogs(authzStore, outputDir);
    const summary = {
        schema_version: "mnde.boundary_proof_summary.v1",
        identical_boundary_input_identical_policy_hash: repeatedCompileA.policy_preview_hash === repeatedCompileB.policy_preview_hash,
        unsafe_run_never_starts: refuseReceipt.decision_output.decision === "REFUSE" && refuseReceipt.decision_output.reason_code === "ERR_GPU_LIMIT",
        reason_codes_stable: [
            allowReceipt.decision_output.reason_code,
            refuseReceipt.decision_output.reason_code,
            afterReceipt.decision_output.reason_code,
            rollbackReceipt.decision_output.reason_code
        ],
        receipts_verifiable: replay.drift_count === 0 && authzReplay.drift_count === 0,
        rollback_works_with_boundary_generated_policies: rollbackReceipt.decision_output.decision === "REFUSE",
        zero_drift: replay.drift_count === 0 && authzReplay.drift_count === 0,
        base_boundary_set_hash: basePublish.compiled.boundary_set_hash,
        output_dir: outputDir
    };
    writeJson(path.join(outputDir, "summary.json"), summary);
    return { summary, simulation, replay, output_dir: outputDir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT;
    const result = runBoundaryProof(outputDir);
    process.stdout.write(`${canonicalizeJson(result.summary)}\n`);
}
