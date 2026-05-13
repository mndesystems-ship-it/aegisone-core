export const PRESETS = {
    "safe-local-coding": {
        max_total_cost_micro_usd: 5000000,
        max_hours: 1,
        max_retry_count: 0,
        allow_auto_scale: false
    },
    "ai-agent-sandbox": {
        max_total_cost_micro_usd: 10000000,
        max_hours: 2,
        max_retry_count: 0,
        allow_auto_scale: false
    },
    "gpu-experiment": {
        max_total_cost_micro_usd: 10000000,
        max_gpu_count: 1,
        max_hours: 1,
        max_retry_count: 0,
        allow_auto_scale: false
    },
    "ship-mode": {
        max_total_cost_micro_usd: 25000000,
        max_gpu_count: 2,
        max_hours: 2,
        max_retry_count: 1,
        allow_auto_scale: false
    },
    "cloud-bill-guard": {
        max_total_cost_micro_usd: 20000000,
        max_gpu_count: 2,
        max_hours: 4,
        max_retry_count: 0,
        allow_auto_scale: false
    }
};

function boundary({ id, type, value, reasonCode, scope }) {
    return {
        schema_version: "mnde.boundary.v1",
        boundary_id: id,
        type,
        scope,
        value,
        mode: "ENFORCE",
        on_violation: "REFUSE",
        reason_code: reasonCode,
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_until: null
    };
}

export function presetToBoundarySet(name, options = {}) {
    const preset = PRESETS[name];
    if (!preset) {
        throw new Error(`unknown_boundary_preset_${name}`);
    }
    const scope = options.scope ?? { organization_id: "local", environment: "dev" };
    const version = options.policyVersion ?? `boundary.${name}.v1`;
    const prefix = options.boundarySetId ?? `bs-${name}`;
    const boundaries = [
        boundary({
            id: `${prefix}-cost`,
            type: "max_total_cost_micro_usd",
            value: preset.max_total_cost_micro_usd,
            reasonCode: "ERR_COST_LIMIT",
            scope
        }),
        boundary({
            id: `${prefix}-hours`,
            type: "max_hours",
            value: preset.max_hours,
            reasonCode: "ERR_HOURS_LIMIT",
            scope
        }),
        boundary({
            id: `${prefix}-retries`,
            type: "max_retry_count",
            value: preset.max_retry_count,
            reasonCode: "ERR_RETRY_LIMIT",
            scope
        }),
        boundary({
            id: `${prefix}-autoscale`,
            type: "allow_auto_scale",
            value: preset.allow_auto_scale,
            reasonCode: "ERR_AUTO_SCALE_DENIED",
            scope
        })
    ];
    if (preset.max_gpu_count !== undefined) {
        boundaries.push(boundary({
            id: `${prefix}-gpu`,
            type: "max_gpu_count",
            value: preset.max_gpu_count,
            reasonCode: "ERR_GPU_LIMIT",
            scope
        }));
    }
    return {
        schema_version: "mnde.boundary_set.v1",
        boundary_set_id: prefix,
        policy_version: version,
        boundaries
    };
}

export function listPresets() {
    return Object.keys(PRESETS).sort();
}
