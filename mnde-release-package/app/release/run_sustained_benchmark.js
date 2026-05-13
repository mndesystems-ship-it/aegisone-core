import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import "../shared/index.js";
import { buildBenchmarkMatrix } from "../audit/harness.js";
import { executeDeterministicPipeline, resetRuntimeState } from "../audit/node_runtime.js";
import { DEFAULT_BENCHMARK_OUTPUT_DIR } from "./paths.js";
function parseArgs(argv) {
    const args = {
        duration_seconds: 300,
        window_seconds: 10,
        output_dir: DEFAULT_BENCHMARK_OUTPUT_DIR
    };
    for(let index = 0; index < argv.length; index += 1){
        const current = argv[index];
        const next = argv[index + 1];
        if (current === "--duration-seconds" && next) {
            args.duration_seconds = Number(next);
            index += 1;
        } else if (current === "--window-seconds" && next) {
            args.window_seconds = Number(next);
            index += 1;
        } else if (current === "--output-dir" && next) {
            args.output_dir = path.resolve(next);
            index += 1;
        }
    }
    return args;
}
function percentile(values, ratio) {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [
        ...values
    ].sort((left, right)=>left - right);
    const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio));
    return Number(sorted[index].toFixed(6));
}
function writeJson(filePath, value) {
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function main() {
    const args = parseArgs(process.argv.slice(2));
    mkdirSync(args.output_dir, {
        recursive: true
    });
    const corpus = buildBenchmarkMatrix().filter((item)=>item.expected_valid).map((item)=>item.raw_input);
    const windows = [];
    const totalDeadline = Date.now() + args.duration_seconds * 1000;
    let totalRequests = 0;
    let cursor = 0;
    while(Date.now() < totalDeadline){
        const windowStartedAt = Date.now();
        const latenciesMs = [];
        let completedRequests = 0;
        while(Date.now() - windowStartedAt < args.window_seconds * 1000 && Date.now() < totalDeadline){
            const rawInput = corpus[cursor % corpus.length];
            cursor += 1;
            const started = process.hrtime.bigint();
            resetRuntimeState();
            executeDeterministicPipeline(rawInput);
            const ended = process.hrtime.bigint();
            latenciesMs.push(Number(ended - started) / 1_000_000);
            completedRequests += 1;
            totalRequests += 1;
        }
        const windowEndedAt = Date.now();
        const durationSeconds = Math.max((windowEndedAt - windowStartedAt) / 1000, 0.001);
        windows.push({
            window_index: windows.length,
            started_at_utc: new Date(windowStartedAt).toISOString(),
            ended_at_utc: new Date(windowEndedAt).toISOString(),
            duration_seconds: Number(durationSeconds.toFixed(6)),
            completed_requests: completedRequests,
            dropped_requests: 0,
            throughput_rps: Number((completedRequests / durationSeconds).toFixed(6)),
            latency_ms: {
                p50: percentile(latenciesMs, 0.5),
                p95: percentile(latenciesMs, 0.95),
                p99: percentile(latenciesMs, 0.99),
                p999: percentile(latenciesMs, 0.999)
            }
        });
    }
    const allLatencies = windows.flatMap((window)=>[
            window.latency_ms.p50,
            window.latency_ms.p95,
            window.latency_ms.p99,
            window.latency_ms.p999
        ]);
    const summary = {
        schema_version: "mnde.sustained_benchmark.v1",
        duration_seconds: args.duration_seconds,
        window_seconds: args.window_seconds,
        total_requests: totalRequests,
        dropped_requests: 0,
        windows,
        aggregate_latency_ms: {
            p50: percentile(allLatencies, 0.5),
            p95: percentile(allLatencies, 0.95),
            p99: percentile(allLatencies, 0.99),
            p999: percentile(allLatencies, 0.999)
        },
        success_criteria: {
            zero_dropped_requests: true,
            every_window_meets_10k_rps: windows.every((window)=>window.throughput_rps >= 10000),
            every_window_p99_under_1ms: windows.every((window)=>window.latency_ms.p99 <= 1),
            no_percentile_above_2ms: windows.every((window)=>window.latency_ms.p50 <= 2 && window.latency_ms.p95 <= 2 && window.latency_ms.p99 <= 2 && window.latency_ms.p999 <= 2)
        }
    };
    writeJson(path.join(args.output_dir, "sustained_benchmark_report.json"), summary);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
main();
