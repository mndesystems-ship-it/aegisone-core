import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { canonicalizeJson, parseStrictJson } from "../shared/json.js";
import { hashCanonicalJson, sha256Hex } from "../shared/hash.js";
import { keyIdFromRawPublicKey, publicKeyRawHexFromPrivatePem, signCanonicalPayload, verifyCanonicalPayload } from "../policy/crypto.js";

const ZERO_HASH = "0".repeat(64);
const ROLE_ORDER = ["root_admin", "org_admin", "environment_admin", "team_admin", "auditor", "operator", "user"];
const ROLE_PARENTS = {
    root_admin: null,
    org_admin: "root_admin",
    environment_admin: "org_admin",
    team_admin: "environment_admin",
    auditor: "environment_admin",
    operator: "team_admin",
    user: "team_admin"
};
const DEFAULT_SCOPES = {
    root_admin: ["*"],
    org_admin: ["policy:draft", "policy:validate", "policy:simulate", "policy:diff", "policy:sign", "policy:publish", "policy:rollback", "policy:exception:create", "policy:authority:manage", "boundary:publish", "authz:assign", "authz:revoke", "authz:verify", "receipt:verify"],
    environment_admin: ["policy:draft", "policy:validate", "policy:simulate", "policy:diff", "policy:sign", "policy:publish", "policy:rollback", "policy:exception:create", "boundary:publish", "authz:assign", "authz:revoke", "authz:verify", "receipt:verify"],
    team_admin: ["policy:draft", "policy:validate", "policy:simulate", "policy:diff", "policy:publish", "policy:rollback", "policy:exception:create", "boundary:publish", "authz:assign", "authz:revoke", "receipt:verify"],
    auditor: ["policy:active:read", "policy:history", "policy:verify", "authz:history", "authz:verify", "receipt:verify"],
    operator: ["decision:submit", "receipt:verify", "policy:active:read", "policy:simulate"],
    user: ["decision:submit", "receipt:verify", "policy:active:read"]
};

export function paths(root) {
    return {
        rolePolicies: path.join(root, "authz", "role-policies"),
        roleAssignments: path.join(root, "authz", "role-assignments"),
        events: path.join(root, "authz", "authz-events", "authz_events.jsonl"),
        decisionReceipts: path.join(root, "authz", "authz-receipts", "authz_decision_receipts.jsonl"),
        updateReceipts: path.join(root, "authz", "authz-receipts", "authz_update_receipts.jsonl"),
        active: path.join(root, "authz", "authz-index", "active.json"),
        byActor: path.join(root, "authz", "authz-index", "by_actor.json"),
        byAssignment: path.join(root, "authz", "authz-index", "by_assignment.json"),
        byRole: path.join(root, "authz", "authz-index", "by_role.json"),
        byHash: path.join(root, "authz", "authz-index", "by_hash.json")
    };
}

function ensureStore(root) {
    const p = paths(root);
    for (const dir of [p.rolePolicies, p.roleAssignments, path.dirname(p.events), path.dirname(p.decisionReceipts), path.dirname(p.active)]) {
        mkdirSync(dir, { recursive: true });
    }
}

function parseStrict(text) {
    const parsed = parseStrictJson(text);
    if (!parsed.ok) {
        throw new Error(parsed.reason);
    }
    return parsed.value;
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

function readJsonIfExists(filePath, fallback) {
    return existsSync(filePath) ? parseStrict(readFileSync(filePath, "utf8")) : fallback;
}

function readJsonl(filePath) {
    if (!existsSync(filePath)) {
        return [];
    }
    const text = readFileSync(filePath, "utf8").trim();
    return text ? text.split(/\r?\n/).map(parseStrict) : [];
}

function expectString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label}_must_be_string`);
    }
}

function expectObject(value, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label}_must_be_object`);
    }
}

function rejectUnknown(value, keys, label) {
    expectObject(value, label);
    const allowed = new Set(keys);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new Error(`${label}_unknown_${key}`);
        }
    }
}

function validateScope(scope) {
    expectObject(scope, "scope");
    for (const key of Object.keys(scope)) {
        if (!["org_id", "environment", "team"].includes(key) || typeof scope[key] !== "string") {
            throw new Error("scope_invalid");
        }
    }
}

function scopeContains(parent, child) {
    for (const [key, value] of Object.entries(parent)) {
        if (child[key] !== value) {
            return false;
        }
    }
    return true;
}

function scopesContain(parentScopes, childScopes) {
    return parentScopes.includes("*") || childScopes.every((scope) => parentScopes.includes(scope));
}

function limitsContain(parentLimits, childLimits) {
    for (const [key, value] of Object.entries(childLimits ?? {})) {
        const parent = parentLimits?.[key];
        if (typeof value === "boolean") {
            if (value && parent !== true) return false;
        } else if (typeof value === "number") {
            if (!Number.isSafeInteger(value) || typeof parent !== "number" || value > parent) return false;
        } else {
            return false;
        }
    }
    return true;
}

function roleRank(role) {
    const index = ROLE_ORDER.indexOf(role);
    if (index === -1) {
        throw new Error("unknown_role");
    }
    return index;
}

export function createRolePolicy(version, privateKeyPem, roles = DEFAULT_SCOPES) {
    const public_key = publicKeyRawHexFromPrivatePem(privateKeyPem);
    const key_id = keyIdFromRawPublicKey(public_key);
    const roleMap = {};
    for (const role of ROLE_ORDER) {
        roleMap[role] = {
            scopes: [...roles[role]].sort(),
            can_delegate: ["root_admin", "org_admin", "environment_admin", "team_admin"].includes(role)
        };
    }
    const payload = {
        schema_version: "mnde.role_policy.v1",
        role_policy_version: version,
        roles: roleMap
    };
    return {
        ...payload,
        trust: {
            key_version: "ed25519.v1",
            key_id,
            public_key,
            signature: signCanonicalPayload(canonicalizeJson(payload), privateKeyPem)
        }
    };
}

function rolePolicyPayload(policy) {
    const { trust: _trust, ...payload } = policy;
    return payload;
}

export function validateRolePolicy(policy) {
    rejectUnknown(policy, ["schema_version", "role_policy_version", "roles", "trust"], "role_policy");
    if (policy.schema_version !== "mnde.role_policy.v1") throw new Error("role_policy_bad_schema");
    expectString(policy.role_policy_version, "role_policy_version");
    rejectUnknown(policy.trust, ["key_version", "key_id", "public_key", "signature"], "role_policy_trust");
    if (policy.trust.key_version !== "ed25519.v1" || keyIdFromRawPublicKey(policy.trust.public_key) !== policy.trust.key_id) {
        throw new Error("role_policy_trust_invalid");
    }
    if (!verifyCanonicalPayload(canonicalizeJson(rolePolicyPayload(policy)), policy.trust.signature, policy.trust.public_key)) {
        throw new Error("role_policy_signature_invalid");
    }
    for (const role of Object.keys(policy.roles)) {
        roleRank(role);
        if (!Array.isArray(policy.roles[role].scopes)) throw new Error("role_policy_scopes_invalid");
    }
    return { ok: true, role_policy_hash: hashCanonicalJson(rolePolicyPayload(policy)) };
}

export function signRoleAssignment(assignment, privateKeyPem) {
    const public_key = publicKeyRawHexFromPrivatePem(privateKeyPem);
    const signerKeyId = keyIdFromRawPublicKey(public_key);
    const payload = {
        schema_version: "mnde.role_assignment.v1",
        assignment_id: assignment.assignment_id,
        actor_key_id: assignment.actor_key_id,
        actor_public_key: assignment.actor_public_key,
        role: assignment.role,
        scopes: [...assignment.scopes].sort(),
        scope: assignment.scope,
        limits: assignment.limits ?? {},
        not_before: assignment.not_before,
        expires_at: assignment.expires_at,
        delegated_by_assignment_id: assignment.delegated_by_assignment_id ?? null
    };
    validateUnsignedAssignment(payload);
    return {
        ...payload,
        trust: {
            key_version: "ed25519.v1",
            key_id: signerKeyId,
            public_key,
            signature: signCanonicalPayload(canonicalizeJson(payload), privateKeyPem)
        }
    };
}

function assignmentPayload(assignment) {
    const { trust: _trust, ...payload } = assignment;
    return payload;
}

function validateUnsignedAssignment(assignment) {
    rejectUnknown(assignment, ["schema_version", "assignment_id", "actor_key_id", "actor_public_key", "role", "scopes", "scope", "limits", "not_before", "expires_at", "delegated_by_assignment_id"], "role_assignment");
    if (assignment.schema_version !== "mnde.role_assignment.v1") throw new Error("role_assignment_bad_schema");
    for (const key of ["assignment_id", "actor_key_id", "actor_public_key", "role", "not_before", "expires_at"]) expectString(assignment[key], key);
    if (!/^[0-9a-fA-F]{64}$/.test(assignment.actor_public_key) || keyIdFromRawPublicKey(assignment.actor_public_key) !== assignment.actor_key_id) {
        throw new Error("assignment_actor_key_mismatch");
    }
    roleRank(assignment.role);
    if (!Array.isArray(assignment.scopes) || assignment.scopes.some((scope) => typeof scope !== "string")) throw new Error("assignment_scopes_invalid");
    validateScope(assignment.scope);
    expectObject(assignment.limits, "limits");
    if (Date.parse(assignment.not_before) >= Date.parse(assignment.expires_at)) throw new Error("assignment_time_invalid");
}

export function validateRoleAssignment(assignment) {
    validateUnsignedAssignment(assignmentPayload(assignment));
    rejectUnknown(assignment.trust, ["key_version", "key_id", "public_key", "signature"], "role_assignment_trust");
    if (assignment.trust.key_version !== "ed25519.v1" || keyIdFromRawPublicKey(assignment.trust.public_key) !== assignment.trust.key_id) {
        throw new Error("role_assignment_trust_invalid");
    }
    if (!verifyCanonicalPayload(canonicalizeJson(assignmentPayload(assignment)), assignment.trust.signature, assignment.trust.public_key)) {
        throw new Error("role_assignment_signature_invalid");
    }
    return { ok: true, assignment_hash: hashCanonicalJson(assignmentPayload(assignment)) };
}

function lastEventHash(root) {
    let previous = ZERO_HASH;
    for (const event of readJsonl(paths(root).events)) {
        const { event_hash, ...payload } = event;
        if (event.previous_event_hash !== previous || hashCanonicalJson(payload) !== event_hash) {
            throw new Error("authz_event_hash_chain_invalid");
        }
        previous = event_hash;
    }
    return previous;
}

function appendEvent(root, event) {
    const base = { ...event, previous_event_hash: lastEventHash(root) };
    const full = { ...base, event_hash: hashCanonicalJson(base) };
    appendJsonl(paths(root).events, full);
    return full;
}

export function publishRolePolicy(root, rolePolicy, privateKeyPem, committedAt = "2026-04-19T00:00:00.000Z") {
    ensureStore(root);
    validateRolePolicy(rolePolicy);
    const p = paths(root);
    const rolePolicyHash = hashCanonicalJson(rolePolicyPayload(rolePolicy));
    atomicWriteJson(path.join(p.rolePolicies, `${rolePolicy.role_policy_version}.signed.json`), rolePolicy);
    const event = appendEvent(root, {
        schema_version: "mnde.authz_event.v1",
        event_type: "ROLE_POLICY_PUBLISHED",
        event_id: sha256Hex(canonicalizeJson({ type: "ROLE_POLICY_PUBLISHED", role_policy_hash: rolePolicyHash })),
        role_policy_version: rolePolicy.role_policy_version,
        role_policy_hash: rolePolicyHash,
        committed_at: committedAt,
        signature: {
            algorithm: "ed25519.v1",
            key_id: rolePolicy.trust.key_id,
            value: signCanonicalPayload(canonicalizeJson({ role_policy_hash: rolePolicyHash, committed_at: committedAt }), privateKeyPem)
        }
    });
    rebuildAuthzIndexes(root);
    return { event };
}

export function assignRole(root, assignment, signerPrivateKeyPem, committedAt = "2026-04-19T00:00:01.000Z", options = {}) {
    ensureStore(root);
    const existingAssignments = readJsonIfExists(paths(root).byAssignment, {});
    const bootstrap = Object.keys(existingAssignments).length === 0 && !assignment.delegated_by_assignment_id && assignment.role === "root_admin";
    if (!bootstrap) {
        if (!options.actorKeyId || !options.authzReceiptPrivateKeyPem) {
            throw new Error("authz_required");
        }
        authorizeOrThrow(root, {
            actor_key_id: options.actorKeyId,
            requested_scope: "authz:assign",
            resource_scope: assignment.scope,
            limits: assignment.limits ?? {},
            timestamp: committedAt,
            action: { type: "ROLE_ASSIGNED", assignment_id: assignment.assignment_id, role: assignment.role }
        }, options.authzReceiptPrivateKeyPem);
    }
    const signed = assignment.trust ? assignment : signRoleAssignment(assignment, signerPrivateKeyPem);
    const validation = validateRoleAssignment(signed);
    if (signed.delegated_by_assignment_id) {
        const parent = readJsonIfExists(paths(root).byAssignment, {})[signed.delegated_by_assignment_id];
        if (!parent) throw new Error("delegating_assignment_missing");
        enforceDelegation(parent.assignment, signed, committedAt);
    }
    atomicWriteJson(path.join(paths(root).roleAssignments, `${signed.assignment_id}.signed.json`), signed);
    const event = appendEvent(root, {
        schema_version: "mnde.authz_event.v1",
        event_type: "ROLE_ASSIGNED",
        event_id: sha256Hex(canonicalizeJson({ type: "ROLE_ASSIGNED", assignment_id: signed.assignment_id, assignment_hash: validation.assignment_hash })),
        assignment_id: signed.assignment_id,
        assignment_hash: validation.assignment_hash,
        actor_key_id: signed.actor_key_id,
        role: signed.role,
        scope_hash: hashCanonicalJson(signed.scope),
        committed_at: committedAt,
        signature: {
            algorithm: "ed25519.v1",
            key_id: signed.trust.key_id,
            value: signCanonicalPayload(canonicalizeJson({ assignment_hash: validation.assignment_hash, committed_at: committedAt }), signerPrivateKeyPem)
        }
    });
    rebuildAuthzIndexes(root);
    return { assignment: signed, event };
}

export function revokeRole(root, assignmentId, signerPrivateKeyPem, committedAt = "2026-04-19T00:00:02.000Z", options = {}) {
    ensureStore(root);
    if (!options.actorKeyId || !options.authzReceiptPrivateKeyPem) {
        throw new Error("authz_required");
    }
    authorizeOrThrow(root, {
        actor_key_id: options.actorKeyId,
        requested_scope: "authz:revoke",
        resource_scope: options.resourceScope ?? {},
        timestamp: committedAt,
        action: { type: "ROLE_REVOKED", assignment_id: assignmentId }
    }, options.authzReceiptPrivateKeyPem);
    const indexes = verifyAuthzIndexes(root);
    const target = indexes.byAssignment[assignmentId];
    if (!target) throw new Error("assignment_missing");
    const signerKeyId = keyIdFromRawPublicKey(publicKeyRawHexFromPrivatePem(signerPrivateKeyPem));
    const event = appendEvent(root, {
        schema_version: "mnde.authz_event.v1",
        event_type: "ROLE_REVOKED",
        event_id: sha256Hex(canonicalizeJson({ type: "ROLE_REVOKED", assignment_id: assignmentId, committed_at: committedAt })),
        assignment_id: assignmentId,
        actor_key_id: target.assignment.actor_key_id,
        committed_at: committedAt,
        signature: {
            algorithm: "ed25519.v1",
            key_id: signerKeyId,
            value: signCanonicalPayload(canonicalizeJson({ assignment_id: assignmentId, committed_at: committedAt }), signerPrivateKeyPem)
        }
    });
    rebuildAuthzIndexes(root);
    return { event };
}

function enforceDelegation(parent, child, timestamp) {
    if (Date.parse(timestamp) < Date.parse(parent.not_before) || Date.parse(timestamp) > Date.parse(parent.expires_at)) throw new Error("delegating_assignment_not_active");
    if (roleRank(child.role) <= roleRank(parent.role)) throw new Error("child_role_exceeds_parent");
    if (!scopeContains(parent.scope, child.scope)) throw new Error("child_scope_exceeds_parent");
    if (!scopesContain(parent.scopes, child.scopes)) throw new Error("child_scopes_exceed_parent");
    if (!limitsContain(parent.limits, child.limits)) throw new Error("child_limits_exceed_parent");
    if (Date.parse(child.expires_at) > Date.parse(parent.expires_at)) throw new Error("child_outlives_parent");
}

export function rebuildAuthzIndexes(root) {
    ensureStore(root);
    const p = paths(root);
    const byActor = {};
    const byAssignment = {};
    const byRole = {};
    const byHash = {};
    let active = null;
    const revoked = new Set();
    for (const event of readJsonl(p.events)) {
        if (event.event_type === "ROLE_POLICY_PUBLISHED") {
            active = {
                schema_version: "mnde.active_role_policy.v1",
                role_policy_version: event.role_policy_version,
                role_policy_hash: event.role_policy_hash,
                path: path.join("authz", "role-policies", `${event.role_policy_version}.signed.json`),
                activation_event_hash: event.event_hash
            };
        }
        if (event.event_type === "ROLE_REVOKED") revoked.add(event.assignment_id);
    }
    for (const file of existsSync(p.roleAssignments) ? readDirFiles(p.roleAssignments) : []) {
        const assignment = parseStrict(readFileSync(file, "utf8"));
        const validation = validateRoleAssignment(assignment);
        const entry = { assignment, assignment_hash: validation.assignment_hash, revoked: revoked.has(assignment.assignment_id) };
        byAssignment[assignment.assignment_id] = entry;
        byHash[validation.assignment_hash] = { assignment_id: assignment.assignment_id };
        byActor[assignment.actor_key_id] ??= [];
        byActor[assignment.actor_key_id].push(entry);
        byRole[assignment.role] ??= [];
        byRole[assignment.role].push(assignment.assignment_id);
    }
    for (const actor of Object.keys(byActor)) {
        byActor[actor].sort((a, b) => a.assignment.assignment_id.localeCompare(b.assignment.assignment_id));
    }
    if (!active) throw new Error("active_role_policy_missing");
    atomicWriteJson(p.active, active);
    atomicWriteJson(p.byActor, byActor);
    atomicWriteJson(p.byAssignment, byAssignment);
    atomicWriteJson(p.byRole, byRole);
    atomicWriteJson(p.byHash, byHash);
    return { active, byActor, byAssignment, byRole, byHash };
}

function readDirFiles(dir) {
    return existsSync(dir) ? readdirSync(dir).filter((entry) => entry.endsWith(".json")).map((entry) => path.join(dir, entry)) : [];
}

export function verifyAuthzIndexes(root) {
    lastEventHash(root);
    const rebuilt = rebuildAuthzIndexes(root);
    const activePolicy = parseStrict(readFileSync(path.join(root, rebuilt.active.path), "utf8"));
    const validation = validateRolePolicy(activePolicy);
    if (validation.role_policy_hash !== rebuilt.active.role_policy_hash) throw new Error("active_role_policy_hash_mismatch");
    return { ...rebuilt, rolePolicy: activePolicy };
}

function assignmentChain(indexes, assignment) {
    const chain = [];
    let current = assignment;
    const seen = new Set();
    while (current) {
        if (seen.has(current.assignment_id)) throw new Error("assignment_cycle");
        seen.add(current.assignment_id);
        chain.unshift(current);
        if (!current.delegated_by_assignment_id) break;
        const parent = indexes.byAssignment[current.delegated_by_assignment_id];
        if (!parent || parent.revoked) throw new Error("delegation_chain_invalid");
        current = parent.assignment;
    }
    for (let index = 1; index < chain.length; index += 1) {
        enforceDelegation(chain[index - 1], chain[index], chain[index].not_before);
    }
    return chain;
}

function makeDecisionPayload({ actorKeyId, requestedScope, resourceScope, decision, reasonCode, rolePolicy, assignment, assignmentHash, authzStateHash, inputHash }) {
    return {
        schema_version: "mnde.authz_decision_payload.v1",
        actor_key_id: actorKeyId,
        requested_scope: requestedScope,
        resource_scope: resourceScope,
        decision,
        reason_code: reasonCode,
        role_policy_version: rolePolicy.role_policy_version,
        assignment_id: assignment?.assignment_id ?? null,
        assignment_hash: assignmentHash ?? null,
        authz_state_hash: authzStateHash,
        input_hash: inputHash
    };
}

export function authorize(root, request, receiptPrivateKeyPem) {
    ensureStore(root);
    const timestamp = request.timestamp ?? new Date().toISOString();
    let decision = "REFUSE";
    let reasonCode = "ERR_AUTHZ_DENIED";
    let selected = null;
    let selectedHash = null;
    const inputHash = hashCanonicalJson(request);
    const indexes = verifyAuthzIndexes(root);
    try {
        expectString(request.actor_key_id, "actor_key_id");
        expectString(request.requested_scope, "requested_scope");
        validateScope(request.resource_scope ?? {});
        const candidates = indexes.byActor[request.actor_key_id] ?? [];
        for (const entry of candidates) {
            const assignment = entry.assignment;
            if (entry.revoked) continue;
            if (Date.parse(timestamp) < Date.parse(assignment.not_before) || Date.parse(timestamp) > Date.parse(assignment.expires_at)) continue;
            assignmentChain(indexes, assignment);
            if (!scopeContains(assignment.scope, request.resource_scope ?? {})) continue;
            const roleScopes = indexes.rolePolicy.roles[assignment.role]?.scopes ?? [];
            if (!scopesContain(roleScopes, [request.requested_scope]) || !scopesContain(assignment.scopes, [request.requested_scope])) continue;
            if (!limitsContain(assignment.limits, request.limits ?? {})) continue;
            selected = assignment;
            selectedHash = entry.assignment_hash;
            decision = "ALLOW";
            reasonCode = "OK_AUTHZ";
            break;
        }
        if (!selected) {
            reasonCode = "ERR_AUTHZ_NO_MATCHING_ASSIGNMENT";
        }
    } catch (error) {
        reasonCode = error.message;
    }
    const authzStateHash = hashCanonicalJson({
        active: indexes.active,
        assignments_for_actor: indexes.byActor[request.actor_key_id] ?? []
    });
    const payload = makeDecisionPayload({
        actorKeyId: request.actor_key_id ?? null,
        requestedScope: request.requested_scope ?? null,
        resourceScope: request.resource_scope ?? {},
        decision,
        reasonCode,
        rolePolicy: indexes.rolePolicy,
        assignment: selected,
        assignmentHash: selectedHash,
        authzStateHash,
        inputHash
    });
    const decisionHash = hashCanonicalJson(payload);
    const public_key = publicKeyRawHexFromPrivatePem(receiptPrivateKeyPem);
    const receiptPayload = {
        ...payload,
        schema_version: "mnde.authz_decision_receipt.v1",
        decision_hash: decisionHash
    };
    const receipt = {
        ...receiptPayload,
        signature: {
            algorithm: "ed25519.v1",
            key_id: keyIdFromRawPublicKey(public_key),
            public_key,
            value: signCanonicalPayload(canonicalizeJson(receiptPayload), receiptPrivateKeyPem)
        }
    };
    appendJsonl(paths(root).decisionReceipts, receipt);
    return { ok: decision === "ALLOW", receipt };
}

export function authorizeOrThrow(root, request, receiptPrivateKeyPem) {
    const result = authorize(root, request, receiptPrivateKeyPem);
    if (!result.ok) {
        throw new Error(result.receipt.reason_code);
    }
    return result;
}

export function verifyAuthzReceipts(root) {
    const indexes = verifyAuthzIndexes(root);
    const mismatches = [];
    for (const receipt of readJsonl(paths(root).decisionReceipts)) {
        const { signature, ...payload } = receipt;
        if (signature.algorithm !== "ed25519.v1" || keyIdFromRawPublicKey(signature.public_key) !== signature.key_id) {
            mismatches.push({ decision_hash: receipt.decision_hash, error: "receipt_signature_metadata_invalid" });
            continue;
        }
        const recomputed = hashCanonicalJson({
            schema_version: "mnde.authz_decision_payload.v1",
            actor_key_id: receipt.actor_key_id,
            requested_scope: receipt.requested_scope,
            resource_scope: receipt.resource_scope,
            decision: receipt.decision,
            reason_code: receipt.reason_code,
            role_policy_version: receipt.role_policy_version,
            assignment_id: receipt.assignment_id,
            assignment_hash: receipt.assignment_hash,
            authz_state_hash: receipt.authz_state_hash,
            input_hash: receipt.input_hash
        });
        if (recomputed !== receipt.decision_hash) {
            mismatches.push({ decision_hash: receipt.decision_hash, error: "decision_hash_mismatch" });
            continue;
        }
        if (!verifyCanonicalPayload(canonicalizeJson(payload), signature.value, signature.public_key)) {
            mismatches.push({ decision_hash: receipt.decision_hash, error: "receipt_signature_invalid" });
        }
    }
    return {
        schema_version: "mnde.authz_verify_report.v1",
        authz_events_verified: readJsonl(paths(root).events).length,
        authz_receipts_verified: readJsonl(paths(root).decisionReceipts).length,
        active_role_policy_version: indexes.active.role_policy_version,
        drift_count: mismatches.length,
        mismatches
    };
}

export function copyAuthzLogs(root, outputDir) {
    mkdirSync(outputDir, { recursive: true });
    const p = paths(root);
    for (const [source, target] of [[p.events, "authz_events.jsonl"], [p.decisionReceipts, "authz_decision_receipts.jsonl"]]) {
        if (existsSync(source)) copyFileSync(source, path.join(outputDir, target));
    }
}
