import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { canonicalizeJson } from "../shared/index.js";
import { APP_ENTRY_PATHS, DEFAULT_AUDIT_OUTPUT_DIR, NODE_BINARY_PATH, PACKAGE_ROOT, RUST_PARITY_BINARY_PATH } from "./paths.js";
import { formatProvenanceForDisplay, readProvenance } from "./provenance.js";
import { verifyManifest } from "./verify_manifest.js";
function parseArgs(argv) {
    const args = {
        output_dir: DEFAULT_AUDIT_OUTPUT_DIR,
        benchmark_duration_seconds: 300
    };
    for(let index = 0; index < argv.length; index += 1){
        const current = argv[index];
        const next = argv[index + 1];
        if (current === "--output-dir" && next) {
            args.output_dir = path.resolve(next);
            index += 1;
        } else if (current === "--benchmark-duration-seconds" && next) {
            args.benchmark_duration_seconds = Number(next);
            index += 1;
        }
    }
    return args;
}
function runChecked(command, args, cwd = PACKAGE_ROOT, extraEnv) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        env: {
            ...process.env,
            ...extraEnv
        }
    });
    if (result.status !== 0) {
        throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
    }
    return result.stdout;
}
function writeJson(filePath, value) {
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function main() {
    const args = parseArgs(process.argv.slice(2));
    mkdirSync(args.output_dir, {
        recursive: true
    });
    const manifestResult = verifyManifest();
    if (!manifestResult.ok) {
        throw new Error(`Release manifest verification failed before audit start: ${JSON.stringify(manifestResult.mismatches)}`);
    }
    const provenance = readProvenance();
    const parityVectorPath = path.join(PACKAGE_ROOT, "audit-proof-bundle", "proof_bundle", "parity_vectors.json");
    const rustParityOutputPath = path.join(PACKAGE_ROOT, "audit-proof-bundle", "proof_bundle", "rust_parity_output.json");
    runChecked(NODE_BINARY_PATH, [
        APP_ENTRY_PATHS.emitParityVectors
    ]);
    const rustParityStdout = runChecked(RUST_PARITY_BINARY_PATH, [
        parityVectorPath
    ]);
    writeFileSync(rustParityOutputPath, rustParityStdout, "utf8");
    runChecked(NODE_BINARY_PATH, [
        APP_ENTRY_PATHS.auditRun
    ], PACKAGE_ROOT, {
        RUST_PARITY_OUTPUT_PATH: rustParityOutputPath
    });
    runChecked(NODE_BINARY_PATH, [
        APP_ENTRY_PATHS.attackWave
    ]);
    runChecked(NODE_BINARY_PATH, [
        APP_ENTRY_PATHS.remediationWave
    ]);
    runChecked(NODE_BINARY_PATH, [
        APP_ENTRY_PATHS.postRemediationVerification
    ]);
    runChecked(NODE_BINARY_PATH, [
        APP_ENTRY_PATHS.controlledBenchmark
    ]);
    runChecked(NODE_BINARY_PATH, [
        APP_ENTRY_PATHS.sustainedBenchmark,
        "--duration-seconds",
        String(args.benchmark_duration_seconds)
    ]);
    const summary = {
        schema_version: "mnde.release.audit_runner.v1",
        completed_at_utc: new Date().toISOString(),
        provenance,
        manifest_verification: {
            checked_files: manifestResult.checked_files,
            ok: manifestResult.ok
        },
        outputs: {
            audit_bundle: path.join(PACKAGE_ROOT, "audit-proof-bundle"),
            attack_wave_bundle: path.join(PACKAGE_ROOT, "attack-wave-bundle"),
            remediation_wave_bundle: path.join(PACKAGE_ROOT, "remediation-wave-bundle"),
            post_remediation_bundle: path.join(PACKAGE_ROOT, "post-remediation-verification-bundle"),
            controlled_benchmark_bundle: path.join(PACKAGE_ROOT, "mnde-controlled-benchmark-bundle"),
            sustained_benchmark_bundle: path.join(PACKAGE_ROOT, "sustained-benchmark-bundle")
        }
    };
    writeJson(path.join(args.output_dir, "audit_runner_summary.json"), summary);
    process.stdout.write(`${formatProvenanceForDisplay(provenance)}\n`);
    process.stdout.write(`${canonicalizeJson(summary)}\n`);
}
main();
