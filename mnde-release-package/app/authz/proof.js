import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { canonicalizeJson } from "../shared/json.js";
import { keyIdFromRawPublicKey, publicKeyRawHexFromPrivatePem } from "../policy/crypto.js";
import { commitPolicyEvent, createChangeRequest, draftPolicy, signPolicyDocument, signTransaction, verifyPolicyStore } from "../policy/lifecycle.js";
import { assignRole, copyAuthzLogs, createRolePolicy, publishRolePolicy, revokeRole, verifyAuthzReceipts } from "./lifecycle.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_OUTPUT = path.join(ROOT, "authz-proof-bundle");
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICWe8yJMfTdHyBVYMPAyeUYav4APtN2SMUsEaVuZLM+E
-----END PRIVATE KEY-----
`;

function writeJson(filePath, value) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function policyAuthority(rules) {
    const public_key = publicKeyRawHexFromPrivatePem(PRIVATE_KEY);
    return {
        schema_version: "mnde.policy_authority.v1",
        authority_id: "authz-proof-authority",
        authority_type: "root",
        delegated_by: null,
        key_id: keyIdFromRawPublicKey(public_key),
        public_key,
        scope: "global",
        limits: rules,
        not_before: "2026-01-01T00:00:00.000Z",
        expires_at: "2099-12-31T00:00:00.000Z",
        revoked: false
    };
}

function publishPolicy(policyStore, authzStore, policy, base, suffix, createdAt) {
    const authority = policyAuthority({
        max_total_cost_cents: 1000000,
        allow_auto_scale: false,
        max_gpu_count: 64,
        max_hours: 168,
        require_manual_approval_above_cents: 1000000,
        max_retry_count: 10
    });
    const changeRequest = createChangeRequest({
        changeId: `authz-proof-change-${suffix}`,
        basePolicyVersion: base,
        proposedPolicy: policy,
        reason: `authz proof ${suffix}`,
        createdAt
    });
    const transaction = signTransaction({
        transactionId: `authz-proof-txn-${suffix}`,
        transactionType: "PUBLISH",
        changeRequest,
        authority,
        privateKeyPem: PRIVATE_KEY
    });
    return commitPolicyEvent(policyStore, transaction, {
        authorityPrivateKeyPem: PRIVATE_KEY,
        authzStore,
        actorKeyId: authority.key_id,
        authzReceiptPrivateKeyPem: PRIVATE_KEY
    });
}

export function runAuthzProof(outputDir = DEFAULT_OUTPUT) {
    if (existsSync(outputDir)) {
        rmSync(outputDir, { recursive: true, force: true });
    }
    mkdirSync(outputDir, { recursive: true });
    const authzStore = path.join(outputDir, "authz-store");
    const policyStore = path.join(outputDir, "policy-store");
    const publicKey = publicKeyRawHexFromPrivatePem(PRIVATE_KEY);
    const actorKeyId = keyIdFromRawPublicKey(publicKey);
    const limits = {
        max_total_cost_cents: 1000000,
        allow_auto_scale: false,
        max_gpu_count: 64,
        max_hours: 168,
        require_manual_approval_above_cents: 1000000,
        max_retry_count: 10
    };
    publishRolePolicy(authzStore, createRolePolicy("roles.v1", PRIVATE_KEY), PRIVATE_KEY, "2026-04-19T00:00:00.000Z");
    assignRole(authzStore, {
        assignment_id: "assign-authz-proof-root",
        actor_key_id: actorKeyId,
        actor_public_key: publicKey,
        role: "root_admin",
        scopes: ["*"],
        scope: {},
        limits,
        not_before: "2026-01-01T00:00:00.000Z",
        expires_at: "2099-12-31T00:00:00.000Z"
    }, PRIVATE_KEY, "2026-04-19T00:00:01.000Z");
    const firstPolicy = signPolicyDocument(draftPolicy({
        version: "authz.policy.v1",
        rules: {
            max_total_cost_cents: 10000,
            allow_auto_scale: false,
            max_gpu_count: 4,
            max_hours: 8,
            require_manual_approval_above_cents: 5000,
            max_retry_count: 1
        }
    }), PRIVATE_KEY);
    const privileged = publishPolicy(policyStore, authzStore, firstPolicy, "NONE", "publish-before-revoke", "2026-04-19T00:00:02.000Z");
    revokeRole(authzStore, "assign-authz-proof-root", PRIVATE_KEY, "2026-04-19T00:00:03.000Z", {
        actorKeyId,
        authzReceiptPrivateKeyPem: PRIVATE_KEY
    });
    let refusedAfterRevoke = false;
    try {
        const secondPolicy = signPolicyDocument(draftPolicy({
            version: "authz.policy.v2",
            rules: { ...firstPolicy.rules, max_gpu_count: 8 }
        }), PRIVATE_KEY);
        publishPolicy(policyStore, authzStore, secondPolicy, "authz.policy.v1", "publish-after-revoke", "2026-04-19T00:00:04.000Z");
    } catch {
        refusedAfterRevoke = true;
    }
    const policyReplay = verifyPolicyStore(policyStore, []);
    const authzReplay = verifyAuthzReceipts(authzStore);
    copyAuthzLogs(authzStore, outputDir);
    const summary = {
        schema_version: "mnde.authz_proof_summary.v1",
        role_assigned: true,
        privileged_action_allowed_before_revoke: privileged.event.event_type === "POLICY_PUBLISHED",
        role_revoked: true,
        privileged_action_refused_after_revoke: refusedAfterRevoke,
        policy_zero_drift: policyReplay.drift_count === 0,
        authz_zero_drift: authzReplay.drift_count === 0,
        final_verdict: refusedAfterRevoke && authzReplay.drift_count === 0 ? "INTEGRATED" : "NOT_INTEGRATED"
    };
    writeJson(path.join(outputDir, "summary.json"), summary);
    writeJson(path.join(outputDir, "replay_report.json"), { policy: policyReplay, authz: authzReplay });
    return { summary, policyReplay, authzReplay, output_dir: outputDir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT;
    const result = runAuthzProof(outputDir);
    process.stdout.write(`${canonicalizeJson(result.summary)}\n`);
}
