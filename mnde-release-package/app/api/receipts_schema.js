import path from "path";

function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rejectUnknownFields(value, fields, label) {
    if (!isRecord(value)) throw new Error(`${label}_must_be_object`);
    const allowed = new Set(fields);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw new Error(`${label}_unknown_field_${key}`);
    }
}

export function validateAllowedPath(filePath, allowedRoots) {
    if (typeof filePath !== "string" || filePath.length === 0) throw new Error("ERR_PATH_REQUIRED");
    if (filePath.includes("..")) throw new Error("ERR_PATH_TRAVERSAL");
    const resolved = path.resolve(filePath);
    const roots = allowedRoots.map((root) => path.resolve(root));
    if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
        throw new Error("ERR_PATH_NOT_ALLOWED");
    }
    return resolved;
}

export const REQUEST_FIELDS = {
    verify: ["file", "receipt", "policy_store", "strict"],
    replay: ["file", "receipt", "receipt_log", "receipt_index", "policy_store", "strict"],
    show: ["file", "receipt", "translate_reasons"],
    index: ["receipts", "receipt_log", "dir", "out", "policy_store", "strict"],
    find: ["index", "decision", "reason_code", "actor", "policy_version", "execution_id"],
    stats: ["index"],
    proof: ["file", "receipt", "proof_root", "strict"],
    export: ["receipts", "proof_root", "out", "format", "strict", "build_timestamp"]
};
