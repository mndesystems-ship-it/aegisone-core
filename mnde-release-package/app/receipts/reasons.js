import { readFileSync } from "fs";
import { canonicalHash, parseStrictJsonText } from "./format.js";

const CATALOG = parseStrictJsonText(readFileSync(new URL("./reason_catalog.json", import.meta.url), "utf8"));
const TRANSLATION_VERSION = "mnde.reason_translation.v1";

function requireContext(context, field) {
    if (!context || typeof context[field] !== "string" || context[field].length === 0) {
        throw new Error(`reason_context_missing_${field}`);
    }
    return context[field];
}

function renderTemplate(template, requiredFields, context) {
    let output = template;
    for (const field of requiredFields) {
        const value = requireContext(context, field);
        output = output.split(`{${field}}`).join(value);
    }
    if (/\{[a-zA-Z0-9_]+\}/.test(output)) {
        throw new Error("reason_template_unresolved_field");
    }
    return output;
}

export function listReasonCodes() {
    return Object.keys(CATALOG).sort();
}

export function formatReasonTranslation(translation, context = {}) {
    if (!translation || typeof translation !== "object") {
        throw new Error("reason_translation_must_be_object");
    }
    const requiredFields = translation.required_fields;
    if (!Array.isArray(requiredFields)) {
        throw new Error("reason_translation_required_fields_invalid");
    }
    return {
        schema_version: TRANSLATION_VERSION,
        machine_code: translation.machine_code,
        severity: translation.severity,
        short_message: translation.short_message,
        human_message: renderTemplate(translation.human_message_template, requiredFields, context),
        suggested_fix: renderTemplate(translation.suggested_fix_template, requiredFields, context),
        translation_hash: translation.translation_hash
    };
}

export function resolveReasonTranslation(code, context = {}) {
    if (typeof code !== "string" || code.length === 0) {
        throw new Error("reason_code_must_be_string");
    }
    const entry = CATALOG[code];
    if (!entry) {
        throw new Error(`unknown_reason_code_${code}`);
    }
    const translation = {
        schema_version: TRANSLATION_VERSION,
        machine_code: code,
        severity: entry.severity,
        short_message: entry.short_message,
        human_message_template: entry.human_message_template,
        suggested_fix_template: entry.suggested_fix_template,
        required_fields: [...entry.required_fields].sort()
    };
    return formatReasonTranslation({
        ...translation,
        translation_hash: canonicalHash(translation)
    }, context);
}

export function reasonContextFromReceipt(receipt) {
    let requestId = "unknown";
    try {
        const request = parseStrictJsonText(receipt.canonical_request);
        requestId = request.execution_request?.request_id ?? "unknown";
    } catch {
        requestId = "unknown";
    }
    return {
        request_id: requestId,
        execution_id: receipt?.decision_output?.execution_id ?? "unknown",
        policy_hash: receipt?.policy_hash ?? receipt?.decision_output?.policy_hash ?? "unknown",
        policy_version: receipt?.decision_output?.policy_version ?? "unknown"
    };
}

export function translateReason(reasonCode, context = {}) {
    return resolveReasonTranslation(reasonCode, context);
}
