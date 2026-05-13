import { createHash, createHmac } from "crypto";
import { mkdirSync, createWriteStream, writeFileSync, readFileSync, createReadStream } from "fs";
import { join } from "path";
import readline from "readline";
import { canonicalizeJson } from "../shared/json.js";
import { executeDeterministicPipeline, makeBaseInput, rawJson, writeJsonArtifact } from "./node_runtime.js";
const PHASE = process.argv[2] ?? "run";
const OUTPUT_DIR = join(process.cwd(), "hyper-targeted-10m-bundle");
const SIGNED_RECEIPTS_PATH = join(OUTPUT_DIR, "signed_receipts_sampled.jsonl");
const HASH_LOG_PATH = join(OUTPUT_DIR, "receipt_hashes_unsampled.jsonl");
const PARITY_VECTORS_PATH = join(OUTPUT_DIR, "parity_vectors_10m.json");
const RUST_PARITY_OUTPUT_PATH = join(OUTPUT_DIR, "rust_parity_output_10m.json");
const DRIFT_REPORT_PATH = join(OUTPUT_DIR, "drift_report.json");
const REPLAY_REPORT_PATH = join(OUTPUT_DIR, "replay_report.json");
const PARITY_REPORT_PATH = join(OUTPUT_DIR, "parity_report.json");
const ADVERSARIAL_REPORT_PATH = join(OUTPUT_DIR, "adversarial_report.json");
const PERFORMANCE_REPORT_PATH = join(OUTPUT_DIR, "performance_report.json");
const COST_ANALYSIS_PATH = join(OUTPUT_DIR, "cost_analysis.json");
const SUMMARY_PATH = join(OUTPUT_DIR, "summary.json");
const LATENCY_TIMESERIES_PATH = join(OUTPUT_DIR, "latency_timeseries_1h.json");
const THROUGHPUT_TIMESERIES_PATH = join(OUTPUT_DIR, "throughput_timeseries_1h.json");
const RESOURCE_USAGE_PATH = join(OUTPUT_DIR, "resource_usage_1h.json");
const FINAL_SUMMARY_PATH = join(OUTPUT_DIR, "final_1h_summary.json");
const MANIFEST_PATH = join(OUTPUT_DIR, "manifest.json");
const FAILING_CASES_PATH = join(OUTPUT_DIR, "minimal_repro_cases.json");
const RUN_STATE_PATH = join(OUTPUT_DIR, "run_state.json");
const RUN_MINUTES = Number(process.env.HYPER_TARGETED_MINUTES ?? "10");
const RUN_SECONDS = RUN_MINUTES * 60;
const TARGET_RPS = Number(process.env.HYPER_TARGETED_RPS ?? "5000");
const DETERMINISM_REPLAYS = Number(process.env.HYPER_TARGETED_DRIFT_REPLAYS ?? "50000");
const SAMPLE_FULL_RECEIPTS_EVERY = 5;
const PARITY_SAMPLE_TARGET = Number(process.env.HYPER_TARGETED_PARITY_TARGET ?? "5000");
const FIVE_MINUTE_INTERVAL_SECONDS = 300;
const HASH_RECEIPT_SECRET = "hyper-targeted-benchmark-secret-v1";
const HASH_RECEIPT_KEY_ID = "hyper-targeted-benchmark-key-v1";
const RUN_TIMESTAMP = new Date().toISOString();
function createHistogram(bucketWidthUs = 10, maxMs = 10) {
    const maxBucket = Math.ceil(maxMs * 1000 / bucketWidthUs);
    return {
        bucket_width_us: bucketWidthUs,
        max_bucket: maxBucket,
        counts: new Uint32Array(maxBucket + 1),
        overflow: 0,
        total: 0
    };
}
function observeHistogram(histogram, latencyMs) {
    const micros = Math.max(0, Math.round(latencyMs * 1000));
    const bucket = Math.floor(micros / histogram.bucket_width_us);
    if (bucket > histogram.max_bucket) {
        histogram.overflow += 1;
    } else {
        histogram.counts[bucket] += 1;
    }
    histogram.total += 1;
}
function percentileFromHistogram(histogram, ratio) {
    if (histogram.total === 0) {
        return 0;
    }
    const target = Math.ceil(histogram.total * ratio);
    let seen = 0;
    for(let index = 0; index < histogram.counts.length; index += 1){
        seen += histogram.counts[index];
        if (seen >= target) {
            return Number((index * histogram.bucket_width_us / 1000).toFixed(6));
        }
    }
    return Number((histogram.max_bucket * histogram.bucket_width_us / 1000).toFixed(6));
}
function resetHistogram(histogram) {
    return createHistogram(histogram.bucket_width_us, histogram.max_bucket * histogram.bucket_width_us / 1000);
}
function sha256Hex(value) {
    return createHash("sha256").update(value).digest("hex");
}
function hmacHex(value) {
    return createHmac("sha256", HASH_RECEIPT_SECRET).update(value).digest("hex");
}
function percent(numerator, denominator) {
    if (denominator === 0) {
        return 0;
    }
    return Number((numerator / denominator * 100).toFixed(6));
}
function sleepMs(value) {
    return new Promise((resolve)=>setTimeout(resolve, value));
}
function buildWeightedSchedule() {
    return [
        ...Array.from({
            length: 20
        }, ()=>"valid_high_cost_allow"),
        ...Array.from({
            length: 10
        }, ()=>"valid_boundary_allow"),
        ...Array.from({
            length: 15
        }, ()=>"violation_autoscale_spike"),
        ...Array.from({
            length: 15
        }, ()=>"violation_retry_storm"),
        ...Array.from({
            length: 10
        }, ()=>"violation_long_running_cost"),
        ...Array.from({
            length: 5
        }, ()=>"violation_runtime_gpu_drift"),
        ...Array.from({
            length: 5
        }, ()=>"violation_tool_sequence"),
        ...Array.from({
            length: 8
        }, ()=>"malformed_json"),
        ...Array.from({
            length: 5
        }, ()=>"duplicate_keys"),
        ...Array.from({
            length: 4
        }, ()=>"unknown_fields"),
        ...Array.from({
            length: 3
        }, ()=>"missing_required_fields")
    ];
}
function projectedCostCentsFromParsed(input) {
    const request = input.execution_request;
    const scaleMultiplier = request.execution.auto_scale ? request.execution.max_scale_multiplier : 1;
    const retryMultiplier = request.execution.retry_on_fail ? request.execution.max_retries + 1 : 1;
    return request.resources.gpu_count * request.resources.hours * input.pricing_data.gpu_hour_cents * scaleMultiplier * retryMultiplier;
}
function buildScenarioRequest(category, sequence) {
    if (category === "valid_high_cost_allow") {
        const gpuCount = 16 + sequence % 3;
        const hours = 12 + sequence % 3;
        const input = makeBaseInput({
            execution_request: {
                request_id: `valid-high-${sequence}`,
                resources: {
                    gpu_type: "a10g",
                    gpu_count: gpuCount,
                    hours
                },
                execution: {
                    auto_scale: false,
                    max_scale_multiplier: 1,
                    retry_on_fail: false,
                    max_retries: 0
                },
                release_request: {
                    execution_id: `exec-valid-high-${sequence}`,
                    hold_state: "APPROVED",
                    already_consumed: false
                },
                runtime_observation: {
                    kill_switch_active: false,
                    actual_gpu_count: gpuCount,
                    actual_hours: hours,
                    actual_total_cost_cents: gpuCount * hours * 500
                }
            }
        });
        return {
            category,
            expected_reason: "OK_ALLOW",
            simulated_before_cost_cents: projectedCostCentsFromParsed(input),
            raw_input: rawJson(input),
            parity_eligible: true
        };
    }
    if (category === "valid_boundary_allow") {
        const input = makeBaseInput({
            execution_request: {
                request_id: `valid-boundary-${sequence}`,
                resources: {
                    gpu_type: "a10g",
                    gpu_count: 32,
                    hours: 10
                },
                execution: {
                    auto_scale: false,
                    max_scale_multiplier: 1,
                    retry_on_fail: false,
                    max_retries: 0
                },
                release_request: {
                    execution_id: `exec-valid-boundary-${sequence}`,
                    hold_state: "APPROVED",
                    already_consumed: false
                },
                runtime_observation: {
                    kill_switch_active: false,
                    actual_gpu_count: 32,
                    actual_hours: 10,
                    actual_total_cost_cents: 160000
                }
            }
        });
        return {
            category,
            expected_reason: "OK_ALLOW",
            simulated_before_cost_cents: projectedCostCentsFromParsed(input),
            raw_input: rawJson(input),
            parity_eligible: true
        };
    }
    if (category === "violation_autoscale_spike") {
        const input = makeBaseInput({
            execution_request: {
                request_id: `viol-autoscale-${sequence}`,
                resources: {
                    gpu_type: "a10g",
                    gpu_count: 24,
                    hours: 48
                },
                execution: {
                    auto_scale: true,
                    max_scale_multiplier: 28 + sequence % 5,
                    retry_on_fail: false,
                    max_retries: 0
                },
                release_request: {
                    execution_id: `exec-viol-autoscale-${sequence}`,
                    hold_state: "PENDING",
                    already_consumed: false
                },
                runtime_observation: {
                    kill_switch_active: false,
                    actual_gpu_count: 24,
                    actual_hours: 48,
                    actual_total_cost_cents: 576000
                }
            }
        });
        return {
            category,
            expected_reason: "ERR_MANUAL_APPROVAL_REQUIRED",
            simulated_before_cost_cents: projectedCostCentsFromParsed(input),
            raw_input: rawJson(input),
            parity_eligible: true
        };
    }
    if (category === "violation_retry_storm") {
        const input = makeBaseInput({
            execution_request: {
                request_id: `viol-retry-${sequence}`,
                resources: {
                    gpu_type: "a10g",
                    gpu_count: 16,
                    hours: 24
                },
                execution: {
                    auto_scale: false,
                    max_scale_multiplier: 1,
                    retry_on_fail: true,
                    max_retries: 60 + sequence % 41
                },
                release_request: {
                    execution_id: `exec-viol-retry-${sequence}`,
                    hold_state: "APPROVED",
                    already_consumed: false
                },
                runtime_observation: {
                    kill_switch_active: false,
                    actual_gpu_count: 16,
                    actual_hours: 24,
                    actual_total_cost_cents: 192000
                }
            }
        });
        return {
            category,
            expected_reason: "ERR_RETRY_LIMIT",
            simulated_before_cost_cents: projectedCostCentsFromParsed(input),
            raw_input: rawJson(input),
            parity_eligible: true
        };
    }
    if (category === "violation_long_running_cost") {
        const input = makeBaseInput({
            execution_request: {
                request_id: `viol-long-${sequence}`,
                resources: {
                    gpu_type: "a10g",
                    gpu_count: 32,
                    hours: 72
                },
                execution: {
                    auto_scale: false,
                    max_scale_multiplier: 1,
                    retry_on_fail: false,
                    max_retries: 0
                },
                release_request: {
                    execution_id: `exec-viol-long-${sequence}`,
                    hold_state: "APPROVED",
                    already_consumed: false
                },
                runtime_observation: {
                    kill_switch_active: false,
                    actual_gpu_count: 32,
                    actual_hours: 72,
                    actual_total_cost_cents: 1152000
                }
            }
        });
        return {
            category,
            expected_reason: "ERR_COST_LIMIT",
            simulated_before_cost_cents: projectedCostCentsFromParsed(input),
            raw_input: rawJson(input),
            parity_eligible: true
        };
    }
    if (category === "violation_runtime_gpu_drift") {
        const input = makeBaseInput({
            execution_request: {
                request_id: `viol-runtime-${sequence}`,
                resources: {
                    gpu_type: "a10g",
                    gpu_count: 8,
                    hours: 12
                },
                execution: {
                    auto_scale: false,
                    max_scale_multiplier: 1,
                    retry_on_fail: false,
                    max_retries: 0
                },
                release_request: {
                    execution_id: `exec-viol-runtime-${sequence}`,
                    hold_state: "APPROVED",
                    already_consumed: false
                },
                runtime_observation: {
                    kill_switch_active: false,
                    actual_gpu_count: 10,
                    actual_hours: 12,
                    actual_total_cost_cents: 48000
                }
            }
        });
        return {
            category,
            expected_reason: "ERR_RUNTIME_GPU_DRIFT",
            simulated_before_cost_cents: projectedCostCentsFromParsed(input),
            raw_input: rawJson(input),
            parity_eligible: true
        };
    }
    if (category === "violation_tool_sequence") {
        const input = makeBaseInput({
            execution_request: {
                request_id: `viol-tool-${sequence}`,
                tool_calls: [
                    {
                        tool: "verify",
                        priority: 2
                    },
                    {
                        tool: "compile",
                        priority: 1
                    }
                ],
                orbit_intent: {
                    payload: {
                        tool_calls: [
                            {
                                tool: "compile",
                                priority: 1
                            },
                            {
                                tool: "verify",
                                priority: 2
                            }
                        ]
                    }
                }
            }
        });
        return {
            category,
            expected_reason: "ERR_TOOL_CALL_SEQUENCE",
            simulated_before_cost_cents: projectedCostCentsFromParsed(input),
            raw_input: rawJson(input),
            parity_eligible: true
        };
    }
    if (category === "malformed_json") {
        return {
            category,
            expected_reason: "ERR_INVALID_JSON_SYNTAX",
            simulated_before_cost_cents: 0,
            raw_input: "{\"execution_request\":",
            parity_eligible: false
        };
    }
    if (category === "duplicate_keys") {
        const base = makeBaseInput();
        return {
            category,
            expected_reason: "ERR_DUPLICATE_JSON_KEYS",
            simulated_before_cost_cents: 0,
            raw_input: `{"execution_request":{"request_id":"dup-${sequence}","request_id":"dup-${sequence + 1}"},"policy_document":${JSON.stringify(base.policy_document)},"pricing_data":${JSON.stringify(base.pricing_data)}}`,
            parity_eligible: false
        };
    }
    if (category === "unknown_fields") {
        const base = makeBaseInput({
            execution_request: {
                request_id: `unknown-${sequence}`
            }
        });
        return {
            category,
            expected_reason: "ERR_SCHEMA_VALIDATION",
            simulated_before_cost_cents: 0,
            raw_input: JSON.stringify({
                ...base,
                execution_request: {
                    ...base.execution_request,
                    unknown_control: true
                }
            }),
            parity_eligible: false
        };
    }
    const base = makeBaseInput({
        execution_request: {
            request_id: `missing-${sequence}`
        }
    });
    const value = JSON.parse(rawJson(base));
    delete value.pricing_data.gpu_hour_cents;
    return {
        category,
        expected_reason: "ERR_SCHEMA_VALIDATION",
        simulated_before_cost_cents: 0,
        raw_input: JSON.stringify(value),
        parity_eligible: false
    };
}
function makeWrappedReceipt(rawInput, reasonCode) {
    const requestHash = sha256Hex(rawInput);
    const decisionHash = sha256Hex(canonicalizeJson({
        request_hash: requestHash,
        decision: "REFUSE",
        reason_code: reasonCode,
        policy_version: "parse_boundary",
        total_cost_usd: "0.00",
        allowed_cost_usd: "0.00",
        prevented_cost_usd: "0.00"
    }));
    const payload = {
        schema_version: "ecs.benchmark.receipt.v1",
        request_hash: requestHash,
        canonical_request: rawInput,
        decision_output: {
            decision: "REFUSE",
            decision_hash: decisionHash,
            request_hash: requestHash,
            reason_code: reasonCode,
            total_cost_usd: "0.00",
            allowed_cost_usd: "0.00",
            prevented_cost_usd: "0.00",
            policy_version: "parse_boundary"
        },
        pipeline_trace: {
            preflight: {
                layer: "Preflight",
                canonicalization: "RAW_INPUT",
                request_hash: requestHash
            },
            orbit: {
                layer: "Orbit",
                decision: "FAIL",
                reason_code: reasonCode,
                validation_hash: sha256Hex(rawInput)
            },
            arm: {
                layer: "ARM",
                decision: "REFUSE",
                reason_code: reasonCode,
                projected_total_cost_cents: 0,
                allowed_cost_cents: 0,
                prevented_cost_cents: 0
            },
            ram0na: {
                layer: "RAM0NA",
                decision: "REFUSE",
                reason_code: reasonCode,
                runtime_hash: sha256Hex(reasonCode)
            }
        }
    };
    const signature = {
        algorithm: "HMAC-SHA256",
        key_id: HASH_RECEIPT_KEY_ID,
        value: hmacHex(canonicalizeJson(payload))
    };
    const receipt = {
        ...payload,
        signature
    };
    return {
        receipt_bytes: canonicalizeJson(receipt),
        receipt,
        decision: "REFUSE",
        decision_hash: decisionHash,
        reason_code: reasonCode,
        canonical_request: rawInput,
        request_hash: requestHash,
        total_cost_cents: 0,
        allowed_cost_cents: 0,
        prevented_cost_cents: 0
    };
}
function usdToCents(value) {
    const [dollars, cents = "00"] = value.split(".");
    return Number(dollars) * 100 + Number(cents.padEnd(2, "0").slice(0, 2));
}
function executeSigned(rawInput) {
    const result = executeDeterministicPipeline(rawInput);
    if ("parse_boundary" in result) {
        return makeWrappedReceipt(rawInput, result.reason_code);
    }
    return {
        receipt_bytes: result.receipt_bytes,
        receipt: result.receipt,
        decision: result.receipt.decision_output.decision,
        decision_hash: result.receipt.decision_output.decision_hash,
        reason_code: result.receipt.decision_output.reason_code,
        canonical_request: result.receipt.canonical_request,
        request_hash: result.receipt.request_hash,
        total_cost_cents: usdToCents(result.receipt.decision_output.total_cost_usd),
        allowed_cost_cents: usdToCents(result.receipt.decision_output.allowed_cost_usd),
        prevented_cost_cents: usdToCents(result.receipt.decision_output.prevented_cost_usd)
    };
}
function receiptSha256(receiptBytes) {
    return sha256Hex(receiptBytes);
}
function stabilityBand(values) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean = values.reduce((sum, value)=>sum + value, 0) / values.length;
    const maxDeviation = Math.max(Math.abs(max - mean), Math.abs(min - mean));
    return {
        min: Number(min.toFixed(6)),
        max: Number(max.toFixed(6)),
        mean: Number(mean.toFixed(6)),
        within_10_percent_band: mean === 0 ? true : maxDeviation / mean <= 0.1
    };
}
async function runPhase() {
    mkdirSync(OUTPUT_DIR, {
        recursive: true
    });
    const fullReceiptStream = createWriteStream(SIGNED_RECEIPTS_PATH, {
        flags: "w"
    });
    const hashStream = createWriteStream(HASH_LOG_PATH, {
        flags: "w"
    });
    const schedule = buildWeightedSchedule();
    const throughputPerMinute = [];
    const latencyTimeseries = [];
    const resourceUsage = [];
    const refusalDistribution = {};
    const categoryDistribution = {};
    const preventedCostByCategory = {};
    const driftFailures = [];
    const adversarialFailures = [];
    const parityVectors = [];
    const deterministicCase = buildScenarioRequest("violation_retry_storm", 900000);
    const deterministicBaseline = executeSigned(deterministicCase.raw_input);
    const throughputMinuteCounts = Array.from({
        length: RUN_MINUTES
    }, ()=>0);
    let totalExecutions = 0;
    let primaryExecutions = 0;
    let sampledReceipts = 0;
    let hashOnlyReceipts = 0;
    let parityMirrors = 0;
    let beforeCostCents = 0;
    let afterCostCents = 0;
    let preventedCostCents = 0;
    let classificationTotal = 0;
    let classificationCorrect = 0;
    let driftChecks = 0;
    let lastCpu = process.cpuUsage();
    let fiveMinuteHistogram = createHistogram();
    let fiveMinuteStartPrimary = 0;
    let fiveMinuteDecisionDistribution = {
        ALLOW: 0,
        REFUSE: 0
    };
    let fiveMinuteStartTime = Date.now();
    for(let secondIndex = 0; secondIndex < RUN_SECONDS; secondIndex += 1){
        const secondStart = Date.now();
        for(let perSecondIndex = 0; perSecondIndex < TARGET_RPS; perSecondIndex += 1){
            const category = schedule[(primaryExecutions + perSecondIndex) % schedule.length];
            const scenario = buildScenarioRequest(category, primaryExecutions);
            const start = process.hrtime.bigint();
            const outcome = executeSigned(scenario.raw_input);
            const end = process.hrtime.bigint();
            observeHistogram(fiveMinuteHistogram, Number(end - start) / 1_000_000);
            totalExecutions += 1;
            primaryExecutions += 1;
            throughputMinuteCounts[Math.floor(secondIndex / 60)] += 1;
            categoryDistribution[category] = (categoryDistribution[category] ?? 0) + 1;
            refusalDistribution[outcome.reason_code] = (refusalDistribution[outcome.reason_code] ?? 0) + 1;
            const simulatedAfter = outcome.decision === "ALLOW" ? outcome.allowed_cost_cents : 0;
            beforeCostCents += scenario.simulated_before_cost_cents;
            afterCostCents += simulatedAfter;
            preventedCostCents += Math.max(scenario.simulated_before_cost_cents - simulatedAfter, 0);
            preventedCostByCategory[category] = (preventedCostByCategory[category] ?? 0) + Math.max(scenario.simulated_before_cost_cents - simulatedAfter, 0);
            fiveMinuteDecisionDistribution[outcome.decision] += 1;
            classificationTotal += 1;
            if (outcome.reason_code === scenario.expected_reason) {
                classificationCorrect += 1;
            } else if (adversarialFailures.length < 50) {
                adversarialFailures.push({
                    category,
                    expected_reason: scenario.expected_reason,
                    actual_reason: outcome.reason_code
                });
            }
            if (primaryExecutions % SAMPLE_FULL_RECEIPTS_EVERY === 0) {
                fullReceiptStream.write(`${outcome.receipt_bytes}\n`);
                sampledReceipts += 1;
            } else {
                hashStream.write(`${JSON.stringify({
                    request_hash: outcome.request_hash,
                    decision_hash: outcome.decision_hash,
                    receipt_sha256: receiptSha256(outcome.receipt_bytes),
                    category
                })}\n`);
                hashOnlyReceipts += 1;
            }
            if (scenario.parity_eligible && parityMirrors < PARITY_SAMPLE_TARGET && primaryExecutions % 600 === 0) {
                parityVectors.push({
                    case_id: `parity-${primaryExecutions}`,
                    raw_input: scenario.raw_input
                });
                parityMirrors += 1;
            }
        }
        const driftChecksThisSecond = Math.min(84, DETERMINISM_REPLAYS - driftChecks);
        for(let replayIndex = 0; replayIndex < driftChecksThisSecond; replayIndex += 1){
            const next = executeSigned(deterministicCase.raw_input);
            totalExecutions += 1;
            driftChecks += 1;
            if (next.receipt_bytes !== deterministicBaseline.receipt_bytes && driftFailures.length < 25) {
                driftFailures.push({
                    replay_index: driftChecks,
                    expected_receipt: deterministicBaseline.receipt_bytes,
                    actual_receipt: next.receipt_bytes
                });
            }
        }
        if ((secondIndex + 1) % 60 === 0) {
            throughputPerMinute.push(throughputMinuteCounts[Math.floor(secondIndex / 60)]);
        }
        if ((secondIndex + 1) % FIVE_MINUTE_INTERVAL_SECONDS === 0) {
            const cpu = process.cpuUsage(lastCpu);
            const elapsedMs = Date.now() - fiveMinuteStartTime;
            resourceUsage.push({
                minute_mark: (secondIndex + 1) / 60,
                memory_rss_bytes: process.memoryUsage().rss,
                heap_used_bytes: process.memoryUsage().heapUsed,
                cpu_user_microseconds: cpu.user,
                cpu_system_microseconds: cpu.system,
                cpu_percent: Number(((cpu.user + cpu.system) / 1000 / elapsedMs * 100).toFixed(6))
            });
            latencyTimeseries.push({
                minute_mark: (secondIndex + 1) / 60,
                p50_ms: percentileFromHistogram(fiveMinuteHistogram, 0.5),
                p95_ms: percentileFromHistogram(fiveMinuteHistogram, 0.95),
                p99_ms: percentileFromHistogram(fiveMinuteHistogram, 0.99),
                throughput: primaryExecutions - fiveMinuteStartPrimary,
                decision_distribution: fiveMinuteDecisionDistribution,
                cumulative_cost_before_cents: beforeCostCents,
                cumulative_cost_after_cents: afterCostCents
            });
            fiveMinuteHistogram = resetHistogram(fiveMinuteHistogram);
            fiveMinuteStartPrimary = primaryExecutions;
            fiveMinuteDecisionDistribution = {
                ALLOW: 0,
                REFUSE: 0
            };
            fiveMinuteStartTime = Date.now();
            lastCpu = process.cpuUsage();
        }
        const elapsed = Date.now() - secondStart;
        if (elapsed < 1000) {
            await sleepMs(1000 - elapsed);
        }
    }
    await new Promise((resolve)=>fullReceiptStream.end(resolve));
    await new Promise((resolve)=>hashStream.end(resolve));
    if (parityVectors.length < PARITY_SAMPLE_TARGET) {
        const sampleReader = readline.createInterface({
            input: createReadStream(SIGNED_RECEIPTS_PATH, {
                encoding: "utf8"
            }),
            crlfDelay: Infinity
        });
        for await (const line of sampleReader){
            if (line.length === 0 || parityVectors.length >= PARITY_SAMPLE_TARGET) {
                continue;
            }
            const receipt = JSON.parse(line);
            if (receipt.schema_version !== "ecs.receipt.v1") {
                continue;
            }
            parityVectors.push({
                case_id: `parity-backfill-${parityVectors.length.toString().padStart(4, "0")}`,
                raw_input: receipt.canonical_request
            });
        }
    }
    writeFileSync(PARITY_VECTORS_PATH, `${JSON.stringify(parityVectors, null, 2)}\n`, "utf8");
    const throughputStability = stabilityBand(throughputPerMinute);
    const latencyVariance = stabilityBand(latencyTimeseries.map((item)=>Number(item.p99_ms)));
    const memoryTrend = resourceUsage.length < 2 ? {
        no_upward_trend: true,
        first: resourceUsage[0]?.memory_rss_bytes ?? 0,
        last: resourceUsage[0]?.memory_rss_bytes ?? 0
    } : {
        no_upward_trend: Number(resourceUsage.at(-1)?.memory_rss_bytes ?? 0) <= Number(resourceUsage[0]?.memory_rss_bytes ?? 0) * 1.1,
        first: Number(resourceUsage[0]?.memory_rss_bytes ?? 0),
        last: Number(resourceUsage.at(-1)?.memory_rss_bytes ?? 0)
    };
    writeJsonArtifact(DRIFT_REPORT_PATH, {
        schema_version: "ecs.audit.hyper_targeted.drift_report.v1",
        deterministic_replays: driftChecks,
        drift_count: driftFailures.length,
        drift_rate: percent(driftFailures.length, driftChecks),
        failures: driftFailures
    });
    writeJsonArtifact(ADVERSARIAL_REPORT_PATH, {
        schema_version: "ecs.audit.hyper_targeted.adversarial_report.v1",
        total_cases: classificationTotal,
        correct_classifications: classificationCorrect,
        classification_accuracy: percent(classificationCorrect, classificationTotal),
        failures: adversarialFailures
    });
    writeJsonArtifact(COST_ANALYSIS_PATH, {
        schema_version: "ecs.audit.hyper_targeted.cost_analysis.v1",
        cost_before_cents: beforeCostCents,
        cost_after_cents: afterCostCents,
        cost_prevented_cents: preventedCostCents,
        percent_reduction: percent(beforeCostCents - afterCostCents, beforeCostCents),
        top_prevented_scenarios: Object.entries(preventedCostByCategory).sort((left, right)=>right[1] - left[1]).slice(0, 3).map(([category, cents])=>({
                category,
                prevented_cost_cents: cents
            }))
    });
    writeJsonArtifact(PERFORMANCE_REPORT_PATH, {
        schema_version: "ecs.audit.hyper_targeted.performance_report.v1",
        target_rps: TARGET_RPS,
        throughput_per_minute: throughputPerMinute,
        throughput_stability: throughputStability,
        latency_timeseries: latencyTimeseries,
        latency_variance: latencyVariance,
        resource_usage: resourceUsage,
        memory_trend: memoryTrend
    });
    writeJsonArtifact(LATENCY_TIMESERIES_PATH, latencyTimeseries);
    writeJsonArtifact(THROUGHPUT_TIMESERIES_PATH, throughputPerMinute);
    writeJsonArtifact(RESOURCE_USAGE_PATH, resourceUsage);
    writeJsonArtifact(RUN_STATE_PATH, {
        total_executions: totalExecutions,
        primary_executions: primaryExecutions,
        sampled_receipts: sampledReceipts,
        hash_only_receipts: hashOnlyReceipts,
        before_cost_cents: beforeCostCents,
        after_cost_cents: afterCostCents,
        prevented_cost_cents: preventedCostCents,
        classification_total: classificationTotal,
        classification_correct: classificationCorrect,
        refusal_distribution: refusalDistribution,
        category_distribution: categoryDistribution,
        prevented_cost_by_category: preventedCostByCategory,
        throughput_per_minute: throughputPerMinute,
        throughput_stability: throughputStability,
        latency_timeseries: latencyTimeseries,
        resource_usage: resourceUsage,
        latency_variance: latencyVariance,
        memory_trend: memoryTrend,
        parity_vectors: parityVectors.length
    });
}
async function replayStoredReceipts() {
    const failures = [];
    let mismatches = 0;
    let total = 0;
    const reader = readline.createInterface({
        input: createReadStream(SIGNED_RECEIPTS_PATH, {
            encoding: "utf8"
        }),
        crlfDelay: Infinity
    });
    for await (const line of reader){
        if (line.length === 0) {
            continue;
        }
        const receipt = JSON.parse(line);
        const next = executeSigned(receipt.canonical_request);
        total += 1;
        if (next.receipt_bytes !== line) {
            mismatches += 1;
            if (failures.length < 25) {
                failures.push({
                    request_hash: receipt.request_hash,
                    expected_receipt: line,
                    actual_receipt: next.receipt_bytes
                });
            }
        }
    }
    return {
        total_replays: total,
        mismatch_count: mismatches,
        drift_rate: percent(mismatches, total),
        failures
    };
}
async function hashFile(path) {
    return await new Promise((resolve, reject)=>{
        const hash = createHash("sha256");
        const stream = createReadStream(path);
        stream.on("data", (chunk)=>hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", ()=>resolve(hash.digest("hex")));
    });
}
async function finalizePhase() {
    const state = JSON.parse(readFileSync(RUN_STATE_PATH, "utf8"));
    const parityVectors = JSON.parse(readFileSync(PARITY_VECTORS_PATH, "utf8"));
    const rustOutputs = JSON.parse(readFileSync(RUST_PARITY_OUTPUT_PATH, "utf8"));
    const replayReport = await replayStoredReceipts();
    const parityResults = parityVectors.map((vector, index)=>{
        const node = executeSigned(vector.raw_input);
        const rust = rustOutputs[index];
        return {
            case_id: vector.case_id,
            receipt_bytes_identical: node.receipt_bytes === rust.receipt_bytes,
            decision_hash_identical: node.decision_hash === rust.decision_hash,
            decision_identical: node.decision === rust.decision
        };
    });
    const parityMismatchCount = parityResults.filter((item)=>!item.receipt_bytes_identical || !item.decision_hash_identical || !item.decision_identical).length;
    const parityReport = {
        schema_version: "ecs.audit.hyper_targeted.parity_report.v1",
        total_comparisons: parityResults.length,
        mismatch_count: parityMismatchCount,
        results: parityResults
    };
    const summary = {
        schema_version: "ecs.audit.hyper_targeted.summary.v1",
        total_executions: state.total_executions,
        prevented_cost_cents: state.prevented_cost_cents,
        top_3_prevented_high_cost_scenarios: Object.entries(state.prevented_cost_by_category).sort((left, right)=>Number(right[1]) - Number(left[1])).slice(0, 3).map(([category, cents])=>({
                category,
                prevented_cost_cents: cents
            })),
        latency_distribution: {
            p50_ms: state.latency_timeseries.at(-1)?.p50_ms ?? 0,
            p95_ms: state.latency_timeseries.at(-1)?.p95_ms ?? 0,
            p99_ms: state.latency_timeseries.at(-1)?.p99_ms ?? 0
        },
        determinism: JSON.parse(readFileSync(DRIFT_REPORT_PATH, "utf8")),
        replay: replayReport,
        parity: {
            total_comparisons: parityReport.total_comparisons,
            mismatch_count: parityReport.mismatch_count
        }
    };
    const finalSummary = {
        schema_version: "ecs.audit.hyper_targeted.final_1h_summary.v1",
        total_executions: state.total_executions,
        cost_before_cents: state.before_cost_cents,
        cost_after_cents: state.after_cost_cents,
        cost_prevented_cents: state.prevented_cost_cents,
        percent_reduction: percent(state.before_cost_cents - state.after_cost_cents, state.before_cost_cents),
        drift_rate: replayReport.drift_rate,
        parity_results: {
            total_comparisons: parityReport.total_comparisons,
            mismatch_count: parityReport.mismatch_count
        },
        latency_summary: {
            p50_ms: state.latency_timeseries.at(-1)?.p50_ms ?? 0,
            p95_ms: state.latency_timeseries.at(-1)?.p95_ms ?? 0,
            p99_ms: state.latency_timeseries.at(-1)?.p99_ms ?? 0
        },
        pass_fail: {
            zero_drift_mismatches: JSON.parse(readFileSync(DRIFT_REPORT_PATH, "utf8")).drift_count === 0,
            zero_replay_mismatches: replayReport.mismatch_count === 0,
            zero_cross_runtime_mismatches: parityReport.mismatch_count === 0,
            cost_reduction_over_95_percent: percent(state.before_cost_cents - state.after_cost_cents, state.before_cost_cents) >= 95,
            stable_throughput: state.throughput_stability.within_10_percent_band,
            latency_variance_within_10_percent_band: state.latency_variance.within_10_percent_band,
            no_upward_memory_trend: state.memory_trend.no_upward_trend,
            refusal_classification_100_percent: percent(state.classification_correct, state.classification_total) === 100,
            sub_1ms_p99: (state.latency_timeseries.at(-1)?.p99_ms ?? 0) < 1
        }
    };
    writeJsonArtifact(REPLAY_REPORT_PATH, replayReport);
    writeJsonArtifact(PARITY_REPORT_PATH, parityReport);
    writeJsonArtifact(SUMMARY_PATH, summary);
    writeJsonArtifact(FINAL_SUMMARY_PATH, finalSummary);
    writeJsonArtifact(FAILING_CASES_PATH, {
        drift_failures: JSON.parse(readFileSync(DRIFT_REPORT_PATH, "utf8")).failures,
        replay_failures: replayReport.failures,
        parity_failures: parityResults.filter((item)=>!item.receipt_bytes_identical || !item.decision_hash_identical || !item.decision_identical),
        adversarial_failures: JSON.parse(readFileSync(ADVERSARIAL_REPORT_PATH, "utf8")).failures
    });
    const manifestFiles = [
        "summary.json",
        "drift_report.json",
        "replay_report.json",
        "parity_report.json",
        "adversarial_report.json",
        "performance_report.json",
        "cost_analysis.json",
        "signed_receipts_sampled.jsonl",
        "latency_timeseries_1h.json",
        "throughput_timeseries_1h.json",
        "resource_usage_1h.json",
        "final_1h_summary.json",
        "minimal_repro_cases.json"
    ];
    writeJsonArtifact(MANIFEST_PATH, {
        schema_version: "ecs.audit.hyper_targeted.manifest.v1",
        generated_at: RUN_TIMESTAMP,
        artifacts: await Promise.all(manifestFiles.map(async (file)=>({
                file,
                sha256: await hashFile(join(OUTPUT_DIR, file))
            })))
    });
}
async function main() {
    if (PHASE === "run") {
        await runPhase();
        return;
    }
    if (PHASE === "finalize") {
        finalizePhase();
        return;
    }
    throw new Error(`Unknown phase: ${PHASE}`);
}
await main();
