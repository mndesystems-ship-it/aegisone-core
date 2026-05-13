import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { canonicalizeJson, hashCanonicalJson } from "../shared/index.js";
const BENCHMARK_VERSION = "mnde.controlled_benchmark.v2";
const OUTPUT_DIR_NAME = "mnde-controlled-benchmark-bundle";
const COST_REQUEST_COUNT = Number(process.env.BENCHMARK_COST_REQUEST_COUNT ?? "50000");
const AGENT_RUN_COUNT = Number(process.env.BENCHMARK_AGENT_RUN_COUNT ?? "20000");
const DRIFT_TEST_ITERATIONS = Number(process.env.BENCHMARK_DRIFT_TEST_ITERATIONS ?? "100000");
const REPLAY_ITERATIONS = Number(process.env.BENCHMARK_REPLAY_ITERATIONS ?? "200000");
const COST_REAL_LATENCY_SAMPLE_TARGET = Number(process.env.BENCHMARK_COST_LATENCY_SAMPLES ?? "100000");
const AGENT_REAL_LATENCY_SAMPLE_TARGET = Number(process.env.BENCHMARK_AGENT_LATENCY_SAMPLES ?? "50000");
const LATENCY_WARMUP_PERCENT = Number(process.env.BENCHMARK_WARMUP_PERCENT ?? "5");
const UNCONTROLLED_AGENT_LOOP_CAP = 240;
const UNCONTROLLED_AGENT_RETRY_CAP = 64;
const BENCHMARK_WARMUP_SECONDS = Number(process.env.BENCHMARK_WARMUP_SECONDS ?? "45");
const BENCHMARK_RUN_COUNT = Number(process.env.BENCHMARK_RUN_COUNT ?? "3");
const BENCHMARK_TOLERANCE_PERCENT = Number(process.env.BENCHMARK_TOLERANCE_PERCENT ?? "3");
const BENCHMARK_ANCHOR_SAMPLE_TARGET = Number(process.env.BENCHMARK_ANCHOR_SAMPLE_TARGET ?? "250000");
const costPolicy = {
    max_cost_micro_usd: 60_000_000,
    max_runtime_seconds: 5_400,
    max_gpu_count: 8,
    max_retry_count: 3,
    autoscale_limit: 4
};
const agentPolicy = {
    max_steps_per_request: 24,
    max_depth_of_subtasks: 4,
    allowed_tool_list: [
        "fetch_context",
        "summarize",
        "classify",
        "lookup_cache",
        "plan",
        "delegate_safe"
    ],
    forbidden_actions: [
        "delete_file",
        "shell_exec_destructive",
        "exfiltrate_secret",
        "modify_policy",
        "network_unapproved"
    ],
    max_total_cost_micro_usd: 9_000_000
};
class DeterministicRng {
    state;
    constructor(seed){
        this.state = seed >>> 0;
    }
    nextU32() {
        this.state = Math.imul(this.state, 1664525) + 1013904223 >>> 0;
        return this.state;
    }
    nextInt(min, max) {
        const span = max - min + 1;
        return min + this.nextU32() % span;
    }
}
function stableSeed(namespace, id) {
    const digest = createHash("sha256").update(`${namespace}:${id}`).digest();
    return digest.readUInt32BE(0);
}
function stableJson(value) {
    return canonicalizeJson(value);
}
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function percent(part, total) {
    if (total === 0) {
        return 0;
    }
    return Math.round(part * 100 / total);
}
function percentile(sortedValues, percentileValue) {
    if (sortedValues.length === 0) {
        return 0;
    }
    const rank = Math.ceil(percentileValue / 100 * sortedValues.length) - 1;
    const index = Math.max(0, Math.min(sortedValues.length - 1, rank));
    return sortedValues[index] ?? 0;
}
function latencySummary(values) {
    const sorted = [
        ...values
    ].sort((left, right)=>left - right);
    return {
        unit: "microseconds",
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0
    };
}
function latencySummaryNanoseconds(values) {
    const sorted = [
        ...values
    ].sort((left, right)=>left - right);
    const total = values.reduce((sum, value)=>sum + value, 0);
    return {
        unit: "nanoseconds",
        sample_size: values.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        average: values.length === 0 ? 0 : Math.round(total / values.length)
    };
}
function distributionBuckets(values) {
    const buckets = [
        {
            upper_bound_ns: 50_000,
            count: 0
        },
        {
            upper_bound_ns: 100_000,
            count: 0
        },
        {
            upper_bound_ns: 250_000,
            count: 0
        },
        {
            upper_bound_ns: 500_000,
            count: 0
        },
        {
            upper_bound_ns: 1_000_000,
            count: 0
        },
        {
            upper_bound_ns: 2_000_000,
            count: 0
        },
        {
            upper_bound_ns: 5_000_000,
            count: 0
        },
        {
            upper_bound_ns: -1,
            count: 0
        }
    ];
    for (const value of values){
        let placed = false;
        for (const bucket of buckets){
            if (bucket.upper_bound_ns !== -1 && value <= bucket.upper_bound_ns) {
                bucket.count += 1;
                placed = true;
                break;
            }
        }
        if (!placed) {
            const overflowBucket = buckets[buckets.length - 1];
            if (overflowBucket) {
                overflowBucket.count += 1;
            }
        }
    }
    return buckets.map((bucket)=>({
            upper_bound_ns: bucket.upper_bound_ns,
            label: bucket.upper_bound_ns === -1 ? ">5000000ns" : `<=${bucket.upper_bound_ns}ns`,
            count: bucket.count
        }));
}
function environmentInfo() {
    const cpu = os.cpus()[0];
    const memoryUsage = process.memoryUsage();
    return {
        cpu_model: cpu?.model ?? "unknown",
        cpu_count: os.cpus().length,
        runtime_version: process.version,
        platform: process.platform,
        arch: process.arch,
        total_memory_bytes: os.totalmem(),
        free_memory_bytes: os.freemem(),
        rss_bytes: memoryUsage.rss,
        heap_total_bytes: memoryUsage.heapTotal,
        heap_used_bytes: memoryUsage.heapUsed
    };
}
function measureDecisionLatencySamples(label, inputs, sampleTarget, evaluate) {
    const warmupSamples = Math.ceil(sampleTarget * LATENCY_WARMUP_PERCENT / 100);
    const warmupDeadline = process.hrtime.bigint() + BigInt(BENCHMARK_WARMUP_SECONDS) * 1_000_000_000n;
    let warmupIterations = 0;
    while(process.hrtime.bigint() < warmupDeadline){
        const input = inputs[warmupIterations % inputs.length];
        if (input !== undefined) {
            evaluate(input);
        }
        warmupIterations += 1;
    }
    const totalIterations = sampleTarget + warmupSamples;
    const samples = [];
    for(let iteration = 0; iteration < totalIterations; iteration += 1){
        const input = inputs[iteration % inputs.length];
        if (input === undefined) {
            continue;
        }
        const start = process.hrtime.bigint();
        evaluate(input);
        const end = process.hrtime.bigint();
        if (iteration >= warmupSamples) {
            samples.push(Number(end - start));
        }
    }
    const summary = latencySummaryNanoseconds(samples);
    const outlierThreshold = Math.max(summary.p99 * 2, 1_000_000);
    const outlierCount = samples.reduce((count, sample)=>count + (sample > outlierThreshold ? 1 : 0), 0);
    return {
        benchmark: label,
        warmup_samples_discarded: warmupSamples,
        warmup_hold_seconds: BENCHMARK_WARMUP_SECONDS,
        warmup_iterations: warmupIterations,
        retained_samples: sampleTarget,
        raw_samples_ns: samples,
        summary,
        outlier_count: outlierCount,
        outlier_threshold_ns: outlierThreshold,
        distribution_buckets: distributionBuckets(samples)
    };
}
function buildMixed5050Anchor(costRequests, agentRuns) {
    const allowCost = costRequests.filter((item)=>item.expected_decision === "ALLOW").slice(0, 125);
    const refuseCost = costRequests.filter((item)=>item.expected_decision === "REFUSE").slice(0, 125);
    const allowAgent = agentRuns.filter((item)=>item.expected_decision === "ALLOW").slice(0, 125);
    const refuseAgent = agentRuns.filter((item)=>item.expected_decision === "REFUSE").slice(0, 125);
    const anchor = [];
    for(let index = 0; index < 125; index += 1){
        anchor.push({
            kind: "cost",
            input: allowCost[index]
        });
        anchor.push({
            kind: "cost",
            input: refuseCost[index]
        });
        anchor.push({
            kind: "agent",
            input: allowAgent[index]
        });
        anchor.push({
            kind: "agent",
            input: refuseAgent[index]
        });
    }
    return anchor;
}
function evaluateAnchorWorkItem(item) {
    if (item.kind === "cost") {
        return evaluateCostRequest(item.input, costPolicy);
    }
    return evaluateAgentRun(item.input, agentPolicy);
}
function measureAnchorMixed5050(anchor) {
    const sampleTarget = BENCHMARK_ANCHOR_SAMPLE_TARGET;
    const warmupSamples = Math.ceil(sampleTarget * LATENCY_WARMUP_PERCENT / 100);
    const warmupDeadline = process.hrtime.bigint() + BigInt(BENCHMARK_WARMUP_SECONDS) * 1_000_000_000n;
    let warmupIterations = 0;
    while(process.hrtime.bigint() < warmupDeadline){
        const item = anchor[warmupIterations % anchor.length];
        if (item !== undefined) {
            evaluateAnchorWorkItem(item);
        }
        warmupIterations += 1;
    }
    const totalIterations = sampleTarget + warmupSamples;
    const latenciesNs = [];
    const start = process.hrtime.bigint();
    for(let iteration = 0; iteration < totalIterations; iteration += 1){
        const item = anchor[iteration % anchor.length];
        if (!item) {
            continue;
        }
        const opStart = process.hrtime.bigint();
        evaluateAnchorWorkItem(item);
        const opEnd = process.hrtime.bigint();
        if (iteration >= warmupSamples) {
            latenciesNs.push(Number(opEnd - opStart));
        }
    }
    const elapsedNs = Number(process.hrtime.bigint() - start);
    return {
        name: "mixed_50_50_allow_refuse",
        execution_count: sampleTarget,
        warmup_discarded: warmupSamples,
        warmup_hold_seconds: BENCHMARK_WARMUP_SECONDS,
        warmup_iterations: warmupIterations,
        throughput_rps: Math.round(sampleTarget * 1_000_000_000 / elapsedNs),
        latency_ns: latencySummaryNanoseconds(latenciesNs)
    };
}
function categoryForCostRequest(index) {
    const mod = index % 10;
    if (mod <= 4) {
        return "normal";
    }
    if (mod <= 7) {
        return "borderline";
    }
    return "runaway";
}
export function generateCostRequests(count) {
    const requests = [];
    for(let index = 0; index < count; index += 1){
        const category = categoryForCostRequest(index);
        const rng = new DeterministicRng(stableSeed("cost-request", index));
        const baseUnitCost = rng.nextInt(18, 56);
        let request;
        if (category === "normal") {
            request = {
                request_id: `cost-${index.toString().padStart(5, "0")}`,
                category,
                requested_gpu_count: rng.nextInt(1, 4),
                requested_runtime_seconds: rng.nextInt(900, 2_700),
                requested_retry_count: rng.nextInt(0, 2),
                autoscale_target: rng.nextInt(1, 2),
                agent_loop_iterations: rng.nextInt(1, 2),
                unit_cost_micro_usd_per_gpu_second: baseUnitCost,
                expected_decision: "ALLOW"
            };
        } else if (category === "borderline") {
            const subtype = index % 3;
            request = {
                request_id: `cost-${index.toString().padStart(5, "0")}`,
                category,
                requested_gpu_count: subtype === 0 ? costPolicy.max_gpu_count : rng.nextInt(5, costPolicy.max_gpu_count),
                requested_runtime_seconds: subtype === 1 ? costPolicy.max_runtime_seconds : rng.nextInt(4_200, costPolicy.max_runtime_seconds),
                requested_retry_count: subtype === 2 ? costPolicy.max_retry_count : rng.nextInt(Math.max(0, costPolicy.max_retry_count - 1), costPolicy.max_retry_count),
                autoscale_target: rng.nextInt(Math.max(1, costPolicy.autoscale_limit - 1), costPolicy.autoscale_limit),
                agent_loop_iterations: rng.nextInt(1, 2),
                unit_cost_micro_usd_per_gpu_second: rng.nextInt(10, 24),
                expected_decision: "ALLOW"
            };
        } else {
            const subtype = index % 5;
            request = {
                request_id: `cost-${index.toString().padStart(5, "0")}`,
                category,
                requested_gpu_count: subtype === 0 ? rng.nextInt(9, 14) : rng.nextInt(6, 12),
                requested_runtime_seconds: subtype === 1 ? rng.nextInt(5_401, 12_000) : rng.nextInt(3_000, 9_000),
                requested_retry_count: subtype === 2 ? rng.nextInt(4, 7) : rng.nextInt(2, 6),
                autoscale_target: subtype === 3 ? rng.nextInt(5, 8) : rng.nextInt(3, 8),
                agent_loop_iterations: subtype === 4 ? rng.nextInt(4, 8) : rng.nextInt(2, 6),
                unit_cost_micro_usd_per_gpu_second: baseUnitCost + rng.nextInt(24, 120),
                expected_decision: "REFUSE"
            };
        }
        requests.push(request);
    }
    return requests;
}
function projectedCostForRequest(request) {
    return request.requested_gpu_count * request.requested_runtime_seconds * request.unit_cost_micro_usd_per_gpu_second * request.autoscale_target * (request.requested_retry_count + 1) * request.agent_loop_iterations;
}
function evaluateCostRequest(request, policy) {
    const reasons = [];
    const projected = projectedCostForRequest(request);
    if (request.requested_gpu_count > policy.max_gpu_count) {
        reasons.push(`requested_gpu_count=${request.requested_gpu_count} exceeds max_gpu_count=${policy.max_gpu_count}`);
    }
    if (request.requested_runtime_seconds > policy.max_runtime_seconds) {
        reasons.push(`requested_runtime_seconds=${request.requested_runtime_seconds} exceeds max_runtime_seconds=${policy.max_runtime_seconds}`);
    }
    if (request.requested_retry_count > policy.max_retry_count) {
        reasons.push(`requested_retry_count=${request.requested_retry_count} exceeds max_retry_count=${policy.max_retry_count}`);
    }
    if (request.autoscale_target > policy.autoscale_limit) {
        reasons.push(`autoscale_target=${request.autoscale_target} exceeds autoscale_limit=${policy.autoscale_limit}`);
    }
    if (projected > policy.max_cost_micro_usd) {
        reasons.push(`projected_total_cost_micro_usd=${projected} exceeds max_cost_micro_usd=${policy.max_cost_micro_usd}`);
    }
    const decision = reasons.length === 0 ? "ALLOW" : "REFUSE";
    const latencyMicroseconds = 82 + request.requested_gpu_count * 5 + Math.floor(request.requested_runtime_seconds / 180) + request.requested_retry_count * 11 + request.autoscale_target * 13 + request.agent_loop_iterations * 17;
    const decisionHash = hashCanonicalJson({
        benchmark_version: BENCHMARK_VERSION,
        benchmark: "cost_control",
        request_id: request.request_id,
        decision,
        reasons,
        projected_total_cost_micro_usd: projected,
        latency_microseconds: latencyMicroseconds
    });
    return {
        decision,
        reasons,
        projected_total_cost_micro_usd: projected,
        decision_hash: decisionHash,
        latency_microseconds: latencyMicroseconds,
        runaway: request.expected_decision === "REFUSE"
    };
}
function categoryForAgentRun(index) {
    const mod = index % 20;
    if (mod <= 8) {
        return "valid";
    }
    if (mod <= 11) {
        return "recursive_loop";
    }
    if (mod <= 14) {
        return "unbounded_retry";
    }
    if (mod <= 16) {
        return "unauthorized_tool";
    }
    if (mod <= 18) {
        return "destructive_action";
    }
    return "depth_overflow";
}
function generateAgentRun(index) {
    const category = categoryForAgentRun(index);
    const rng = new DeterministicRng(stableSeed("agent-run", index));
    const baseToolCost = rng.nextInt(70_000, 260_000);
    const actions = [];
    let stepsPlanned = 0;
    let maxDepthRequested = 1;
    if (category === "valid") {
        stepsPlanned = rng.nextInt(6, agentPolicy.max_steps_per_request);
        maxDepthRequested = rng.nextInt(1, agentPolicy.max_depth_of_subtasks);
        for(let step = 0; step < stepsPlanned; step += 1){
            const mod = step % 5;
            if (mod === 0) {
                actions.push({
                    kind: "tool",
                    name: "fetch_context",
                    cost_micro_usd: baseToolCost
                });
            } else if (mod === 1) {
                actions.push({
                    kind: "tool",
                    name: "summarize",
                    cost_micro_usd: baseToolCost + 20_000
                });
            } else if (mod === 2) {
                actions.push({
                    kind: "spawn",
                    depth: Math.min(maxDepthRequested, 1 + step % maxDepthRequested),
                    cost_micro_usd: 120_000
                });
            } else if (mod === 3) {
                actions.push({
                    kind: "retry",
                    retry_count: rng.nextInt(0, 2),
                    unbounded: false,
                    cost_micro_usd: 80_000
                });
            } else {
                actions.push({
                    kind: "action",
                    name: "checkpoint_state",
                    destructive: false,
                    cost_micro_usd: 60_000
                });
            }
        }
    } else if (category === "recursive_loop") {
        stepsPlanned = rng.nextInt(agentPolicy.max_steps_per_request + 2, agentPolicy.max_steps_per_request + 8);
        maxDepthRequested = rng.nextInt(2, agentPolicy.max_depth_of_subtasks);
        for(let step = 0; step < stepsPlanned - 1; step += 1){
            actions.push({
                kind: "tool",
                name: step % 2 === 0 ? "plan" : "delegate_safe",
                cost_micro_usd: baseToolCost
            });
        }
        actions.push({
            kind: "loop",
            iterations: rng.nextInt(40, 120),
            recursive: true,
            cost_micro_usd: 95_000
        });
    } else if (category === "unbounded_retry") {
        stepsPlanned = rng.nextInt(10, 18);
        maxDepthRequested = rng.nextInt(1, agentPolicy.max_depth_of_subtasks);
        for(let step = 0; step < stepsPlanned - 1; step += 1){
            actions.push({
                kind: "tool",
                name: "lookup_cache",
                cost_micro_usd: baseToolCost - 10_000
            });
        }
        actions.push({
            kind: "retry",
            retry_count: rng.nextInt(8, 20),
            unbounded: true,
            cost_micro_usd: 110_000
        });
    } else if (category === "unauthorized_tool") {
        stepsPlanned = rng.nextInt(8, 14);
        maxDepthRequested = rng.nextInt(1, agentPolicy.max_depth_of_subtasks);
        for(let step = 0; step < stepsPlanned - 1; step += 1){
            actions.push({
                kind: "tool",
                name: "fetch_context",
                cost_micro_usd: baseToolCost
            });
        }
        actions.push({
            kind: "tool",
            name: "raw_shell",
            cost_micro_usd: 300_000
        });
    } else if (category === "destructive_action") {
        stepsPlanned = rng.nextInt(7, 12);
        maxDepthRequested = rng.nextInt(1, agentPolicy.max_depth_of_subtasks);
        for(let step = 0; step < stepsPlanned - 1; step += 1){
            actions.push({
                kind: "tool",
                name: "classify",
                cost_micro_usd: baseToolCost - 15_000
            });
        }
        actions.push({
            kind: "action",
            name: "delete_file",
            destructive: true,
            cost_micro_usd: 150_000
        });
    } else {
        stepsPlanned = rng.nextInt(10, 16);
        maxDepthRequested = rng.nextInt(agentPolicy.max_depth_of_subtasks + 1, agentPolicy.max_depth_of_subtasks + 4);
        for(let step = 0; step < stepsPlanned; step += 1){
            if (step % 3 === 0) {
                actions.push({
                    kind: "spawn",
                    depth: maxDepthRequested,
                    cost_micro_usd: 130_000
                });
            } else {
                actions.push({
                    kind: "tool",
                    name: "delegate_safe",
                    cost_micro_usd: baseToolCost
                });
            }
        }
    }
    return {
        run_id: `agent-${index.toString().padStart(5, "0")}`,
        category,
        steps_planned: stepsPlanned,
        max_depth_requested: maxDepthRequested,
        actions,
        expected_decision: category === "valid" ? "ALLOW" : "REFUSE"
    };
}
export function generateAgentRuns(count) {
    const runs = [];
    for(let index = 0; index < count; index += 1){
        runs.push(generateAgentRun(index));
    }
    return runs;
}
function projectedCostForAgentRun(run) {
    let total = 0;
    for (const action of run.actions){
        if (action.kind === "retry") {
            const multiplier = action.unbounded ? Math.max(action.retry_count, 12) : action.retry_count + 1;
            total += action.cost_micro_usd * multiplier;
            continue;
        }
        if (action.kind === "loop") {
            total += action.cost_micro_usd * action.iterations;
            continue;
        }
        total += action.cost_micro_usd;
    }
    return total;
}
function evaluateAgentRun(run, policy) {
    const reasons = [];
    const projected = projectedCostForAgentRun(run);
    let containsLoopRisk = false;
    let containsUnsafeAction = false;
    if (run.steps_planned > policy.max_steps_per_request) {
        reasons.push(`steps_planned=${run.steps_planned} exceeds max_steps_per_request=${policy.max_steps_per_request}`);
    }
    if (run.max_depth_requested > policy.max_depth_of_subtasks) {
        reasons.push(`max_depth_requested=${run.max_depth_requested} exceeds max_depth_of_subtasks=${policy.max_depth_of_subtasks}`);
    }
    for (const action of run.actions){
        if (action.kind === "tool" && !policy.allowed_tool_list.includes(action.name)) {
            reasons.push(`tool=${action.name} is not in allowed_tool_list`);
            containsUnsafeAction = true;
        }
        if (action.kind === "action" && (action.destructive || policy.forbidden_actions.includes(action.name))) {
            reasons.push(`action=${action.name} is forbidden`);
            containsUnsafeAction = true;
        }
        if (action.kind === "retry" && (action.unbounded || action.retry_count > 6)) {
            reasons.push(`retry_count=${action.retry_count} is unbounded or unsafe`);
            containsLoopRisk = true;
        }
        if (action.kind === "loop" && (action.recursive || action.iterations > 24)) {
            reasons.push(`loop_iterations=${action.iterations} creates recursive loop risk`);
            containsLoopRisk = true;
        }
        if (action.kind === "spawn" && action.depth > policy.max_depth_of_subtasks) {
            reasons.push(`spawn_depth=${action.depth} exceeds max_depth_of_subtasks=${policy.max_depth_of_subtasks}`);
        }
    }
    if (projected > policy.max_total_cost_micro_usd) {
        reasons.push(`projected_total_cost_micro_usd=${projected} exceeds max_total_cost_micro_usd=${policy.max_total_cost_micro_usd}`);
    }
    const decision = reasons.length === 0 ? "ALLOW" : "REFUSE";
    const latencyMicroseconds = 94 + run.steps_planned * 4 + run.max_depth_requested * 19 + run.actions.length * 7 + (containsLoopRisk ? 37 : 0) + (containsUnsafeAction ? 29 : 0);
    const decisionHash = hashCanonicalJson({
        benchmark_version: BENCHMARK_VERSION,
        benchmark: "agent_control",
        run_id: run.run_id,
        decision,
        reasons,
        projected_total_cost_micro_usd: projected,
        latency_microseconds: latencyMicroseconds
    });
    return {
        decision,
        reasons,
        projected_total_cost_micro_usd: projected,
        decision_hash: decisionHash,
        latency_microseconds: latencyMicroseconds,
        contains_loop_risk: containsLoopRisk,
        contains_unsafe_action: containsUnsafeAction
    };
}
function runCostBenchmark(requests) {
    const latencyValues = [];
    let totalExecutedWithoutControl = 0;
    let totalExecutedWithMnde = 0;
    let totalRefused = 0;
    let totalCostWithoutControl = 0;
    let totalCostWithMnde = 0;
    let runawayEvents = 0;
    let runawayEventsPrevented = 0;
    let runawayExecutedWithMnde = 0;
    const replayEntries = [];
    for (const request of requests){
        const decision = evaluateCostRequest(request, costPolicy);
        const projected = decision.projected_total_cost_micro_usd;
        totalExecutedWithoutControl += 1;
        totalCostWithoutControl += projected;
        latencyValues.push(decision.latency_microseconds);
        if (decision.runaway) {
            runawayEvents += 1;
        }
        if (decision.decision === "ALLOW") {
            totalExecutedWithMnde += 1;
            totalCostWithMnde += projected;
        } else {
            totalRefused += 1;
            if (decision.runaway) {
                runawayEventsPrevented += 1;
            }
        }
        if (decision.runaway && decision.decision === "ALLOW") {
            runawayExecutedWithMnde += 1;
        }
        replayEntries.push({
            kind: "cost",
            input: request,
            expected_hash: decision.decision_hash,
            expected_decision: decision.decision
        });
    }
    const categoryBreakdown = {
        normal: 0,
        borderline: 0,
        runaway: 0
    };
    for (const request of requests){
        categoryBreakdown[request.category] += 1;
    }
    return {
        total_requests: requests.length,
        total_executed: totalExecutedWithMnde,
        total_refused: totalRefused,
        total_cost_without_control_micro_usd: totalCostWithoutControl,
        total_cost_with_mnde_micro_usd: totalCostWithMnde,
        cost_prevented_micro_usd: totalCostWithoutControl - totalCostWithMnde,
        percentage_cost_reduction: percent(totalCostWithoutControl - totalCostWithMnde, totalCostWithoutControl),
        number_of_runaway_events: runawayEvents,
        runaway_events_prevented: runawayEventsPrevented,
        runaway_events_prevented_rate: percent(runawayEventsPrevented, runawayEvents),
        runaway_events_executed_with_mnde: runawayExecutedWithMnde,
        latency_report: latencySummary(latencyValues),
        replay_entries: replayEntries,
        category_breakdown: categoryBreakdown,
        policy: costPolicy
    };
}
function simulateAgentRunWithoutControl(run) {
    let totalCost = 0;
    let unsafeActionsExecuted = 0;
    let loopIterations = 0;
    let completed = true;
    for (const action of run.actions){
        if (action.kind === "tool") {
            totalCost += action.cost_micro_usd;
            if (!agentPolicy.allowed_tool_list.includes(action.name)) {
                unsafeActionsExecuted += 1;
            }
            continue;
        }
        if (action.kind === "spawn") {
            totalCost += action.cost_micro_usd;
            continue;
        }
        if (action.kind === "action") {
            totalCost += action.cost_micro_usd;
            if (action.destructive || agentPolicy.forbidden_actions.includes(action.name)) {
                unsafeActionsExecuted += 1;
            }
            continue;
        }
        if (action.kind === "retry") {
            const retryExecutions = action.unbounded ? UNCONTROLLED_AGENT_RETRY_CAP : action.retry_count + 1;
            totalCost += retryExecutions * action.cost_micro_usd;
            loopIterations += retryExecutions;
            if (action.unbounded) {
                completed = false;
            }
            continue;
        }
        const loopExecutions = action.recursive ? UNCONTROLLED_AGENT_LOOP_CAP : action.iterations;
        totalCost += loopExecutions * action.cost_micro_usd;
        loopIterations += loopExecutions;
        if (action.recursive) {
            completed = false;
        }
    }
    if (run.category === "depth_overflow") {
        completed = false;
    }
    return {
        total_cost_micro_usd: totalCost,
        unsafe_actions_executed: unsafeActionsExecuted,
        loop_iterations: loopIterations,
        completed
    };
}
function runAgentBenchmark(runs) {
    const latencyValues = [];
    let runsCompleted = 0;
    let runsStopped = 0;
    let unsafeActionsExecutedWithoutControl = 0;
    let unsafeActionsBlockedWithMnde = 0;
    let loopIterationsWithoutControl = 0;
    let loopIterationsWithMnde = 0;
    let costWithoutControl = 0;
    let costWithMnde = 0;
    let correctDecisions = 0;
    let totalLoopRiskRuns = 0;
    let loopRiskRunsStopped = 0;
    const replayEntries = [];
    for (const run of runs){
        const uncontrolled = simulateAgentRunWithoutControl(run);
        const decision = evaluateAgentRun(run, agentPolicy);
        latencyValues.push(decision.latency_microseconds);
        unsafeActionsExecutedWithoutControl += uncontrolled.unsafe_actions_executed;
        loopIterationsWithoutControl += uncontrolled.loop_iterations;
        costWithoutControl += uncontrolled.total_cost_micro_usd;
        if (decision.contains_loop_risk || run.category === "depth_overflow") {
            totalLoopRiskRuns += 1;
        }
        if (decision.decision === run.expected_decision) {
            correctDecisions += 1;
        }
        if (decision.decision === "ALLOW") {
            runsCompleted += 1;
            costWithMnde += decision.projected_total_cost_micro_usd;
            loopIterationsWithMnde += run.actions.reduce((total, action)=>{
                if (action.kind === "retry") {
                    return total + (action.retry_count + 1);
                }
                if (action.kind === "loop") {
                    return total + action.iterations;
                }
                return total;
            }, 0);
        } else {
            runsStopped += 1;
            if (decision.contains_unsafe_action) {
                unsafeActionsBlockedWithMnde += 1;
            }
            if (decision.contains_loop_risk || run.category === "depth_overflow") {
                loopRiskRunsStopped += 1;
            }
        }
        replayEntries.push({
            kind: "agent",
            input: run,
            expected_hash: decision.decision_hash,
            expected_decision: decision.decision
        });
    }
    const categoryBreakdown = {
        valid: 0,
        recursive_loop: 0,
        unbounded_retry: 0,
        unauthorized_tool: 0,
        destructive_action: 0,
        depth_overflow: 0
    };
    for (const run of runs){
        categoryBreakdown[run.category] += 1;
    }
    return {
        total_agent_runs: runs.length,
        runs_completed: runsCompleted,
        runs_stopped: runsStopped,
        unsafe_actions_executed_without_control: unsafeActionsExecutedWithoutControl,
        unsafe_actions_blocked_with_mnde: unsafeActionsBlockedWithMnde,
        unsafe_actions_block_rate: percent(unsafeActionsBlockedWithMnde, unsafeActionsExecutedWithoutControl),
        loop_iterations_without_control: loopIterationsWithoutControl,
        loop_iterations_with_mnde: loopIterationsWithMnde,
        loop_termination_rate: percent(loopRiskRunsStopped, totalLoopRiskRuns),
        cost_generated_without_control_micro_usd: costWithoutControl,
        cost_generated_with_mnde_micro_usd: costWithMnde,
        decision_accuracy: percent(correctDecisions, runs.length),
        latency_report: latencySummary(latencyValues),
        category_breakdown: categoryBreakdown,
        policy: agentPolicy,
        replay_entries: replayEntries
    };
}
function runDeterminismCheck(costRequest, agentRun) {
    const baselineCost = evaluateCostRequest(costRequest, costPolicy).decision_hash;
    const baselineAgent = evaluateAgentRun(agentRun, agentPolicy).decision_hash;
    let driftMismatches = 0;
    for(let iteration = 0; iteration < DRIFT_TEST_ITERATIONS / 2; iteration += 1){
        if (evaluateCostRequest(costRequest, costPolicy).decision_hash !== baselineCost) {
            driftMismatches += 1;
        }
        if (evaluateAgentRun(agentRun, agentPolicy).decision_hash !== baselineAgent) {
            driftMismatches += 1;
        }
    }
    return {
        benchmark_version: BENCHMARK_VERSION,
        identical_input_runs: DRIFT_TEST_ITERATIONS,
        drift_mismatches: driftMismatches,
        zero_drift: driftMismatches === 0,
        probes: [
            {
                kind: "cost",
                id: costRequest.request_id,
                baseline_decision: evaluateCostRequest(costRequest, costPolicy).decision
            },
            {
                kind: "agent",
                id: agentRun.run_id,
                baseline_decision: evaluateAgentRun(agentRun, agentPolicy).decision
            }
        ]
    };
}
function runReplayVerification(entries) {
    let mismatches = 0;
    const corpusSize = entries.length;
    for(let iteration = 0; iteration < REPLAY_ITERATIONS; iteration += 1){
        const entry = entries[iteration % corpusSize];
        if (!entry) {
            mismatches += 1;
            continue;
        }
        const current = entry.kind === "cost" ? evaluateCostRequest(entry.input, costPolicy) : evaluateAgentRun(entry.input, agentPolicy);
        if (current.decision_hash !== entry.expected_hash || current.decision !== entry.expected_decision) {
            mismatches += 1;
        }
    }
    return {
        benchmark_version: BENCHMARK_VERSION,
        replayed_decisions: REPLAY_ITERATIONS,
        corpus_entries: corpusSize,
        replay_mismatches: mismatches,
        exact_match: mismatches === 0
    };
}
async function writeJsonArtifact(outputDir, fileName, value) {
    await writeFile(path.join(outputDir, fileName), `${stableJson(value)}\n`, "utf8");
}
async function main() {
    const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    const outputDir = path.join(repoRoot, OUTPUT_DIR_NAME);
    await mkdir(outputDir, {
        recursive: true
    });
    const costRequests = generateCostRequests(COST_REQUEST_COUNT);
    const agentRuns = generateAgentRuns(AGENT_RUN_COUNT);
    const mixed5050Anchor = buildMixed5050Anchor(costRequests, agentRuns);
    const mixed5050AnchorWorkload = mixed5050Anchor.map((item)=>item.kind === "cost" ? {
            kind: "cost",
            id: item.input.request_id,
            expected_decision: item.input.expected_decision
        } : {
            kind: "agent",
            id: item.input.run_id,
            expected_decision: item.input.expected_decision
        });
    const workloadManifest = {
        benchmark_version: BENCHMARK_VERSION,
        workload_hash: sha256(stableJson({
            cost_requests: costRequests,
            agent_runs: agentRuns
        })),
        anchor_test: {
            name: "mixed_50_50_allow_refuse",
            concurrency: 1,
            duration_mode: "fixed_execution_count",
            execution_count: mixed5050AnchorWorkload.length,
            workload_hash: sha256(stableJson(mixed5050AnchorWorkload))
        },
        measurement_policy: {
            monotonic_clock: "process.hrtime.bigint",
            warmup_seconds: BENCHMARK_WARMUP_SECONDS,
            reported_runs: BENCHMARK_RUN_COUNT,
            tolerance_percent: BENCHMARK_TOLERANCE_PERCENT
        }
    };
    const costReport = runCostBenchmark(costRequests);
    const agentReport = runAgentBenchmark(agentRuns);
    const determinismReport = runDeterminismCheck(costRequests[0], agentRuns[0]);
    const replayReport = runReplayVerification([
        ...costReport.replay_entries,
        ...agentReport.replay_entries
    ]);
    const anchorReference = measureAnchorMixed5050(mixed5050Anchor);
    const costRealLatency = measureDecisionLatencySamples("cost_control", costRequests, COST_REAL_LATENCY_SAMPLE_TARGET, (request)=>evaluateCostRequest(request, costPolicy));
    const agentRealLatency = measureDecisionLatencySamples("agent_control", agentRuns, AGENT_REAL_LATENCY_SAMPLE_TARGET, (run)=>evaluateAgentRun(run, agentPolicy));
    const combinedRealLatencySamples = [
        ...costRealLatency.raw_samples_ns,
        ...agentRealLatency.raw_samples_ns
    ];
    const costLatencies = costReport.replay_entries.map((entry)=>{
        if (entry.kind !== "cost") {
            return 0;
        }
        return evaluateCostRequest(entry.input, costPolicy).latency_microseconds;
    });
    const agentLatencies = agentReport.replay_entries.map((entry)=>{
        if (entry.kind !== "agent") {
            return 0;
        }
        return evaluateAgentRun(entry.input, agentPolicy).latency_microseconds;
    });
    const latencyReport = {
        benchmark_version: BENCHMARK_VERSION,
        environment: environmentInfo(),
        simulated_latency: {
            cost_decision_layer: costReport.latency_report,
            agent_decision_layer: agentReport.latency_report,
            combined_decision_layer: latencySummary([
                ...costLatencies,
                ...agentLatencies
            ].filter((value)=>value > 0))
        },
        real_latency: {
            cost_decision_layer: costRealLatency.summary,
            agent_decision_layer: agentRealLatency.summary,
            combined_decision_layer: latencySummaryNanoseconds(combinedRealLatencySamples)
        }
    };
    const latencyRealValidation = {
        benchmark_version: BENCHMARK_VERSION,
        environment: latencyReport.environment,
        raw_sample_summary: {
            cost_decision_layer: {
                sample_size: costRealLatency.summary.sample_size,
                warmup_samples_discarded: costRealLatency.warmup_samples_discarded,
                retained_samples: costRealLatency.retained_samples,
                min_ns: costRealLatency.summary.min,
                max_ns: costRealLatency.summary.max,
                average_ns: costRealLatency.summary.average
            },
            agent_decision_layer: {
                sample_size: agentRealLatency.summary.sample_size,
                warmup_samples_discarded: agentRealLatency.warmup_samples_discarded,
                retained_samples: agentRealLatency.retained_samples,
                min_ns: agentRealLatency.summary.min,
                max_ns: agentRealLatency.summary.max,
                average_ns: agentRealLatency.summary.average
            },
            combined_decision_layer: {
                sample_size: combinedRealLatencySamples.length,
                warmup_samples_discarded: costRealLatency.warmup_samples_discarded + agentRealLatency.warmup_samples_discarded,
                retained_samples: costRealLatency.retained_samples + agentRealLatency.retained_samples,
                min_ns: latencyReport.real_latency.combined_decision_layer.min,
                max_ns: latencyReport.real_latency.combined_decision_layer.max,
                average_ns: latencyReport.real_latency.combined_decision_layer.average
            }
        },
        distribution_buckets: {
            cost_decision_layer: costRealLatency.distribution_buckets,
            agent_decision_layer: agentRealLatency.distribution_buckets,
            combined_decision_layer: distributionBuckets(combinedRealLatencySamples)
        },
        outlier_count: {
            cost_decision_layer: costRealLatency.outlier_count,
            agent_decision_layer: agentRealLatency.outlier_count,
            combined_decision_layer: combinedRealLatencySamples.reduce((count, sample)=>count + (sample > Math.max(latencyReport.real_latency.combined_decision_layer.p99 * 2, 1_000_000) ? 1 : 0), 0)
        }
    };
    const summary = {
        benchmark_version: BENCHMARK_VERSION,
        bundle: OUTPUT_DIR_NAME,
        reproducibility: {
            identical_inputs_tested: determinismReport.identical_input_runs,
            replayed_decisions: replayReport.replayed_decisions,
            zero_drift: determinismReport.zero_drift,
            zero_replay_mismatch: replayReport.exact_match
        },
        before_vs_after: {
            cost_control: {
                without_mnde_micro_usd: costReport.total_cost_without_control_micro_usd,
                with_mnde_micro_usd: costReport.total_cost_with_mnde_micro_usd,
                cost_reduction_percent: costReport.percentage_cost_reduction,
                runaway_prevented_percent: costReport.runaway_events_prevented_rate
            },
            agent_control: {
                without_mnde_micro_usd: agentReport.cost_generated_without_control_micro_usd,
                with_mnde_micro_usd: agentReport.cost_generated_with_mnde_micro_usd,
                unsafe_actions_blocked_percent: agentReport.unsafe_actions_block_rate,
                loop_termination_rate: agentReport.loop_termination_rate,
                decision_accuracy: agentReport.decision_accuracy,
                measured_p99_latency_ns: latencyReport.real_latency.combined_decision_layer.p99
            }
        },
        anchor_reference: anchorReference,
        success_criteria: {
            cost_reduction_gt_80_percent: costReport.percentage_cost_reduction > 80,
            runaway_events_prevented_near_100_percent: costReport.runaway_events_prevented_rate >= 99,
            unsafe_actions_blocked_near_100_percent: agentReport.unsafe_actions_block_rate >= 99,
            real_latency_p99_under_1ms_measured: latencyReport.real_latency.combined_decision_layer.p99 < 1_000_000,
            zero_drift: determinismReport.drift_mismatches === 0,
            zero_replay_mismatch: replayReport.replay_mismatches === 0
        }
    };
    const { replay_entries: costReplayEntries, ...costArtifactBody } = costReport;
    const { replay_entries: agentReplayEntries, ...agentArtifactBody } = agentReport;
    const costArtifact = {
        benchmark_version: BENCHMARK_VERSION,
        test: "pre_execution_cost_enforcement",
        ...costArtifactBody
    };
    const agentArtifact = {
        benchmark_version: BENCHMARK_VERSION,
        test: "deterministic_control_for_agent_systems",
        ...agentArtifactBody
    };
    await writeJsonArtifact(outputDir, "summary.json", summary);
    await writeJsonArtifact(outputDir, "cost_report.json", costArtifact);
    await writeJsonArtifact(outputDir, "agent_behavior_report.json", agentArtifact);
    await writeJsonArtifact(outputDir, "determinism_report.json", determinismReport);
    await writeJsonArtifact(outputDir, "replay_report.json", replayReport);
    await writeJsonArtifact(outputDir, "latency_report.json", latencyReport);
    await writeJsonArtifact(outputDir, "latency_real_validation.json", latencyRealValidation);
    await writeJsonArtifact(outputDir, "workload_manifest.json", workloadManifest);
    const manifest = {
        benchmark_version: BENCHMARK_VERSION,
        output_dir: OUTPUT_DIR_NAME,
        artifacts: [
            {
                file: "summary.json",
                sha256: sha256(`${stableJson(summary)}\n`)
            },
            {
                file: "cost_report.json",
                sha256: sha256(`${stableJson(costArtifact)}\n`)
            },
            {
                file: "agent_behavior_report.json",
                sha256: sha256(`${stableJson(agentArtifact)}\n`)
            },
            {
                file: "determinism_report.json",
                sha256: sha256(`${stableJson(determinismReport)}\n`)
            },
            {
                file: "replay_report.json",
                sha256: sha256(`${stableJson(replayReport)}\n`)
            },
            {
                file: "latency_report.json",
                sha256: sha256(`${stableJson(latencyReport)}\n`)
            },
            {
                file: "latency_real_validation.json",
                sha256: sha256(`${stableJson(latencyRealValidation)}\n`)
            },
            {
                file: "workload_manifest.json",
                sha256: sha256(`${stableJson(workloadManifest)}\n`)
            }
        ]
    };
    await writeJsonArtifact(outputDir, "manifest.json", manifest);
    process.stdout.write(`${JSON.stringify({
        bundle: outputDir,
        summary
    }, null, 2)}\n`);
}
if (process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href === import.meta.url) {
    void main();
}
