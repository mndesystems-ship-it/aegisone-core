import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { canonicalizeJson } from "../shared/json.js";
import { executeDeterministicPipeline, makeBaseInput, resetRuntimeState } from "../audit/node_runtime.js";
import { keyIdFromRawPublicKey, publicKeyRawHexFromPrivatePem } from "../policy/crypto.js";
import {
    commitPolicyEvent,
    createChangeRequest,
    initializePolicyStore,
    signPolicyDocument,
    signTransaction
} from "../policy/lifecycle.js";
import { policyHash } from "../shared/policy-trust.js";
import { assignRole, createRolePolicy, publishRolePolicy } from "../authz/lifecycle.js";
import { indexReceipts } from "./indexer.js";
import { replayReceipt, replayReceipts } from "./replay.js";
import { verifyReceipt } from "./verify.js";
import { reasonContextFromReceipt, translateReason } from "./reasons.js";
import { canonicalHash, parseStrictJsonText } from "./format.js";
import { resolvePolicyProofReport } from "../proof/resolver.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_OUTPUT = path.join(ROOT, "receipts-proof-bundle");
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICWe8yJMfTdHyBVYMPAyeUYav4APtN2SMUsEaVuZLM+E
-----END PRIVATE KEY-----
`;

function writeJson(filePath, value) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${canonicalizeJson(value)}\n`, "utf8");
}

function appendJsonl(filePath, value) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${canonicalizeJson(value)}\n`, { encoding: "utf8", flag: "a" });
}

function writePolicyProof(proofRoot, policy) {
    const policiesDir = path.join(proofRoot, "policies");
    const envelopesDir = path.join(proofRoot, "envelopes");
    const keysDir = path.join(proofRoot, "keys");
    mkdirSync(policiesDir, { recursive: true });
    mkdirSync(envelopesDir, { recursive: true });
    mkdirSync(keysDir, { recursive: true });
    const pHash = policyHash(policy);
    const policyPath = path.join("policies", `${pHash}.policy.json`);
    const envelopePath = path.join("envelopes", `${pHash}.envelope.json`);
    const keySetPath = path.join("keys", "policy-keyset.v1.json");
    const keySet = {
        schema_version: "mnde.policy_key_set.v1",
        key_set_version: "policy-keyset.v1",
        allowed_key_ids: [policy.trust.key_id],
        keys: [{ key_id: policy.trust.key_id, public_key: policy.trust.public_key }]
    };
    const envelope = {
        schema_version: "mnde.policy_signature_envelope.v1",
        policy_hash: pHash,
        policy_version: policy.policy_version,
        key_set_version: keySet.key_set_version,
        required_signatures: 1,
        signatures: [{ algorithm: "ed25519.v1", key_id: policy.trust.key_id, value: policy.trust.signature }]
    };
    const manifestBase = {
        schema_version: "mnde.proof_manifest.v1",
        entries: [{
            policy_hash: pHash,
            policy_version: policy.policy_version,
            policy_path: policyPath,
            signature_envelope_path: envelopePath,
            key_set_path: keySetPath
        }]
    };
    const manifest = { ...manifestBase, manifest_hash: canonicalHash(manifestBase) };
    writeJson(path.join(proofRoot, policyPath), policy);
    writeJson(path.join(proofRoot, envelopePath), envelope);
    writeJson(path.join(proofRoot, keySetPath), keySet);
    writeJson(path.join(proofRoot, "manifest.json"), manifest);
    return { manifest, envelope, keySet, proof_root: proofRoot };
}

function authority(limits) {
    const public_key = publicKeyRawHexFromPrivatePem(PRIVATE_KEY);
    return {
        schema_version: "mnde.policy_authority.v1",
        authority_id: "receipts-proof-authority",
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

function publishPolicy(policyStore, authzStore, policy) {
    const authorityDoc = authority({
        max_total_cost_cents: 1000000,
        allow_auto_scale: false,
        max_gpu_count: 64,
        max_hours: 168,
        require_manual_approval_above_cents: 1000000,
        max_retry_count: 10
    });
    const changeRequest = createChangeRequest({
        changeId: "receipts-proof-policy-change-v1",
        basePolicyVersion: "NONE",
        proposedPolicy: policy,
        reason: "receipts proof base policy",
        createdAt: "2026-04-19T00:00:02.000Z"
    });
    const transaction = signTransaction({
        transactionId: "receipts-proof-policy-txn-v1",
        transactionType: "PUBLISH",
        changeRequest,
        authority: authorityDoc,
        privateKeyPem: PRIVATE_KEY
    });
    return commitPolicyEvent(policyStore, transaction, {
        authorityPrivateKeyPem: PRIVATE_KEY,
        authzStore,
        actorKeyId: authorityDoc.key_id,
        authzReceiptPrivateKeyPem: PRIVATE_KEY
    });
}

function createSignedPolicy() {
    return signPolicyDocument({
        schema_version: "ecs.policy.v1",
        policy_version: "receipts.policy.v1",
        rules: {
            max_total_cost_cents: 1000,
            allow_auto_scale: false,
            max_gpu_count: 2,
            max_hours: 4,
            require_manual_approval_above_cents: 1000,
            max_retry_count: 0
        }
    }, PRIVATE_KEY);
}

function runExecution(policy, requestId, overrides, receiptLog) {
    resetRuntimeState();
    const input = makeBaseInput({
        ...overrides,
        execution_request: {
            ...overrides.execution_request,
            request_id: requestId,
            actor: {
                user_id: "vibe-coder-001"
            },
            release_request: {
                execution_id: `exec-${requestId}`,
                hold_state: "APPROVED",
                already_consumed: false,
                ...overrides.execution_request?.release_request
            }
        },
        policy_document: policy,
        pricing_data: {
            gpu_hour_cents: 500
        }
    });
    const result = executeDeterministicPipeline(canonicalizeJson(input));
    if ("parse_boundary" in result) {
        throw new Error(`receipts_proof_execution_failed_${requestId}_${result.reason_code}`);
    }
    appendJsonl(receiptLog, result.receipt);
    return result.receipt;
}

function adversarialChecks(policyStore, validReceipt) {
    const malformed = (() => {
        try {
            parseStrictJsonText("{bad");
            return false;
        } catch {
            return true;
        }
    })();
    const duplicateKeys = (() => {
        try {
            parseStrictJsonText("{\"a\":1,\"a\":2}");
            return false;
        } catch {
            return true;
        }
    })();
    const wrongSignature = (() => {
        const modified = {
            ...validReceipt,
            signature: {
                ...validReceipt.signature,
                value: "00"
            }
        };
        return verifyReceipt(modified, policyStore).status === "FAILED";
    })();
    const missingPolicy = (() => {
        try {
            return verifyReceipt(validReceipt, path.join(policyStore, "missing")).status === "FAILED";
        } catch {
            return true;
        }
    })();
    const modifiedReceipt = (() => {
        const modified = {
            ...validReceipt,
            decision_output: {
                ...validReceipt.decision_output,
                prevented_cost_usd: "999.00"
            }
        };
        return verifyReceipt(modified, policyStore).status === "FAILED";
    })();
    return {
        malformed_json_failed_closed: malformed,
        duplicate_keys_failed_closed: duplicateKeys,
        wrong_signature_failed_closed: wrongSignature,
        missing_policy_failed_closed: missingPolicy,
        modified_receipt_failed_closed: modifiedReceipt
    };
}

function repeatHash(count, factory) {
    let hash = null;
    for (let index = 0; index < count; index += 1) {
        const next = canonicalHash(factory());
        if (hash === null) {
            hash = next;
        } else if (hash !== next) {
            return { stable: false, hash: next };
        }
    }
    return { stable: true, hash };
}

export async function runReceiptsProof(outputDir = DEFAULT_OUTPUT) {
    if (existsSync(outputDir)) {
        rmSync(outputDir, { recursive: true, force: true });
    }
    mkdirSync(outputDir, { recursive: true });
    const policyStore = path.join(outputDir, "policy-store");
    const authzStore = path.join(outputDir, "authz-store");
    const proofRoot = path.join(outputDir, "proof");
    const receiptDir = path.join(outputDir, "receipt-files");
    const receiptLog = path.join(outputDir, "receipts.jsonl");
    initializePolicyStore(policyStore);
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
        assignment_id: "assign-receipts-proof-root-admin",
        actor_key_id: authzAuthority.key_id,
        actor_public_key: authzAuthority.public_key,
        role: "root_admin",
        scopes: ["*"],
        scope: {},
        limits: authzAuthority.limits,
        not_before: "2026-01-01T00:00:00.000Z",
        expires_at: "2099-12-31T00:00:00.000Z"
    }, PRIVATE_KEY, "2026-04-19T00:00:01.000Z");
    const policy = createSignedPolicy();
    const proofBundle = writePolicyProof(proofRoot, policy);
    const published = publishPolicy(policyStore, authzStore, policy);
    const allowReceipt = runExecution(policy, "receipts-proof-allow", {
        execution_request: {
            resources: { gpu_count: 1, hours: 1 },
            runtime_observation: { actual_gpu_count: 1, actual_hours: 1, actual_total_cost_cents: 500 }
        }
    }, receiptLog);
    const refuseReceipt = runExecution(policy, "receipts-proof-refuse", {
        execution_request: {
            resources: { gpu_count: 3, hours: 1 },
            runtime_observation: { actual_gpu_count: 3, actual_hours: 1, actual_total_cost_cents: 1500 }
        }
    }, receiptLog);
    mkdirSync(receiptDir, { recursive: true });
    writeJson(path.join(receiptDir, "allow.json"), allowReceipt);
    writeJson(path.join(receiptDir, "refuse.json"), refuseReceipt);
    const indexSummary = await indexReceipts({
        receiptLog,
        outDir: path.join(outputDir, "receipt-index"),
        policyStore,
        strict: true
    });
    const verificationReport = verifyReceipt(refuseReceipt, policyStore);
    const replayReport = replayReceipts([{ receipt: allowReceipt }, { receipt: refuseReceipt }], policyStore);
    const proofResolution = resolvePolicyProofReport(refuseReceipt, proofRoot);
    const dirIndexSummary = await indexReceipts({
        receiptDir,
        outDir: path.join(outputDir, "receipt-dir-index"),
        policyStore,
        strict: true
    });
    const proofPolicy = {
        schema_version: "mnde.receipt_policy_proof.v1",
        historical_policy_found: verificationReport.historical_policy_found,
        policy_version: policy.policy_version,
        policy_hash: policyHash(policy),
        publish_event_hash: published.event.event_hash
    };
    const adversarial = adversarialChecks(policyStore, refuseReceipt);
    const reasonAdversarial = {
        unknown_reason_code_failed_closed: (() => {
            try {
                translateReason("ERR_REASON_DOES_NOT_EXIST", reasonContextFromReceipt(refuseReceipt));
                return false;
            } catch {
                return true;
            }
        })(),
        missing_translation_field_failed_closed: (() => {
            try {
                translateReason("ERR_GPU_LIMIT", {});
                return false;
            } catch {
                return true;
            }
        })()
    };
    const tamperedProofPolicy = { ...policy, rules: { ...policy.rules, max_gpu_count: 99 } };
    const tamperedProofDir = path.join(outputDir, "tampered-proof");
    writePolicyProof(tamperedProofDir, tamperedProofPolicy);
    const resolverAdversarial = {
        tampered_policy_failed_closed: resolvePolicyProofReport(refuseReceipt, tamperedProofDir).status === "FAILED",
        missing_manifest_failed_closed: resolvePolicyProofReport(refuseReceipt, path.join(outputDir, "missing-proof")).reason_code === "ERR_POLICY_MANIFEST_INVALID",
        wrong_key_set_failed_closed: (() => {
            const wrongDir = path.join(outputDir, "wrong-keyset-proof");
            writePolicyProof(wrongDir, policy);
            writeJson(path.join(wrongDir, "keys", "policy-keyset.v1.json"), {
                schema_version: "mnde.policy_key_set.v1",
                key_set_version: "policy-keyset.v1",
                allowed_key_ids: [],
                keys: []
            });
            return resolvePolicyProofReport(refuseReceipt, wrongDir).status === "FAILED";
        })()
    };
    const determinism = {
        verify_1000: repeatHash(1000, () => verifyReceipt(refuseReceipt, policyStore)),
        replay_1000: repeatHash(1000, () => replayReceipt(refuseReceipt, policyStore)),
        translation_1000: repeatHash(1000, () => translateReason(refuseReceipt.decision_output.reason_code, reasonContextFromReceipt(refuseReceipt))),
        proof_resolver_1000: repeatHash(1000, () => resolvePolicyProofReport(refuseReceipt, proofRoot)),
        index_rebuild_byte_stable: indexSummary.index_hash === (await indexReceipts({
            receiptLog,
            outDir: path.join(outputDir, "receipt-index-repeat"),
            policyStore,
            strict: true
        })).index_hash
    };
    const summaryBase = {
        schema_version: "mnde.receipts_proof_summary.v1",
        receipts_indexed: indexSummary.indexed_receipts === 2 && indexSummary.invalid_receipts === 0,
        receipt_verified: verificationReport.status === "VERIFIED",
        zero_drift: replayReport.drift_count === 0 && replayReport.invalid_count === 0,
        historical_policy_found: verificationReport.historical_policy_found,
        policy_proof_resolved: proofResolution.status === "RESOLVED",
        human_reason_present: translateReason(refuseReceipt.decision_output.reason_code, reasonContextFromReceipt(refuseReceipt)).human_message.length > 0,
        adversarial,
        reason_adversarial: reasonAdversarial,
        resolver_adversarial: resolverAdversarial,
        determinism,
        directory_indexed_receipts: dirIndexSummary.indexed_receipts,
        allow_decision: allowReceipt.decision_output.decision,
        refuse_decision: refuseReceipt.decision_output.decision,
        refuse_reason_code: refuseReceipt.decision_output.reason_code,
        output_dir: outputDir
    };
    const summary = { ...summaryBase, proof_hash: canonicalHash(summaryBase) };
    writeJson(path.join(outputDir, "summary.json"), summary);
    writeJson(path.join(outputDir, "index_summary.json"), indexSummary);
    writeJson(path.join(outputDir, "verification_report.json"), verificationReport);
    writeJson(path.join(outputDir, "replay_report.json"), replayReport);
    writeJson(path.join(outputDir, "proof_resolution.json"), proofResolution);
    writeJson(path.join(outputDir, "determinism_report.json"), determinism);
    writeJson(path.join(outputDir, "reason_adversarial_report.json"), reasonAdversarial);
    writeJson(path.join(outputDir, "resolver_adversarial_report.json"), resolverAdversarial);
    writeJson(path.join(outputDir, "policy_proof.json"), proofPolicy);
    if (!summary.receipts_indexed || !summary.receipt_verified || !summary.zero_drift || !summary.historical_policy_found || !summary.policy_proof_resolved || !summary.human_reason_present || Object.values(adversarial).some((value) => value !== true) || Object.values(reasonAdversarial).some((value) => value !== true) || Object.values(resolverAdversarial).some((value) => value !== true) || Object.values(determinism).some((value) => typeof value === "object" ? value.stable !== true : value !== true)) {
        throw new Error("receipts_proof_failed");
    }
    return { summary, indexSummary, verificationReport, replayReport, proofPolicy };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT;
    runReceiptsProof(outputDir)
        .then((result) => process.stdout.write(`${canonicalizeJson(result.summary)}\n`))
        .catch((error) => {
            process.stderr.write(`${canonicalizeJson({ schema_version: "mnde.receipts_proof_error.v1", error: error.message })}\n`);
            process.exit(1);
        });
}
