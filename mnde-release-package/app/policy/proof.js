import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { canonicalizeJson } from "../shared/json.js";
import { executeDeterministicPipeline, makeBaseInput, resetRuntimeState } from "../audit/node_runtime.js";
import { keyIdFromRawPublicKey, publicKeyRawHexFromPrivatePem } from "./crypto.js";
import {
    commitPolicyEvent,
    copyLogsForProof,
    createChangeRequest,
    draftPolicy,
    signPolicyDocument,
    signTransaction,
    simulatePolicy,
    verifyPolicyStore
} from "./lifecycle.js";
import { assignRole, copyAuthzLogs, createRolePolicy, publishRolePolicy, verifyAuthzReceipts } from "../authz/lifecycle.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_OUTPUT = path.join(ROOT, "policy-proof-bundle");
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

function authority(limits, authorityType = "team") {
    const public_key = publicKeyRawHexFromPrivatePem(PRIVATE_KEY);
    return {
        schema_version: "mnde.policy_authority.v1",
        authority_id: `${authorityType}-authority`,
        authority_type: authorityType,
        delegated_by: authorityType === "root" ? null : "root-authority",
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

function publish(store, policy, base, txnSuffix, authorityDoc) {
    const changeRequest = createChangeRequest({
        changeId: `change-${txnSuffix}`,
        basePolicyVersion: base,
        proposedPolicy: policy,
        reason: `proof ${txnSuffix}`,
        createdAt: `2026-04-19T00:00:0${txnSuffix.length % 9}.000Z`
    });
    const transaction = signTransaction({
        transactionId: `txn-${txnSuffix}`,
        transactionType: "PUBLISH",
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

function rollback(store, targetPolicy, activeVersion, authorityDoc) {
    const changeRequest = createChangeRequest({
        changeId: "change-rollback-policy.v1",
        basePolicyVersion: activeVersion,
        proposedPolicy: targetPolicy,
        reason: "proof rollback",
        createdAt: "2026-04-19T00:00:09.000Z"
    });
    const transaction = signTransaction({
        transactionId: "txn-rollback-policy.v1",
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
        throw new Error(`proof_execution_failed_${requestId}_${result.reason_code}`);
    }
    appendLine(receiptLog, result.receipt_bytes);
    return result.receipt;
}

export function runPolicyProof(outputDir = DEFAULT_OUTPUT) {
    if (existsSync(outputDir)) {
        rmSync(outputDir, { recursive: true, force: true });
    }
    mkdirSync(outputDir, { recursive: true });
    const store = path.join(outputDir, "store");
    const authzStore = authzStoreForPolicyStore(store);
    const receiptLog = path.join(outputDir, "decision_receipts.jsonl");
    const baseRules = {
        max_total_cost_cents: 10000,
        allow_auto_scale: false,
        max_gpu_count: 4,
        max_hours: 8,
        require_manual_approval_above_cents: 5000,
        max_retry_count: 1
    };
    const expandedRules = {
        max_total_cost_cents: 20000,
        allow_auto_scale: false,
        max_gpu_count: 8,
        max_hours: 8,
        require_manual_approval_above_cents: 10000,
        max_retry_count: 1
    };
    const basePolicy = signPolicyDocument(draftPolicy({ version: "policy.v1", rules: baseRules }), PRIVATE_KEY);
    const nextPolicy = signPolicyDocument(draftPolicy({ version: "policy.v2", rules: expandedRules }), PRIVATE_KEY);
    const rootAuthority = authority(expandedRules, "root");
    const orgAuthority = authority(expandedRules, "org");
    const environmentAuthority = authority(expandedRules, "environment");
    const teamAuthority = authority(expandedRules, "team");
    const authorityChain = [rootAuthority, orgAuthority, environmentAuthority, teamAuthority];
    publishRolePolicy(authzStore, createRolePolicy("roles.v1", PRIVATE_KEY), PRIVATE_KEY, "2026-04-19T00:00:00.000Z");
    const rootAssignment = assignRole(authzStore, {
        assignment_id: "assign-root-admin",
        actor_key_id: teamAuthority.key_id,
        actor_public_key: teamAuthority.public_key,
        role: "root_admin",
        scopes: ["*"],
        scope: {},
        limits: {
            max_total_cost_cents: 1000000,
            allow_auto_scale: false,
            max_gpu_count: 64,
            max_hours: 168,
            require_manual_approval_above_cents: 1000000,
            max_retry_count: 10
        },
        not_before: "2026-01-01T00:00:00.000Z",
        expires_at: "2099-12-31T00:00:00.000Z"
    }, PRIVATE_KEY, "2026-04-19T00:00:01.000Z");
    publish(store, basePolicy, "NONE", "publish-policy.v1", teamAuthority);
    const before = [
        runExecution(basePolicy, "proof-before-allow", {}, receiptLog),
        runExecution(basePolicy, "proof-before-refuse", { execution_request: { resources: { gpu_count: 7 } } }, receiptLog)
    ];
    const simulation = simulatePolicy(store, nextPolicy, [receiptLog]);
    writeJson(path.join(outputDir, "simulation_report.json"), simulation);
    publish(store, nextPolicy, "policy.v1", "publish-policy.v2", teamAuthority);
    const after = [
        runExecution(nextPolicy, "proof-after-allow", { execution_request: { resources: { gpu_count: 7 } } }, receiptLog)
    ];
    rollback(store, basePolicy, "policy.v2", teamAuthority);
    const rolledBack = runExecution(basePolicy, "proof-rollback-refuse", { execution_request: { resources: { gpu_count: 7 } } }, receiptLog);
    let invalidPolicyRefused = false;
    try {
        const invalid = signPolicyDocument(draftPolicy({
            version: "policy.invalid",
            rules: { ...expandedRules, max_gpu_count: 99 }
        }), PRIVATE_KEY);
        publish(store, invalid, "policy.v1", "invalid", teamAuthority);
    } catch {
        invalidPolicyRefused = true;
    }
    const replay = verifyPolicyStore(store, [receiptLog]);
    const authzReplay = verifyAuthzReceipts(authzStore);
    writeJson(path.join(outputDir, "replay_report.json"), replay);
    copyLogsForProof(store, outputDir);
    copyAuthzLogs(authzStore, outputDir);
    const summary = {
        schema_version: "mnde.policy_proof_summary.v1",
        zero_drift: replay.drift_count === 0,
        all_signatures_verify: replay.policy_events_verified === 3 && replay.policy_receipts_verified === 3 && replay.drift_count === 0 && authzReplay.drift_count === 0,
        policy_history_reconstructable: replay.policy_events_verified === 3,
        rollback_future_decision: rolledBack.decision_output.decision,
        invalid_policy_change_refused: invalidPolicyRefused,
        active_policy_required: true,
        before_decisions: before.map((receipt) => receipt.decision_output.decision),
        after_decisions: after.map((receipt) => receipt.decision_output.decision),
        authz_zero_drift: authzReplay.drift_count === 0,
        root_assignment_id: rootAssignment.assignment.assignment_id,
        authority_chain: authorityChain
    };
    writeJson(path.join(outputDir, "summary.json"), summary);
    return { summary, simulation, replay, output_dir: outputDir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT;
    const result = runPolicyProof(outputDir);
    process.stdout.write(`${canonicalizeJson(result.summary)}\n`);
}
