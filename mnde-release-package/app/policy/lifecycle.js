import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { canonicalizeJson } from "../shared/json.js";
import { hashCanonicalJson, sha256Hex } from "../shared/hash.js";
import { canonicalPolicyPayload, policyHash } from "../shared/policy-trust.js";
import { executeDeterministicPipeline, resetRuntimeState } from "../audit/node_runtime.js";
import { verifyReceiptSignature } from "../ramona/engine.js";
import { keyIdFromRawPublicKey, publicKeyRawHexFromPrivatePem, signCanonicalPayload, verifyCanonicalPayload } from "./crypto.js";
import { authorizeOrThrow } from "../authz/lifecycle.js";
import {
    parseStrictJsonFileText,
    validatePolicyAuthorityDocument,
    validatePolicyChangeRequest,
    validatePolicyChangeTransaction,
    validatePolicyExceptionDocument,
    validatePolicyDocument,
    validatePolicyUpdateReceipt
} from "./schema.js";

const ZERO_HASH = "0".repeat(64);
const EVENT_TYPES = new Set(["POLICY_PUBLISHED", "POLICY_ROLLED_BACK"]);

function nowIso() {
    return new Date().toISOString();
}

function ensureStore(root) {
    for (const dir of ["policies", "policy-events", "policy-receipts", "policy-index", "policy-drafts", "boundary-drafts", "policy-exceptions"]) {
        mkdirSync(path.join(root, dir), { recursive: true });
    }
}

function atomicWriteJson(filePath, value) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${canonicalizeJson(value)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(tmp, filePath);
}

function appendJsonl(filePath, value) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${canonicalizeJson(value)}\n`, { encoding: "utf8", flag: "a" });
}

export function paths(root) {
    return {
        policies: path.join(root, "policies"),
        events: path.join(root, "policy-events", "policy_events.jsonl"),
        receipts: path.join(root, "policy-receipts", "policy_update_receipts.jsonl"),
        active: path.join(root, "policy-index", "active.json"),
        byVersion: path.join(root, "policy-index", "by_version.json"),
        byHash: path.join(root, "policy-index", "by_hash.json"),
        policyDrafts: path.join(root, "policy-drafts"),
        boundaryDrafts: path.join(root, "boundary-drafts"),
        policyExceptions: path.join(root, "policy-exceptions")
    };
}

export function initializePolicyStore(storeRoot) {
    ensureStore(storeRoot);
    return paths(storeRoot);
}

function readJsonIfExists(filePath, fallback) {
    if (!existsSync(filePath)) {
        return fallback;
    }
    return parseStrictJsonFileText(readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
    if (!existsSync(filePath)) {
        return [];
    }
    const text = readFileSync(filePath, "utf8").trim();
    if (!text) {
        return [];
    }
    return text.split(/\r?\n/).map((line) => parseStrictJsonFileText(line));
}

export function signPolicyDocument(policy, privateKeyPem) {
    validatePolicyDocument(policy);
    const public_key = publicKeyRawHexFromPrivatePem(privateKeyPem);
    const key_id = keyIdFromRawPublicKey(public_key);
    const unsigned = {
        schema_version: policy.schema_version,
        policy_version: policy.policy_version,
        rules: policy.rules
    };
    const signature = signCanonicalPayload(canonicalPolicyPayload(unsigned), privateKeyPem);
    const signed = {
        ...unsigned,
        trust: {
            key_version: "ed25519.v1",
            key_id,
            public_key,
            signature
        }
    };
    validatePolicyDocument(signed, { requireTrust: true });
    return signed;
}

export function draftPolicy({ version, rules }) {
    const policy = {
        schema_version: "ecs.policy.v1",
        policy_version: version,
        rules
    };
    validatePolicyDocument(policy);
    return policy;
}

export function createChangeRequest({ changeId, basePolicyVersion, proposedPolicy, reason, createdAt = nowIso() }) {
    const request = {
        schema_version: "mnde.policy_change_request.v1",
        change_id: changeId,
        base_policy_version: basePolicyVersion,
        proposed_policy: proposedPolicy,
        reason,
        created_at: createdAt
    };
    validatePolicyChangeRequest(request);
    return request;
}

function transactionPayload(transaction) {
    const { signature: _signature, ...payload } = transaction;
    return payload;
}

export function signTransaction({ transactionId, transactionType, changeRequest, authority, privateKeyPem }) {
    validatePolicyChangeRequest(changeRequest);
    validatePolicyAuthorityDocument(authority);
    if (authority.revoked) {
        throw new Error("authority_revoked");
    }
    if (authority.key_id !== publicAuthorityKeyId(privateKeyPem)) {
        throw new Error("authority_private_key_mismatch");
    }
    const timestamp = Date.parse(changeRequest.created_at);
    if (timestamp < Date.parse(authority.not_before) || timestamp > Date.parse(authority.expires_at)) {
        throw new Error("authority_not_active_for_transaction");
    }
    enforceAuthorityLimits(changeRequest.proposed_policy.rules, authority.limits);
    const base = {
        schema_version: "mnde.policy_change_transaction.v1",
        transaction_id: transactionId,
        transaction_type: transactionType,
        change_request: changeRequest,
        authority,
        policy_hash: policyHash(changeRequest.proposed_policy)
    };
    const signature = {
        algorithm: "ed25519.v1",
        key_id: authority.key_id,
        value: signCanonicalPayload(canonicalizeJson(base), privateKeyPem)
    };
    const transaction = { ...base, signature };
    validatePolicyChangeTransaction(transaction);
    return transaction;
}

function publicAuthorityKeyId(privateKeyPem) {
    return keyIdFromRawPublicKey(publicKeyRawHexFromPrivatePem(privateKeyPem));
}

function enforceAuthorityLimits(rules, limits) {
    if (rules.max_total_cost_cents > limits.max_total_cost_cents ||
        rules.max_gpu_count > limits.max_gpu_count ||
        rules.max_hours > limits.max_hours ||
        rules.max_retry_count > limits.max_retry_count ||
        rules.require_manual_approval_above_cents > limits.require_manual_approval_above_cents ||
        (rules.allow_auto_scale && !limits.allow_auto_scale)) {
        throw new Error("policy_exceeds_authority_limits");
    }
}

export function verifyTransaction(transaction) {
    validatePolicyChangeTransaction(transaction);
    enforceAuthorityLimits(transaction.change_request.proposed_policy.rules, transaction.authority.limits);
    const ok = verifyCanonicalPayload(canonicalizeJson(transactionPayload(transaction)), transaction.signature.value, transaction.authority.public_key);
    if (!ok || transaction.signature.key_id !== transaction.authority.key_id) {
        throw new Error("transaction_signature_invalid");
    }
    if (transaction.policy_hash !== policyHash(transaction.change_request.proposed_policy)) {
        throw new Error("transaction_policy_hash_mismatch");
    }
    return { ok: true };
}

function loadIndexes(storeRoot) {
    const p = paths(storeRoot);
    return {
        byVersion: readJsonIfExists(p.byVersion, {}),
        byHash: readJsonIfExists(p.byHash, {}),
        active: readJsonIfExists(p.active, null)
    };
}

function lastEventHash(storeRoot) {
    const events = readJsonl(paths(storeRoot).events);
    let previous = ZERO_HASH;
    for (const event of events) {
        if (!EVENT_TYPES.has(event.event_type) || event.previous_event_hash !== previous) {
            throw new Error("policy_event_log_hash_chain_invalid");
        }
        const { event_hash: stored, ...payload } = event;
        const actual = hashCanonicalJson(payload);
        if (actual !== stored) {
            throw new Error("policy_event_hash_invalid");
        }
        previous = stored;
    }
    return previous;
}

function makeEvent(storeRoot, type, transaction, activePolicy) {
    const base = {
        schema_version: "mnde.policy_event.v1",
        event_type: type,
        event_id: sha256Hex(canonicalizeJson({
            type,
            transaction_id: transaction.transaction_id,
            policy_hash: policyHash(activePolicy)
        })),
        transaction,
        policy_version: activePolicy.policy_version,
        policy_hash: policyHash(activePolicy),
        previous_event_hash: lastEventHash(storeRoot),
        committed_at: transaction.change_request.created_at
    };
    return { ...base, event_hash: hashCanonicalJson(base) };
}

function makeReceipt(event, activePolicy, privateKeyPem, keyId) {
    const base = {
        schema_version: "mnde.policy_update_receipt.v1",
        transaction_id: event.transaction.transaction_id,
        policy_version: event.transaction.change_request.proposed_policy.policy_version,
        policy_hash: event.transaction.policy_hash,
        event_hash: event.event_hash,
        active_policy_version: activePolicy.policy_version,
        active_policy_hash: policyHash(activePolicy)
    };
    const receiptHash = hashCanonicalJson(base);
    const withHash = { ...base, receipt_hash: receiptHash };
    const receipt = {
        ...withHash,
        signature: {
            algorithm: "ed25519.v1",
            key_id: keyId,
            value: signCanonicalPayload(canonicalizeJson(withHash), privateKeyPem)
        }
    };
    validatePolicyUpdateReceipt(receipt);
    return receipt;
}

export function commitPolicyEvent(storeRoot, transaction, options = {}) {
    ensureStore(storeRoot);
    verifyTransaction(transaction);
    if (!options.authzStore || !options.actorKeyId || !options.authzReceiptPrivateKeyPem) {
        throw new Error("authz_required");
    }
    authorizeOrThrow(options.authzStore, {
        actor_key_id: options.actorKeyId,
        requested_scope: options.authzScope ?? (transaction.transaction_type === "ROLLBACK" ? "policy:rollback" : "policy:publish"),
        resource_scope: options.resourceScope ?? {},
        limits: transaction.change_request.proposed_policy.rules,
        timestamp: transaction.change_request.created_at,
        action: {
            type: transaction.transaction_type,
            transaction_id: transaction.transaction_id,
            policy_version: transaction.change_request.proposed_policy.policy_version,
            policy_hash: transaction.policy_hash
        }
    }, options.authzReceiptPrivateKeyPem);
    if (options.allowedKeyIds && !options.allowedKeyIds.includes(transaction.authority.key_id)) {
        throw new Error("authority_key_not_allow_listed");
    }
    const p = paths(storeRoot);
    const indexes = loadIndexes(storeRoot);
    const proposed = transaction.change_request.proposed_policy;
    const proposedHash = policyHash(proposed);
    if (transaction.transaction_type === "PUBLISH" && indexes.byVersion[proposed.policy_version]) {
        throw new Error("policy_version_already_exists");
    }
    if (transaction.change_request.base_policy_version !== "NONE" && !indexes.byVersion[transaction.change_request.base_policy_version]) {
        throw new Error("base_policy_missing");
    }
    if (transaction.transaction_type === "ROLLBACK" && !indexes.byVersion[proposed.policy_version]) {
        throw new Error("rollback_target_missing");
    }
    const type = transaction.transaction_type === "ROLLBACK" ? "POLICY_ROLLED_BACK" : "POLICY_PUBLISHED";
    const activePolicy = proposed;
    const event = makeEvent(storeRoot, type, transaction, activePolicy);
    const signerPrivateKey = options.receiptPrivateKeyPem ?? options.authorityPrivateKeyPem;
    const signerKeyId = options.receiptKeyId ?? transaction.authority.key_id;
    const receipt = makeReceipt(event, activePolicy, signerPrivateKey, signerKeyId);
    if (transaction.transaction_type === "PUBLISH") {
        atomicWriteJson(path.join(p.policies, `${proposed.policy_version}.signed.json`), proposed);
    }
    appendJsonl(p.events, event);
    appendJsonl(p.receipts, receipt);
    const policyPath = path.join("policies", `${proposed.policy_version}.signed.json`);
    const nextByVersion = {
        ...indexes.byVersion,
        [proposed.policy_version]: {
            policy_hash: proposedHash,
            path: policyPath,
            published_event_hash: event.event_hash
        }
    };
    const nextByHash = {
        ...indexes.byHash,
        [proposedHash]: {
            policy_version: proposed.policy_version,
            path: policyPath,
            published_event_hash: nextByVersion[proposed.policy_version].published_event_hash
        }
    };
    atomicWriteJson(p.byVersion, nextByVersion);
    atomicWriteJson(p.byHash, nextByHash);
    atomicWriteJson(p.active, {
        schema_version: "mnde.active_policy.v1",
        policy_version: proposed.policy_version,
        policy_hash: proposedHash,
        path: policyPath,
        activation_event_hash: event.event_hash
    });
    return { event, receipt, active: readJsonIfExists(p.active, null) };
}

export function loadPolicyByVersion(storeRoot, version) {
    const indexes = loadIndexes(storeRoot);
    const entry = indexes.byVersion[version];
    if (!entry) {
        throw new Error("policy_version_not_found");
    }
    const policy = parseStrictJsonFileText(readFileSync(path.join(storeRoot, entry.path), "utf8"));
    validatePolicyDocument(policy, { requireTrust: true });
    if (policyHash(policy) !== entry.policy_hash) {
        throw new Error("policy_hash_mismatch");
    }
    return policy;
}

export function loadActivePolicy(storeRoot) {
    const indexes = loadIndexes(storeRoot);
    if (!indexes.active) {
        throw new Error("active_policy_missing");
    }
    const policy = loadPolicyByVersion(storeRoot, indexes.active.policy_version);
    if (policyHash(policy) !== indexes.active.policy_hash) {
        throw new Error("active_policy_hash_mismatch");
    }
    const events = readJsonl(paths(storeRoot).events);
    if (!events.some((event) => event.event_hash === indexes.active.activation_event_hash && event.policy_hash === indexes.active.policy_hash)) {
        throw new Error("active_activation_event_missing");
    }
    return { policy, active: indexes.active };
}

export function lookupPolicy(storeRoot, query) {
    const indexes = loadIndexes(storeRoot);
    if (query.version) {
        return loadPolicyByVersion(storeRoot, query.version);
    }
    if (query.hash) {
        const entry = indexes.byHash[query.hash];
        if (!entry) {
            throw new Error("policy_hash_not_found");
        }
        return loadPolicyByVersion(storeRoot, entry.policy_version);
    }
    if (query.timestamp) {
        const at = Date.parse(query.timestamp);
        let selected = null;
        for (const event of readJsonl(paths(storeRoot).events)) {
            if (Date.parse(event.committed_at) <= at) {
                selected = event.policy_version;
            }
        }
        if (!selected) {
            throw new Error("policy_timestamp_not_found");
        }
        return loadPolicyByVersion(storeRoot, selected);
    }
    return loadActivePolicy(storeRoot).policy;
}

export function simulatePolicy(storeRoot, proposedPolicy, receiptPaths) {
    validatePolicyDocument(proposedPolicy, { requireTrust: true });
    const current = loadActivePolicy(storeRoot).policy;
    const receipts = [];
    for (const receiptPath of receiptPaths) {
        if (!existsSync(receiptPath)) {
            continue;
        }
        const text = readFileSync(receiptPath, "utf8").trim();
        if (!text) {
            continue;
        }
        receipts.push(...text.split(/\r?\n/).map((line) => parseStrictJsonFileText(line)));
    }
    const topReasons = new Map();
    let currentAllows = 0;
    let currentRefuses = 0;
    let newAllows = 0;
    let newRefuses = 0;
    let changed = 0;
    let costDeltaCents = 0;
    for (const receipt of receipts) {
        if (!verifyReceiptSignature(receipt)) {
            throw new Error("historical_receipt_signature_invalid");
        }
        const historicalInput = parseStrictJsonFileText(receipt.canonical_request);
        resetRuntimeState();
        const currentRun = executeDeterministicPipeline(canonicalizeJson({ ...historicalInput, policy_document: current }));
        resetRuntimeState();
        const newRun = executeDeterministicPipeline(canonicalizeJson({ ...historicalInput, policy_document: proposedPolicy }));
        if ("parse_boundary" in currentRun || "parse_boundary" in newRun) {
            throw new Error("simulation_replay_failed");
        }
        const currentDecision = currentRun.receipt.decision_output;
        const newDecision = newRun.receipt.decision_output;
        currentDecision.decision === "ALLOW" ? currentAllows += 1 : currentRefuses += 1;
        newDecision.decision === "ALLOW" ? newAllows += 1 : newRefuses += 1;
        if (currentDecision.decision_hash !== newDecision.decision_hash) {
            changed += 1;
            const reason = `${currentDecision.reason_code}->${newDecision.reason_code}`;
            topReasons.set(reason, (topReasons.get(reason) ?? 0) + 1);
        }
        costDeltaCents += centsFromUsd(newDecision.prevented_cost_usd) - centsFromUsd(currentDecision.prevented_cost_usd);
    }
    return {
        schema_version: "mnde.policy_simulation_report.v1",
        total_sampled: receipts.length,
        current_allows: currentAllows,
        current_refuses: currentRefuses,
        new_allows: newAllows,
        new_refuses: newRefuses,
        changed_decisions: changed,
        cost_delta_cents: costDeltaCents,
        top_changed_reasons: [...topReasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([reason, count]) => ({ reason, count }))
    };
}

function centsFromUsd(value) {
    const match = /^(\d+)\.(\d{2})$/.exec(value);
    if (!match) {
        throw new Error("invalid_usd_string");
    }
    return Number(match[1]) * 100 + Number(match[2]);
}

export function diffPolicies(left, right) {
    validatePolicyDocument(left, { requireTrust: true });
    validatePolicyDocument(right, { requireTrust: true });
    const changes = [];
    for (const key of POLICY_RULE_KEYS_SORTED) {
        if (left.rules[key] !== right.rules[key]) {
            changes.push({ field: `rules.${key}`, from: left.rules[key], to: right.rules[key] });
        }
    }
    return { schema_version: "mnde.policy_diff.v1", from: left.policy_version, to: right.policy_version, changes };
}

function exceptionPayload(exception) {
    const { signature: _signature, ...payload } = exception;
    return payload;
}

export function signPolicyException(exception, privateKeyPem, options = {}) {
    validatePolicyAuthorityDocument(exception.authority);
    if (!options.authzStore || !options.actorKeyId || !options.authzReceiptPrivateKeyPem) {
        throw new Error("authz_required");
    }
    authorizeOrThrow(options.authzStore, {
        actor_key_id: options.actorKeyId,
        requested_scope: "policy:exception:create",
        resource_scope: options.resourceScope ?? {},
        limits: exception.limits,
        timestamp: options.timestamp ?? new Date().toISOString(),
        action: {
            type: "POLICY_EXCEPTION_CREATE",
            exception_id: exception.exception_id,
            policy_version: exception.policy_version
        }
    }, options.authzReceiptPrivateKeyPem);
    if (exception.authority.revoked) {
        throw new Error("authority_revoked");
    }
    if (exception.authority.key_id !== publicAuthorityKeyId(privateKeyPem)) {
        throw new Error("authority_private_key_mismatch");
    }
    enforceAuthorityLimits(exception.limits, exception.authority.limits);
    const base = {
        schema_version: "mnde.policy_exception.v1",
        exception_id: exception.exception_id,
        policy_version: exception.policy_version,
        scope: exception.scope,
        limits: exception.limits,
        expires_at: exception.expires_at,
        single_use: exception.single_use,
        used_at: exception.used_at ?? null,
        authority: exception.authority
    };
    const signed = {
        ...base,
        signature: {
            algorithm: "ed25519.v1",
            key_id: exception.authority.key_id,
            value: signCanonicalPayload(canonicalizeJson(base), privateKeyPem)
        }
    };
    validatePolicyExceptionDocument(signed);
    return signed;
}

export function applyPolicyException(policy, exception, scope, usedExceptionIds = [], timestamp = new Date().toISOString()) {
    validatePolicyDocument(policy, { requireTrust: true });
    validatePolicyExceptionDocument(exception);
    if (exception.policy_version !== policy.policy_version) {
        throw new Error("policy_exception_wrong_policy");
    }
    if (exception.scope !== scope) {
        throw new Error("policy_exception_wrong_scope");
    }
    if (Date.parse(timestamp) > Date.parse(exception.expires_at)) {
        throw new Error("policy_exception_expired");
    }
    if (exception.single_use && (exception.used_at !== null || usedExceptionIds.includes(exception.exception_id))) {
        throw new Error("policy_exception_already_used");
    }
    enforceAuthorityLimits(exception.limits, exception.authority.limits);
    const ok = verifyCanonicalPayload(canonicalizeJson(exceptionPayload(exception)), exception.signature.value, exception.authority.public_key);
    if (!ok || exception.signature.key_id !== exception.authority.key_id) {
        throw new Error("policy_exception_signature_invalid");
    }
    return {
        ...policy,
        rules: {
            ...policy.rules,
            ...exception.limits
        }
    };
}

const POLICY_RULE_KEYS_SORTED = [
    "allow_auto_scale",
    "max_gpu_count",
    "max_hours",
    "max_retry_count",
    "max_total_cost_cents",
    "require_manual_approval_above_cents"
];

export function verifyPolicyStore(storeRoot, receiptPaths = []) {
    loadActivePolicy(storeRoot);
    lastEventHash(storeRoot);
    const events = readJsonl(paths(storeRoot).events);
    const eventByTransaction = new Map(events.map((event) => [event.transaction.transaction_id, event]));
    const policyReceipts = readJsonl(paths(storeRoot).receipts);
    for (const receipt of policyReceipts) {
        validatePolicyUpdateReceipt(receipt);
        const event = eventByTransaction.get(receipt.transaction_id);
        if (!event) {
            throw new Error("policy_receipt_event_missing");
        }
        const { signature, ...payload } = receipt;
        if (!verifyCanonicalPayload(canonicalizeJson(payload), signature.value, event.transaction.authority.public_key)) {
            throw new Error("policy_receipt_signature_invalid");
        }
        verifyTransaction(event.transaction);
    }
    const receiptMismatches = [];
    for (const receiptPath of receiptPaths) {
        if (!existsSync(receiptPath)) {
            continue;
        }
        const text = readFileSync(receiptPath, "utf8").trim();
        if (!text) {
            continue;
        }
        for (const line of text.split(/\r?\n/)) {
            const receipt = parseStrictJsonFileText(line);
            if (!verifyReceiptSignature(receipt)) {
                receiptMismatches.push({ request_hash: receipt.request_hash ?? "unknown", error: "receipt_signature_invalid" });
                continue;
            }
            const policy = loadPolicyByVersion(storeRoot, receipt.decision_output.policy_version);
            const input = parseStrictJsonFileText(receipt.canonical_request);
            resetRuntimeState();
            const replay = executeDeterministicPipeline(canonicalizeJson({ ...input, policy_document: policy }));
            if ("parse_boundary" in replay || replay.receipt.decision_output.decision_hash !== receipt.decision_output.decision_hash) {
                receiptMismatches.push({ request_hash: receipt.request_hash, error: "decision_hash_mismatch" });
            }
        }
    }
    return {
        schema_version: "mnde.policy_verify_report.v1",
        policy_events_verified: readJsonl(paths(storeRoot).events).length,
        policy_receipts_verified: policyReceipts.length,
        decision_receipts_checked: receiptPaths.length,
        drift_count: receiptMismatches.length,
        mismatches: receiptMismatches
    };
}

export function copyLogsForProof(storeRoot, outputDir) {
    mkdirSync(outputDir, { recursive: true });
    const p = paths(storeRoot);
    if (existsSync(p.events)) {
        copyFileSync(p.events, path.join(outputDir, "policy_event_log.jsonl"));
    }
    if (existsSync(p.receipts)) {
        copyFileSync(p.receipts, path.join(outputDir, "policy_receipts.jsonl"));
    }
}
