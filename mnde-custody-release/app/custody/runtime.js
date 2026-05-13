import http from "http";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { canonicalizeJson } from "../shared/json.js";
import { scanForbiddenContent } from "../shared/forbidden_content.js";
import { canonicalPolicyPayload, deriveKeyId, policyHash, verifyPolicySignature } from "../shared/policy-trust.js";
import { appendReceiptRecord, buildHealthState, checkDiskStatus, OPS_ERRORS, rotateReceiptsIfNeeded, writeBoundedLog } from "../shared/operations.js";
import { verifyReleaseIntegrity } from "../release/integrity.js";
import { PACKAGE_ROOT } from "../release/paths.js";
export const ERR_FORBIDDEN_ARTIFACT_PRESENT = "ERR_FORBIDDEN_ARTIFACT_PRESENT";
export const ERR_INTERNAL_SIGNING_DISABLED = "ERR_INTERNAL_SIGNING_DISABLED";
export const ERR_INVALID_CONFIG = "ERR_INVALID_CONFIG";
export const ERR_POLICY_PATH_MISSING = "ERR_POLICY_PATH_MISSING";
export const ERR_POLICY_FILE_MISSING = "ERR_POLICY_FILE_MISSING";
export const ERR_POLICY_FILE_UNREADABLE = "ERR_POLICY_FILE_UNREADABLE";
export const ERR_POLICY_JSON_PARSE_FAILED = "ERR_POLICY_JSON_PARSE_FAILED";
export const ERR_POLICY_SCHEMA_INVALID = "ERR_POLICY_SCHEMA_INVALID";
export const ERR_POLICY_SIGNATURE_INVALID = "ERR_POLICY_SIGNATURE_INVALID";
export const ERR_POLICY_HASH_MISMATCH = "ERR_POLICY_HASH_MISMATCH";
export const ERR_PREFLIGHT_LOCK_MISSING = "ERR_PREFLIGHT_LOCK_MISSING";
export const ERR_PREFLIGHT_CONFIG_MISMATCH = "ERR_PREFLIGHT_CONFIG_MISMATCH";
export const ERR_PREFLIGHT_POLICY_MISMATCH = "ERR_PREFLIGHT_POLICY_MISMATCH";
export const ERR_RECEIPT_POLICY_MISMATCH = "ERR_RECEIPT_POLICY_MISMATCH";
export const ERR_RECEIPT_SIGNATURE_INVALID = "ERR_RECEIPT_SIGNATURE_INVALID";
export const ERR_RECEIPT_READ_FAILED = "ERR_RECEIPT_READ_FAILED";
export const ERR_POLICY_DISABLED_MODE_NOT_ALLOWED = "ERR_POLICY_DISABLED_MODE_NOT_ALLOWED";
function typedError(code, message, field) {
    const error = new Error(message);
    error.code = code;
    error.field = field;
    return error;
}
function assertObject(value, field) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw typedError(ERR_INVALID_CONFIG, `${field} must be an object`, field);
    }
}
function rejectUnknownKeys(value, allowed, field) {
    for (const key of Object.keys(value)){
        if (!allowed.includes(key)) {
            throw typedError(ERR_INVALID_CONFIG, `${field}.${key} is not allowed`, `${field}.${key}`);
        }
    }
}
function requireString(value, key, expected) {
    const field = key;
    if (typeof value[key] !== "string" || String(value[key]).length === 0) {
        throw typedError(ERR_INVALID_CONFIG, `${field} must be a non-empty string`, field);
    }
    if (expected !== undefined && value[key] !== expected) {
        throw typedError(ERR_INVALID_CONFIG, `${field} must be ${expected}`, field);
    }
    return String(value[key]);
}
function requireStringAllowEmpty(value, key) {
    const field = key;
    if (typeof value[key] !== "string") {
        throw typedError(ERR_INVALID_CONFIG, `${field} must be a string`, field);
    }
    return String(value[key]);
}
function requireBoolean(value, key, expected) {
    const field = key;
    if (typeof value[key] !== "boolean") {
        throw typedError(ERR_INVALID_CONFIG, `${field} must be boolean`, field);
    }
    if (expected !== undefined && value[key] !== expected) {
        throw typedError(ERR_INVALID_CONFIG, `${field} must be ${expected}`, field);
    }
    return Boolean(value[key]);
}
function requirePositiveInteger(value, key) {
    const field = key;
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) <= 0) {
        throw typedError(ERR_INVALID_CONFIG, `${field} must be a positive integer`, field);
    }
    return Number(value[key]);
}
function requireOptionalString(value, key) {
    if (!(key in value) || value[key] === null) {
        return null;
    }
    if (typeof value[key] !== "string") {
        throw typedError(ERR_INVALID_CONFIG, `${key} must be string or null`, key);
    }
    return String(value[key]);
}
function requireOptionalBoolean(value, key) {
    if (!(key in value)) {
        return undefined;
    }
    if (typeof value[key] !== "boolean") {
        throw typedError(ERR_INVALID_CONFIG, `${key} must be boolean`, key);
    }
    return Boolean(value[key]);
}
export function parseBind(bind) {
    const [host, portText] = bind.split(":");
    const port = Number(portText);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw typedError(ERR_INVALID_CONFIG, "runtime.bind must be host:port", "runtime.bind");
    }
    return {
        host,
        port
    };
}
export function readCustodyConfig(configPath) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
        throw typedError(ERR_INVALID_CONFIG, `config file cannot be parsed: ${error.message}`, "config");
    }
    assertObject(parsed, "config");
    const config = parsed;
    const strict = requireBoolean(config, "strict", true);
    if (strict) {
        rejectUnknownKeys(config, [
            "schema_version",
            "mode",
            "strict",
            "service_name",
            "runtime",
            "logging",
            "receipts",
            "disk",
            "signer",
            "policy"
        ], "config");
    }
    requireString(config, "schema_version", "mnde.custody.config.v1");
    requireString(config, "mode", "custody-only");
    requireString(config, "service_name", "MNDeCustody");
    assertObject(config.runtime, "runtime");
    assertObject(config.logging, "logging");
    assertObject(config.receipts, "receipts");
    assertObject(config.disk, "disk");
    assertObject(config.signer, "signer");
    assertObject(config.policy, "policy");
    if (strict) {
        rejectUnknownKeys(config.runtime, [
            "bind",
            "deny_internal_signing",
            "fail_on_forbidden_artifacts",
            "health_path",
            "ready_path"
        ], "runtime");
        rejectUnknownKeys(config.logging, [
            "path",
            "runtime_log",
            "install_log",
            "verification_log",
            "max_bytes",
            "max_files",
            "required_for_audit_integrity"
        ], "logging");
        rejectUnknownKeys(config.receipts, [
            "path",
            "archive_path",
            "rotation_mode",
            "max_bytes",
            "max_count",
            "simulate_write_failure",
            "simulate_read_failure"
        ], "receipts");
        rejectUnknownKeys(config.disk, [
            "min_free_bytes",
            "simulated_free_bytes"
        ], "disk");
        rejectUnknownKeys(config.signer, [
            "timeout_ms",
            "simulate_timeout"
        ], "signer");
        rejectUnknownKeys(config.policy, [
            "mode",
            "path",
            "expected_hash"
        ], "policy");
    }
    const runtime = config.runtime;
    const logging = config.logging;
    const receipts = config.receipts;
    const disk = config.disk;
    const signer = config.signer;
    const policy = config.policy;
    const bind = requireString(runtime, "bind");
    parseBind(bind);
    requireBoolean(runtime, "deny_internal_signing", true);
    requireBoolean(runtime, "fail_on_forbidden_artifacts", true);
    requireString(runtime, "health_path", "/healthz");
    requireString(runtime, "ready_path", "/readyz");
    requireString(logging, "path");
    requireString(logging, "runtime_log");
    requireString(logging, "install_log");
    requireString(logging, "verification_log");
    requirePositiveInteger(logging, "max_bytes");
    requirePositiveInteger(logging, "max_files");
    requireBoolean(logging, "required_for_audit_integrity");
    requireString(receipts, "path");
    requireString(receipts, "archive_path");
    const receiptMode = requireString(receipts, "rotation_mode");
    if (![
        "size",
        "count"
    ].includes(receiptMode)) {
        throw typedError(ERR_INVALID_CONFIG, "receipts.rotation_mode must be size or count", "receipts.rotation_mode");
    }
    requirePositiveInteger(receipts, "max_bytes");
    requirePositiveInteger(receipts, "max_count");
    requireOptionalBoolean(receipts, "simulate_write_failure");
    requireOptionalBoolean(receipts, "simulate_read_failure");
    requirePositiveInteger(disk, "min_free_bytes");
    requirePositiveInteger(signer, "timeout_ms");
    requireOptionalBoolean(signer, "simulate_timeout");
    const policyMode = requireString(policy, "mode");
    if (![
        "required",
        "disabled"
    ].includes(policyMode)) {
        throw typedError(ERR_INVALID_CONFIG, "policy.mode must be required or disabled", "policy.mode");
    }
    const policyPath = policyMode === "required" ? requireString(policy, "path") : requireStringAllowEmpty(policy, "path");
    const expectedHash = requireOptionalString(policy, "expected_hash");
    if (policyMode === "required" && policyPath.trim().length === 0) {
        throw typedError(ERR_INVALID_CONFIG, "policy.path must be configured in required mode", "policy.path");
    }
    if (expectedHash !== null && !/^[0-9a-f]{64}$/i.test(expectedHash)) {
        throw typedError(ERR_INVALID_CONFIG, "policy.expected_hash must be a 64 character hex string or null", "policy.expected_hash");
    }
    if (policyMode === "disabled" && process.env.MNDE_CUSTODY_ALLOW_DISABLED_POLICY_MODE !== "true") {
        throw typedError(ERR_INVALID_CONFIG, ERR_POLICY_DISABLED_MODE_NOT_ALLOWED, "policy.mode");
    }
    return config;
}
function sha256Text(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}
function hashConfig(config) {
    return sha256Text(canonicalizeJson(config));
}
function preflightLockPath(configPath) {
    return `${configPath}.preflight-lock.json`;
}
function validationHashForPolicyInput(config, payload) {
    return sha256Text(canonicalizeJson({
        mode: config.policy.mode,
        expected_hash: config.policy.expected_hash,
        payload
    }));
}
function validateActivePolicyShape(policy) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
        return {
            ok: false,
            error: "policy must be an object"
        };
    }
    const value = policy;
    if (value.schema_version !== "mnde.policy.v1") {
        return {
            ok: false,
            error: "schema_version must be mnde.policy.v1"
        };
    }
    if (typeof value.policy_version !== "string" || value.policy_version.length === 0) {
        return {
            ok: false,
            error: "policy_version must be a non-empty string"
        };
    }
    if (!value.rules || typeof value.rules !== "object" || Array.isArray(value.rules)) {
        return {
            ok: false,
            error: "rules must be an object"
        };
    }
    const rules = value.rules;
    const numericRuleKeys = [
        "max_total_cost_usd",
        "max_gpu_count",
        "max_hours",
        "require_manual_approval_above_usd"
    ];
    for (const key of numericRuleKeys){
        if (typeof rules[key] !== "number" || !Number.isFinite(rules[key])) {
            return {
                ok: false,
                error: `rules.${key} must be a finite number`
            };
        }
    }
    if (typeof rules.allow_auto_scale !== "boolean") {
        return {
            ok: false,
            error: "rules.allow_auto_scale must be boolean"
        };
    }
    if (!value.trust || typeof value.trust !== "object" || Array.isArray(value.trust)) {
        return {
            ok: false,
            error: "trust must be an object"
        };
    }
    const trust = value.trust;
    if (trust.key_version !== "ed25519.v1") {
        return {
            ok: false,
            error: "trust.key_version must be ed25519.v1"
        };
    }
    if (typeof trust.key_id !== "string" || trust.key_id.length === 0) {
        return {
            ok: false,
            error: "trust.key_id must be a non-empty string"
        };
    }
    if (typeof trust.signing_public_key !== "string" || !/^[0-9a-f]{64}$/i.test(trust.signing_public_key)) {
        return {
            ok: false,
            error: "trust.signing_public_key must be 32-byte hex"
        };
    }
    if (typeof trust.signature !== "string" || !/^[0-9a-f]+$/i.test(trust.signature) || trust.signature.length === 0) {
        return {
            ok: false,
            error: "trust.signature must be non-empty hex"
        };
    }
    return {
        ok: true,
        policy: value
    };
}
export function validateConfiguredPolicy(config) {
    if (config.policy.mode === "disabled") {
        return {
            ok: true,
            code: "OK_POLICY_DISABLED",
            policy: null,
            policy_hash: null,
            path: null,
            details: {
                mode: "disabled"
            },
            validation_hash: validationHashForPolicyInput(config, null)
        };
    }
    const policyPath = config.policy.path;
    if (!policyPath || policyPath.trim().length === 0) {
        return {
            ok: false,
            code: ERR_POLICY_PATH_MISSING,
            policy: null,
            policy_hash: null,
            path: policyPath ?? null,
            details: null,
            validation_hash: validationHashForPolicyInput(config, null)
        };
    }
    if (!existsSync(policyPath)) {
        return {
            ok: false,
            code: ERR_POLICY_FILE_MISSING,
            policy: null,
            policy_hash: null,
            path: policyPath,
            details: null,
            validation_hash: validationHashForPolicyInput(config, null)
        };
    }
    let fileContents;
    try {
        if (!statSync(policyPath).isFile()) {
            return {
                ok: false,
                code: ERR_POLICY_FILE_UNREADABLE,
                policy: null,
                policy_hash: null,
                path: policyPath,
                details: {
                    error: "not_a_file"
                },
                validation_hash: validationHashForPolicyInput(config, null)
            };
        }
        fileContents = readFileSync(policyPath, "utf8");
    } catch (error) {
        return {
            ok: false,
            code: ERR_POLICY_FILE_UNREADABLE,
            policy: null,
            policy_hash: null,
            path: policyPath,
            details: {
                error: error.message
            },
            validation_hash: validationHashForPolicyInput(config, null)
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(fileContents);
    } catch (error) {
        return {
            ok: false,
            code: ERR_POLICY_JSON_PARSE_FAILED,
            policy: null,
            policy_hash: null,
            path: policyPath,
            details: {
                error: error.message
            },
            validation_hash: validationHashForPolicyInput(config, fileContents)
        };
    }
    const shaped = validateActivePolicyShape(parsed);
    if (!shaped.ok) {
        return {
            ok: false,
            code: ERR_POLICY_SCHEMA_INVALID,
            policy: null,
            policy_hash: null,
            path: policyPath,
            details: {
                error: shaped.error
            },
            validation_hash: validationHashForPolicyInput(config, fileContents)
        };
    }
    const payload = canonicalPolicyPayload(shaped.policy);
    const derivedKeyId = deriveKeyId(shaped.policy.trust.signing_public_key);
    if (derivedKeyId !== shaped.policy.trust.key_id) {
        return {
            ok: false,
            code: ERR_POLICY_SCHEMA_INVALID,
            policy: shaped.policy,
            policy_hash: null,
            path: policyPath,
            details: {
                error: "trust.key_id does not match signing_public_key",
                expected_key_id: derivedKeyId
            },
            validation_hash: validationHashForPolicyInput(config, payload)
        };
    }
    let validSignature = false;
    try {
        validSignature = verifyPolicySignature(shaped.policy.trust.signing_public_key, payload, shaped.policy.trust.signature);
    } catch (error) {
        return {
            ok: false,
            code: ERR_POLICY_SIGNATURE_INVALID,
            policy: shaped.policy,
            policy_hash: null,
            path: policyPath,
            details: {
                error: error.message
            },
            validation_hash: validationHashForPolicyInput(config, payload)
        };
    }
    if (!validSignature) {
        return {
            ok: false,
            code: ERR_POLICY_SIGNATURE_INVALID,
            policy: shaped.policy,
            policy_hash: null,
            path: policyPath,
            details: null,
            validation_hash: validationHashForPolicyInput(config, payload)
        };
    }
    const actualHash = policyHash(shaped.policy);
    if (config.policy.expected_hash && actualHash !== config.policy.expected_hash) {
        return {
            ok: false,
            code: ERR_POLICY_HASH_MISMATCH,
            policy: shaped.policy,
            policy_hash: actualHash,
            path: policyPath,
            details: {
                expected_hash: config.policy.expected_hash,
                actual_hash: actualHash
            },
            validation_hash: validationHashForPolicyInput(config, payload)
        };
    }
    return {
        ok: true,
        code: "OK_POLICY_READY",
        policy: shaped.policy,
        policy_hash: actualHash,
        path: policyPath,
        details: {
            policy_version: shaped.policy.policy_version
        },
        validation_hash: validationHashForPolicyInput(config, payload)
    };
}
function writeRuntimeLog(config, event) {
    process.stdout.write(`${JSON.stringify({
        ts: new Date().toISOString(),
        ...event
    })}\n`);
    writeBoundedLog(config.logging, event);
}
export function internalSigningDisabledError() {
    const error = new Error(ERR_INTERNAL_SIGNING_DISABLED);
    error.code = ERR_INTERNAL_SIGNING_DISABLED;
    return error;
}
export function signInternally() {
    throw internalSigningDisabledError();
}
export function assertCustodyOnlyBehavior() {
    try {
        signInternally();
    } catch (error) {
        if (error.code === ERR_INTERNAL_SIGNING_DISABLED) {
            return {
                ok: true,
                code: ERR_INTERNAL_SIGNING_DISABLED
            };
        }
        throw error;
    }
    throw new Error("internal signing unexpectedly succeeded");
}
function safeReadJsonLine(filePath, lineNumberFromEnd = 1) {
    try {
        const lines = readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
        const line = lines.at(-lineNumberFromEnd);
        if (!line) {
            return {
                ok: false,
                code: ERR_RECEIPT_READ_FAILED,
                error: "receipt_line_missing"
            };
        }
        return {
            ok: true,
            data: JSON.parse(line)
        };
    } catch (error) {
        return {
            ok: false,
            code: ERR_RECEIPT_READ_FAILED,
            error: error.message
        };
    }
}
function buildAuditReceiptPayload(result) {
    const policyHashValue = typeof result.policy?.policy_hash === "string" ? result.policy.policy_hash : null;
    const policyPathValue = typeof result.policy?.path === "string" ? result.policy.path : null;
    const policyIdValue = result.policy && typeof result.policy === "object" && result.policy.details && typeof result.policy.details === "object" && typeof result.policy.details.policy_version === "string" ? result.policy.details.policy_version : null;
    return {
        schema_version: "mnde.custody.startup_receipt.v2",
        decision: result.ok ? "ALLOW" : "REFUSE",
        reason_code: result.reason ?? result.code,
        config_hash: result.config_hash ?? null,
        policy_hash: policyHashValue,
        policy_path: policyPathValue,
        policy_id: policyIdValue,
        integrity_context: result.integrity?.integrity_context ?? null
    };
}
function signAuditReceiptPayload(payload) {
    return {
        algorithm: "SHA256",
        value: sha256Text(canonicalizeJson(payload))
    };
}
function buildAuditReceipt(result) {
    const payload = buildAuditReceiptPayload(result);
    const decision_hash = sha256Text(canonicalizeJson({
        decision: payload.decision,
        reason_code: payload.reason_code,
        config_hash: payload.config_hash,
        policy_hash: payload.policy_hash,
        policy_path: payload.policy_path
    }));
    const signedPayload = {
        ...payload,
        decision_hash
    };
    const receipt = {
        ...signedPayload,
        signature: signAuditReceiptPayload(signedPayload)
    };
    return {
        ...receipt,
        receipt_hash: sha256Text(canonicalizeJson(receipt))
    };
}
function verifyAuditReceiptSignature(receipt) {
    const { signature, receipt_hash: _receiptHash, ...payload } = receipt;
    if (!signature || typeof signature !== "object" || Array.isArray(signature)) {
        return false;
    }
    const algorithm = signature.algorithm;
    const value = signature.value;
    if (algorithm !== "SHA256" || typeof value !== "string") {
        return false;
    }
    return value === signAuditReceiptPayload(payload).value;
}
function writeProbeReceiptAndVerify(config, result) {
    const probeResult = {
        ...result,
        ok: true,
        code: "OK_RECEIPT_STORE_DURABLE",
        reason: "OK_RECEIPT_STORE_DURABLE"
    };
    const probeReceipt = buildAuditReceipt(probeResult);
    try {
        if (config.receipts.simulate_write_failure === true) {
            return {
                ok: false,
                code: OPS_ERRORS.receiptWriteFailed,
                error: "simulated_write_failure"
            };
        }
        appendReceiptRecord(config.receipts, probeReceipt);
    } catch (error) {
        return {
            ok: false,
            code: error.code ?? OPS_ERRORS.receiptWriteFailed,
            error: error.message
        };
    }
    if (config.receipts.simulate_read_failure === true) {
        return {
            ok: false,
            code: ERR_RECEIPT_READ_FAILED,
            error: "simulated_read_failure"
        };
    }
    const readBack = safeReadJsonLine(config.receipts.path);
    if (!readBack.ok) {
        return {
            ok: false,
            code: readBack.code,
            error: readBack.error
        };
    }
    if (!verifyAuditReceiptSignature(readBack.data)) {
        return {
            ok: false,
            code: ERR_RECEIPT_SIGNATURE_INVALID,
            error: "probe_signature_invalid"
        };
    }
    return {
        ok: true,
        code: "OK_RECEIPT_STORE_DURABLE",
        receipt: readBack.data
    };
}
function validatePreflightLock(configPath, configHash, policyHashValue) {
    const lockPath = preflightLockPath(configPath);
    if (!existsSync(lockPath)) {
        return {
            ok: false,
            code: ERR_PREFLIGHT_LOCK_MISSING,
            details: {
                lock_path: lockPath
            }
        };
    }
    try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        if (lock.config_hash !== configHash) {
            return {
                ok: false,
                code: ERR_PREFLIGHT_CONFIG_MISMATCH,
                details: {
                    lock_path: lockPath,
                    expected: lock.config_hash,
                    actual: configHash
                },
                lock
            };
        }
        if ((lock.policy_hash ?? null) !== policyHashValue) {
            return {
                ok: false,
                code: ERR_PREFLIGHT_POLICY_MISMATCH,
                details: {
                    lock_path: lockPath,
                    expected: lock.policy_hash ?? null,
                    actual: policyHashValue
                },
                lock
            };
        }
        return {
            ok: true,
            code: "OK_PREFLIGHT_LOCK",
            details: {
                lock_path: lockPath
            },
            lock
        };
    } catch (error) {
        return {
            ok: false,
            code: ERR_PREFLIGHT_LOCK_MISSING,
            details: {
                lock_path: lockPath,
                error: error.message
            }
        };
    }
}
function policyForLockComparison(config) {
    return validateConfiguredPolicy({
        ...config,
        policy: {
            ...config.policy,
            expected_hash: null
        }
    });
}
export function checkCustodyStartup(packageRoot = PACKAGE_ROOT, config, options = {}) {
    const forbidden = scanForbiddenContent(packageRoot);
    if (forbidden.length > 0) {
        return {
            ok: false,
            code: ERR_FORBIDDEN_ARTIFACT_PRESENT,
            reason: ERR_FORBIDDEN_ARTIFACT_PRESENT,
            forbidden_artifacts: forbidden
        };
    }
    const integrity = verifyReleaseIntegrity(undefined, packageRoot);
    if (!integrity.ok) {
        return {
            ok: false,
            code: integrity.code,
            reason: integrity.reason,
            forbidden_artifacts: [],
            integrity
        };
    }
    if (config) {
        const configHash = hashConfig(config);
        const policy = options.configPath ? policyForLockComparison(config) : validateConfiguredPolicy(config);
        if (!policy.ok) {
            return {
                ok: false,
                code: policy.code,
                reason: policy.code,
                forbidden_artifacts: [],
                integrity,
                policy,
                config_hash: configHash
            };
        }
        if (options.configPath) {
            const lockCheck = validatePreflightLock(options.configPath, configHash, policy.policy_hash);
            if (!lockCheck.ok) {
                return {
                    ok: false,
                    code: lockCheck.code,
                    reason: lockCheck.code,
                    forbidden_artifacts: [],
                    integrity,
                    policy,
                    config_hash: configHash,
                    preflight_lock: lockCheck.lock ?? lockCheck.details
                };
            }
        }
        const expectedPolicy = validateConfiguredPolicy(config);
        if (!expectedPolicy.ok) {
            return {
                ok: false,
                code: expectedPolicy.code,
                reason: expectedPolicy.code,
                forbidden_artifacts: [],
                integrity,
                policy: expectedPolicy,
                config_hash: configHash
            };
        }
        const durability = writeProbeReceiptAndVerify(config, {
            ok: true,
            code: "OK_CUSTODY_READY",
            forbidden_artifacts: [],
            integrity,
            policy: expectedPolicy,
            config_hash: configHash
        });
        if (!durability.ok) {
            return {
                ok: false,
                code: durability.code,
                reason: durability.code,
                forbidden_artifacts: [],
                integrity,
                policy: expectedPolicy,
                config_hash: configHash
            };
        }
        assertCustodyOnlyBehavior();
        return {
            ok: true,
            code: "OK_CUSTODY_READY",
            forbidden_artifacts: [],
            integrity,
            policy: expectedPolicy,
            config_hash: configHash
        };
    }
    assertCustodyOnlyBehavior();
    return {
        ok: true,
        code: "OK_CUSTODY_READY",
        forbidden_artifacts: []
    };
}
function writePathProbe(targetPath) {
    const directory = path.dirname(targetPath);
    mkdirSync(directory, {
        recursive: true
    });
    const probePath = path.join(directory, `.mnde-probe-${path.basename(targetPath)}.tmp`);
    writeFileSync(probePath, "probe\n", "utf8");
    unlinkSync(probePath);
}
export function runPreflightCheck(options = {}) {
    const checks = [];
    let config = null;
    const resolvedConfigPath = configPathFromEnvOrDefault(options.configPath);
    try {
        config = readCustodyConfig(resolvedConfigPath);
        checks.push({
            name: "config",
            ok: true,
            code: "OK_CONFIG",
            path: resolvedConfigPath
        });
    } catch (error) {
        checks.push({
            name: "config",
            ok: false,
            code: ERR_INVALID_CONFIG,
            field: error.field ?? null,
            error: error.message
        });
    }
    const integrity = verifyReleaseIntegrity(undefined, options.packageRoot ?? PACKAGE_ROOT);
    checks.push({
        name: "release_integrity",
        ok: integrity.ok,
        code: integrity.ok ? integrity.code : integrity.reason,
        details: integrity.integrity_context
    });
    if (!config) {
        return {
            verdict: "REFUSE",
            ok: false,
            code: "ERR_PREFLIGHT_FAILED",
            checks,
            config_hash: null,
            policy_hash: null,
            lock_path: preflightLockPath(resolvedConfigPath)
        };
    }
    try {
        parseBind(config.runtime.bind);
        checks.push({
            name: "bind",
            ok: true,
            code: "OK_BIND",
            value: config.runtime.bind
        });
    } catch (error) {
        checks.push({
            name: "bind",
            ok: false,
            code: ERR_INVALID_CONFIG,
            error: error.message
        });
    }
    try {
        writePathProbe(config.receipts.path);
        checks.push({
            name: "receipt_path",
            ok: true,
            code: "OK_RECEIPT_PATH_WRITABLE",
            path: config.receipts.path
        });
    } catch (error) {
        checks.push({
            name: "receipt_path",
            ok: false,
            code: OPS_ERRORS.receiptWriteFailed,
            error: error.message
        });
    }
    try {
        writePathProbe(config.logging.path);
        checks.push({
            name: "log_path",
            ok: true,
            code: "OK_LOG_PATH_WRITABLE",
            path: config.logging.path
        });
    } catch (error) {
        checks.push({
            name: "log_path",
            ok: false,
            code: OPS_ERRORS.logPathUnavailable,
            error: error.message
        });
    }
    checks.push({
        name: "env",
        ok: true,
        code: "OK_ENV",
        config_source: process.env.MNDE_CUSTODY_CONFIG ? "env" : "default"
    });
    const policy = validateConfiguredPolicy(config);
    checks.push({
        name: "policy",
        ok: policy.ok,
        code: policy.code,
        path: policy.path,
        policy_hash: policy.policy_hash,
        details: policy.details,
        validation_hash: policy.validation_hash
    });
    const configHash = hashConfig(config);
    const lockPath = preflightLockPath(resolvedConfigPath);
    const ok = checks.every((check)=>check.ok === true);
    if (ok) {
        writeFileSync(lockPath, `${JSON.stringify({
            schema_version: "mnde.custody.preflight_lock.v1",
            config_hash: configHash,
            policy_hash: policy.policy_hash ?? null
        }, null, 2)}\n`, "utf8");
    }
    return {
        verdict: ok ? "PASS" : "REFUSE",
        ok,
        code: ok ? "OK_PREFLIGHT" : "ERR_PREFLIGHT_FAILED",
        checks,
        config_hash: configHash,
        policy_hash: policy.policy_hash ?? null,
        lock_path: lockPath
    };
}
export function logStartupResult(result, config) {
    if (result.ok) {
        process.stdout.write(`${JSON.stringify({
            event: "mnde.custody.startup",
            decision: "ALLOW",
            reason_code: result.code
        })}\n`);
        return;
    }
    if (config) {
        try {
            appendReceiptRecord(config.receipts, buildAuditReceipt(result));
        } catch (error) {
            process.stderr.write(`${JSON.stringify({
                event: "mnde.custody.receipt",
                decision: "WARN",
                reason_code: error.code ?? OPS_ERRORS.receiptWriteFailed,
                error: error.message
            })}\n`);
        }
    }
    if (result.integrity && !result.forbidden_artifacts.length) {
        process.stderr.write(`${JSON.stringify({
            event: "mnde.custody.startup",
            decision: "REFUSE",
            reason_code: result.reason ?? result.code,
            integrity_context: result.integrity.integrity_context,
            policy_context: result.policy ?? null,
            config_hash: result.config_hash ?? null
        })}\n`);
        return;
    }
    for (const artifact of result.forbidden_artifacts){
        process.stderr.write(`${JSON.stringify({
            event: "mnde.custody.startup",
            decision: "REFUSE",
            reason_code: ERR_FORBIDDEN_ARTIFACT_PRESENT,
            offending_path: artifact.path,
            absolute_path: artifact.absolute_path,
            reasons: artifact.reasons
        })}\n`);
    }
}
function configPathFromEnvOrDefault(explicit) {
    return explicit ?? process.env.MNDE_CUSTODY_CONFIG ?? path.join(PACKAGE_ROOT, "config", "custody.config.template.json");
}
export function runCustodyRuntime(options = {}) {
    let config;
    const resolvedConfigPath = configPathFromEnvOrDefault(options.configPath);
    try {
        config = readCustodyConfig(resolvedConfigPath);
    } catch (error) {
        process.stderr.write(`${JSON.stringify({
            event: "mnde.custody.config",
            decision: "REFUSE",
            reason_code: ERR_INVALID_CONFIG,
            field: error.field ?? null,
            error: error.message
        })}\n`);
        process.exitCode = 2;
        return;
    }
    const result = checkCustodyStartup(PACKAGE_ROOT, config, {
        configPath: resolvedConfigPath
    });
    logStartupResult(result, config);
    if (!result.ok) {
        process.exitCode = 1;
        return;
    }
    if (options.once) {
        return;
    }
    const activePolicy = validateConfiguredPolicy(config);
    const bind = parseBind(config.runtime.bind);
    const startupTime = new Date().toISOString();
    let manifestOk = true;
    let logStatus = {
        ok: true,
        code: "OK_LOG_WRITTEN"
    };
    let receiptStatus = {
        ok: true,
        code: "OK_RECEIPT_STORE"
    };
    let signerStatus = {
        ok: true,
        code: "OK_SIGNER"
    };
    const custodyStatus = {
        ok: true,
        code: "OK_CUSTODY_READY"
    };
    function currentHealth() {
        const diskStatus = checkDiskStatus([
            config.logging.path,
            config.receipts.path,
            config.receipts.archive_path
        ], config.disk);
        if (!diskStatus.ok) {
            receiptStatus = {
                ok: false,
                code: OPS_ERRORS.diskLow
            };
        }
        if (config.signer.simulate_timeout === true) {
            signerStatus = {
                ok: false,
                code: OPS_ERRORS.signatureTimeout
            };
        }
        return buildHealthState({
            startup_state: "READY",
            manifest_ok: manifestOk,
            config_ok: true,
            log_status: logStatus,
            receipt_store_status: receiptStatus,
            disk_status: diskStatus,
            custody_status: custodyStatus,
            signer_status: signerStatus
        });
    }
    try {
        rotateReceiptsIfNeeded(config.receipts);
        receiptStatus = {
            ok: true,
            code: "OK_RECEIPT_STORE"
        };
    } catch (error) {
        receiptStatus = {
            ok: false,
            code: error.code ?? OPS_ERRORS.receiptArchiveFailed
        };
    }
    const server = http.createServer((req, res)=>{
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (req.method === "GET" && pathname === config.runtime.health_path) {
            const body = Buffer.from(JSON.stringify({
                service_name: config.service_name,
                started_at: startupTime,
                ...currentHealth()
            }) + "\n");
            res.writeHead(200, {
                "content-type": "application/json",
                "content-length": body.byteLength
            });
            res.end(body);
            return;
        }
        if (req.method === "GET" && pathname === config.runtime.ready_path) {
            const health = currentHealth();
            const body = Buffer.from(JSON.stringify({
                ...health,
                active_policy_version: activePolicy.ok ? activePolicy.details?.policy_version ?? null : null,
                policy_hash: activePolicy.ok ? activePolicy.policy_hash : null
            }) + "\n");
            res.writeHead(health.ready ? 200 : 503, {
                "content-type": "application/json",
                "content-length": body.byteLength
            });
            res.end(body);
            return;
        }
        res.writeHead(404, {
            "content-type": "application/json"
        });
        res.end(JSON.stringify({
            ok: false,
            reason_code: "ERR_NOT_FOUND"
        }) + "\n");
    });
    server.on("error", (error)=>{
        writeRuntimeLog(config, {
            event: "mnde.custody.startup",
            decision: "REFUSE",
            reason_code: "ERR_SERVICE_START_FAILED",
            error: error.message
        });
        process.exit(1);
    });
    server.listen(bind.port, bind.host, ()=>{
        logStatus = writeBoundedLog(config.logging, {
            event: "mnde.custody.startup",
            decision: "ALLOW",
            reason_code: "OK_READY",
            bind: config.runtime.bind
        });
    });
}
export function replayStartupReceipt(receipt, config, currentPolicyOverride) {
    if (!verifyAuditReceiptSignature(receipt)) {
        return {
            ok: false,
            code: ERR_RECEIPT_SIGNATURE_INVALID
        };
    }
    const currentPolicy = currentPolicyOverride ?? validateConfiguredPolicy(config);
    const expectedPolicyHash = currentPolicy.policy_hash ?? null;
    const expectedPolicyPath = currentPolicy.path ?? null;
    if ((receipt.policy_hash ?? null) !== expectedPolicyHash || (receipt.policy_path ?? null) !== expectedPolicyPath) {
        return {
            ok: false,
            code: ERR_RECEIPT_POLICY_MISMATCH,
            expected_policy_hash: expectedPolicyHash,
            actual_policy_hash: receipt.policy_hash ?? null
        };
    }
    return {
        ok: true,
        code: "OK_RECEIPT_REPLAY"
    };
}
