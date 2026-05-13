import { canonicalizeJson, parseStrictJson } from "../shared/json.js";
import { hashCanonicalJson } from "../shared/hash.js";

export const BOUNDARY_KEYS = [
    "boundary_id",
    "mode",
    "on_violation",
    "reason_code",
    "schema_version",
    "scope",
    "type",
    "valid_from",
    "valid_until",
    "value"
];

export const BOUNDARY_SET_KEYS = [
    "boundaries",
    "boundary_set_id",
    "policy_version",
    "schema_version"
];

export const SCOPE_KEYS = [
    "actor_id",
    "container_image",
    "cost_center",
    "environment",
    "executable_name",
    "model_id",
    "organization_id",
    "project_id",
    "region",
    "service_account_id",
    "team_id",
    "tool_name",
    "workload_type"
];

export const BOUNDARY_MODES = new Set(["DISABLED", "OBSERVE", "ENFORCE", "APPROVAL_REQUIRED"]);
export const VIOLATION_ACTIONS = new Set(["REFUSE", "REQUIRE_APPROVAL", "RECORD_ONLY"]);

export const SUPPORTED_BOUNDARY_TYPES = new Set([
    "max_total_cost_micro_usd",
    "max_run_cost_micro_usd",
    "max_daily_cost_micro_usd",
    "max_monthly_cost_micro_usd",
    "max_gpu_count",
    "max_gpus",
    "max_hours",
    "max_run_time_seconds",
    "max_runtime_seconds",
    "max_retry_count",
    "max_retries",
    "allow_auto_scale",
    "block_autoscale",
    "approval_required_above_micro_usd",
    "allowed_gpu_types",
    "allowed_regions",
    "allowed_actor_ids",
    "required_team_id",
    "required_project_id"
]);

export function parseStrictJsonFileText(text) {
    const parsed = parseStrictJson(text);
    if (!parsed.ok) {
        throw new Error(parsed.reason);
    }
    return parsed.value;
}

function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(value, allowedKeys, label) {
    if (!isRecord(value)) {
        throw new Error(`${label}_must_be_object`);
    }
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new Error(`${label}_unknown_field_${key}`);
        }
    }
}

function stringField(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label}_must_be_string`);
    }
}

function integerField(value, label, minimum = 0) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) {
        throw new Error(`${label}_must_be_integer`);
    }
}

function timestampOrNull(value, label) {
    if (value === null) {
        return;
    }
    stringField(value, label);
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
        throw new Error(`${label}_must_be_iso8601_utc`);
    }
}

function validateScope(scope) {
    rejectUnknown(scope, SCOPE_KEYS, "boundary_scope");
    if (Object.keys(scope).length === 0) {
        throw new Error("boundary_scope_required");
    }
    for (const [key, value] of Object.entries(scope)) {
        stringField(value, `scope.${key}`);
    }
}

function validateBoundaryValue(type, value) {
    if (type === "allow_auto_scale" || type === "block_autoscale") {
        if (typeof value !== "boolean") {
            throw new Error(`${type}_value_must_be_boolean`);
        }
        return;
    }
    if (["allowed_gpu_types", "allowed_regions", "allowed_actor_ids"].includes(type)) {
        if (!Array.isArray(value) || value.length === 0) {
            throw new Error(`${type}_value_must_be_nonempty_array`);
        }
        for (const item of value) {
            stringField(item, `${type}.item`);
        }
        if (new Set(value).size !== value.length) {
            throw new Error(`${type}_value_contains_duplicates`);
        }
        return;
    }
    if (type === "required_team_id" || type === "required_project_id") {
        stringField(value, `${type}.value`);
        return;
    }
    integerField(value, `${type}.value`, 0);
}

export function validateBoundary(boundary) {
    rejectUnknown(boundary, BOUNDARY_KEYS, "boundary");
    if (boundary.schema_version !== "mnde.boundary.v1") {
        throw new Error("boundary_bad_schema_version");
    }
    stringField(boundary.boundary_id, "boundary_id");
    stringField(boundary.type, "boundary.type");
    if (!SUPPORTED_BOUNDARY_TYPES.has(boundary.type)) {
        throw new Error(`unknown_boundary_type_${boundary.type}`);
    }
    validateScope(boundary.scope);
    validateBoundaryValue(boundary.type, boundary.value);
    if (!BOUNDARY_MODES.has(boundary.mode)) {
        throw new Error("boundary_bad_mode");
    }
    if (!VIOLATION_ACTIONS.has(boundary.on_violation)) {
        throw new Error("boundary_bad_on_violation");
    }
    stringField(boundary.reason_code, "boundary.reason_code");
    if (!/^ERR_[A-Z0-9_]+$|^OK_[A-Z0-9_]+$/.test(boundary.reason_code)) {
        throw new Error("boundary_bad_reason_code");
    }
    timestampOrNull(boundary.valid_from, "boundary.valid_from");
    timestampOrNull(boundary.valid_until, "boundary.valid_until");
    if (boundary.valid_from !== null && boundary.valid_until !== null && Date.parse(boundary.valid_from) >= Date.parse(boundary.valid_until)) {
        throw new Error("boundary_invalid_date_range");
    }
    return {
        ok: true,
        boundary_hash: hashCanonicalJson(boundary),
        canonical: canonicalizeJson(boundary)
    };
}

export function validateBoundarySet(boundarySet) {
    rejectUnknown(boundarySet, BOUNDARY_SET_KEYS, "boundary_set");
    if (boundarySet.schema_version !== "mnde.boundary_set.v1") {
        throw new Error("boundary_set_bad_schema_version");
    }
    stringField(boundarySet.boundary_set_id, "boundary_set_id");
    stringField(boundarySet.policy_version, "policy_version");
    if (!Array.isArray(boundarySet.boundaries) || boundarySet.boundaries.length === 0) {
        throw new Error("boundary_set_boundaries_required");
    }
    const seen = new Set();
    for (const boundary of boundarySet.boundaries) {
        validateBoundary(boundary);
        if (seen.has(boundary.boundary_id)) {
            throw new Error(`duplicate_boundary_id_${boundary.boundary_id}`);
        }
        seen.add(boundary.boundary_id);
    }
    return {
        ok: true,
        boundary_set_hash: hashCanonicalJson(canonicalBoundarySet(boundarySet)),
        canonical: canonicalizeJson(canonicalBoundarySet(boundarySet))
    };
}

export function scopeDepth(scope) {
    return Object.keys(scope).length;
}

export function canonicalBoundarySet(boundarySet) {
    return {
        schema_version: boundarySet.schema_version,
        boundary_set_id: boundarySet.boundary_set_id,
        policy_version: boundarySet.policy_version,
        boundaries: [...boundarySet.boundaries]
            .map((boundary) => ({
                schema_version: boundary.schema_version,
                boundary_id: boundary.boundary_id,
                type: boundary.type,
                scope: Object.fromEntries(Object.entries(boundary.scope).sort(([a], [b]) => a.localeCompare(b))),
                value: Array.isArray(boundary.value) ? [...boundary.value].sort() : boundary.value,
                mode: boundary.mode,
                on_violation: boundary.on_violation,
                reason_code: boundary.reason_code,
                valid_from: boundary.valid_from,
                valid_until: boundary.valid_until
            }))
            .sort((left, right) => scopeDepth(right.scope) - scopeDepth(left.scope) ||
                left.boundary_id.localeCompare(right.boundary_id) ||
                left.type.localeCompare(right.type))
    };
}
