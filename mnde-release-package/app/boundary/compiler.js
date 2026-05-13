import { canonicalizeJson } from "../shared/json.js";
import { hashCanonicalJson } from "../shared/hash.js";
import { validatePolicyDocument } from "../policy/schema.js";
import { canonicalBoundarySet, validateBoundarySet } from "./schema.js";

const DEFAULT_RULES = {
    max_total_cost_cents: 10000,
    allow_auto_scale: false,
    max_gpu_count: 4,
    max_hours: 8,
    require_manual_approval_above_cents: 5000,
    max_retry_count: 1
};

function microUsdToCents(value, label) {
    if (value % 10000 !== 0) {
        throw new Error(`${label}_must_be_whole_cents`);
    }
    return value / 10000;
}

function secondsToHours(value, label) {
    if (value % 3600 !== 0) {
        throw new Error(`${label}_must_be_whole_hours_for_runtime_v1`);
    }
    return value / 3600;
}

function minRule(rules, key, value) {
    if (value < 1 && key !== "max_retry_count" && key !== "require_manual_approval_above_cents") {
        throw new Error(`${key}_must_be_positive`);
    }
    rules[key] = Math.min(rules[key], value);
}

function mergeBoundaryIntoRules(rules, boundary) {
    if (boundary.mode === "DISABLED" || boundary.mode === "OBSERVE") {
        return;
    }
    if (boundary.mode === "APPROVAL_REQUIRED" && boundary.type !== "approval_required_above_micro_usd") {
        throw new Error(`approval_required_mode_not_supported_for_${boundary.type}`);
    }
    if (boundary.on_violation === "RECORD_ONLY") {
        return;
    }
    switch (boundary.type) {
        case "max_total_cost_micro_usd":
        case "max_run_cost_micro_usd":
        case "max_daily_cost_micro_usd":
        case "max_monthly_cost_micro_usd":
            minRule(rules, "max_total_cost_cents", microUsdToCents(boundary.value, boundary.type));
            return;
        case "approval_required_above_micro_usd":
            minRule(rules, "require_manual_approval_above_cents", microUsdToCents(boundary.value, boundary.type));
            return;
        case "max_gpu_count":
        case "max_gpus":
            minRule(rules, "max_gpu_count", boundary.value);
            return;
        case "max_hours":
            minRule(rules, "max_hours", boundary.value);
            return;
        case "max_run_time_seconds":
        case "max_runtime_seconds":
            minRule(rules, "max_hours", secondsToHours(boundary.value, boundary.type));
            return;
        case "max_retry_count":
        case "max_retries":
            minRule(rules, "max_retry_count", boundary.value);
            return;
        case "allow_auto_scale":
            rules.allow_auto_scale = rules.allow_auto_scale && boundary.value;
            return;
        case "block_autoscale":
            if (boundary.value) {
                rules.allow_auto_scale = false;
            }
            return;
        case "allowed_gpu_types":
        case "allowed_regions":
        case "allowed_actor_ids":
        case "required_team_id":
        case "required_project_id":
            throw new Error(`${boundary.type}_not_enforceable_by_ecs_policy_v1`);
        default:
            throw new Error(`unsupported_boundary_type_${boundary.type}`);
    }
}

function assertNoConflicts(boundarySet) {
    for (const boundary of boundarySet.boundaries) {
        if ((boundary.mode === "DISABLED" || boundary.mode === "OBSERVE" || boundary.on_violation === "RECORD_ONLY") &&
            ["allowed_gpu_types", "allowed_regions", "allowed_actor_ids", "required_team_id", "required_project_id"].includes(boundary.type)) {
            continue;
        }
        if (["allowed_gpu_types", "allowed_regions", "allowed_actor_ids", "required_team_id", "required_project_id"].includes(boundary.type)) {
            throw new Error(`${boundary.type}_requires_runtime_policy_schema_upgrade`);
        }
    }
    const enforcing = boundarySet.boundaries.filter((boundary) => boundary.mode !== "DISABLED" && boundary.mode !== "OBSERVE" && boundary.on_violation !== "RECORD_ONLY");
    const autoscaleAllow = enforcing.some((boundary) => boundary.type === "allow_auto_scale" && boundary.value === true);
    const autoscaleBlock = enforcing.some((boundary) => boundary.type === "block_autoscale" && boundary.value === true);
    if (autoscaleAllow && autoscaleBlock) {
        throw new Error("conflicting_autoscale_boundaries");
    }
    for (const boundary of enforcing) {
        if (boundary.type === "max_total_cost_micro_usd" && boundary.value === 0) {
            throw new Error("max_total_cost_micro_usd_cannot_be_zero");
        }
    }
}

function mergeBoundaryIntoRulesAfterConflictCheck(rules, boundary) {
    try {
        mergeBoundaryIntoRules(rules, boundary);
    } catch (error) {
        if (String(error.message).endsWith("_not_enforceable_by_ecs_policy_v1")) {
            return;
        }
        throw error;
    }
}

export function compileBoundarySet(boundarySet, options = {}) {
    validateBoundarySet(boundarySet);
    const canonicalSet = canonicalBoundarySet(boundarySet);
    assertNoConflicts(canonicalSet);
    const rules = { ...(options.defaultRules ?? DEFAULT_RULES) };
    for (const boundary of canonicalSet.boundaries) {
        mergeBoundaryIntoRulesAfterConflictCheck(rules, boundary);
    }
    const policy = {
        schema_version: "ecs.policy.v1",
        policy_version: canonicalSet.policy_version,
        rules
    };
    validatePolicyDocument(policy);
    return {
        schema_version: "mnde.boundary_compile_result.v1",
        boundary_set_id: canonicalSet.boundary_set_id,
        boundary_set_hash: hashCanonicalJson(canonicalSet),
        policy,
        policy_preview_hash: hashCanonicalJson(policy),
        canonical_boundary_set: canonicalSet,
        canonical_policy: canonicalizeJson(policy)
    };
}

export function diffBoundaryCompiledPolicies(activePolicy, compiledPolicy) {
    const changes = [];
    const keys = [
        "allow_auto_scale",
        "max_gpu_count",
        "max_hours",
        "max_retry_count",
        "max_total_cost_cents",
        "require_manual_approval_above_cents"
    ];
    for (const key of keys) {
        if (activePolicy.rules[key] !== compiledPolicy.rules[key]) {
            changes.push({ field: `rules.${key}`, from: activePolicy.rules[key], to: compiledPolicy.rules[key] });
        }
    }
    return {
        schema_version: "mnde.boundary_policy_diff.v1",
        from: activePolicy.policy_version,
        to: compiledPolicy.policy_version,
        changes
    };
}
