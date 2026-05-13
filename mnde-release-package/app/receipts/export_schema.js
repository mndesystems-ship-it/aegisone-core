function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateExportInput(input) {
    if (!isRecord(input)) throw new Error("export_input_must_be_object");
    const allowed = new Set(["receipts", "proof_root", "out", "format", "strict", "build_timestamp"]);
    for (const key of Object.keys(input)) {
        if (!allowed.has(key)) throw new Error(`export_input_unknown_field_${key}`);
    }
    for (const key of ["receipts", "proof_root", "out", "format", "build_timestamp"]) {
        if (typeof input[key] !== "string" || input[key].length === 0) throw new Error(`export_input_${key}_required`);
    }
    if (!["dir", "tar"].includes(input.format)) throw new Error("export_input_bad_format");
    if (typeof input.strict !== "boolean") throw new Error("export_input_strict_required");
    const parsed = Date.parse(input.build_timestamp);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== input.build_timestamp) {
        throw new Error("export_input_build_timestamp_must_be_iso8601_utc");
    }
    return { ok: true };
}
