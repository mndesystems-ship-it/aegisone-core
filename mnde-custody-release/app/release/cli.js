import { readFileSync } from "fs";
import path from "path";
import { assertCustodyOnlyBehavior, runCustodyRuntime, runPreflightCheck } from "../custody/runtime.js";
import { verifyCustodyReceipt } from "../shared/custody_keys.js";
import { assertReleaseIntegrity, readPublishedHash } from "./integrity.js";
import { formatProvenanceForDisplay, readProvenance } from "./provenance.js";
import { verifyManifest } from "./verify_manifest.js";
function parseFlag(argv, name) {
    const index = argv.indexOf(name);
    if (index === -1 || index === argv.length - 1) {
        return null;
    }
    return argv[index + 1] ?? null;
}
function hasFlag(argv, name) {
    return argv.includes(name);
}
function printUsage() {
    process.stdout.write([
        "mnde custody commands:",
        "  version",
        "  artifact-hash --file <manifest-path>",
        "  verify-custody-release",
        "  verify-custody-receipt --registry <file> --receipt <file>",
        "  preflight-check",
        "  custody [--check-startup]"
    ].join("\n") + "\n");
}
function printVerificationResult() {
    const result = verifyManifest();
    const custodyOnly = assertCustodyOnlyBehavior();
    const ok = result.ok && custodyOnly.ok;
    process.stdout.write(`${ok ? "PASS" : "REFUSE"}\n${JSON.stringify({
        ...result,
        custody_only_behavior: custodyOnly
    }, null, 2)}\n`);
    if (!ok) {
        process.exitCode = 1;
    }
}
async function main() {
    let [command, ...argv] = process.argv.slice(2);
    if (command?.startsWith("--")) {
        argv = [
            command,
            ...argv
        ];
        command = "custody";
    }
    if (!command || command === "help" || command === "--help") {
        printUsage();
        return;
    }
    if (command === "version" || command === "--version") {
        process.stdout.write(`${formatProvenanceForDisplay(readProvenance())}\n`);
        return;
    }
    if (command === "artifact-hash") {
        assertReleaseIntegrity();
        const file = parseFlag(argv, "--file") ?? parseFlag(argv, "--artifact");
        if (!file) {
            throw new Error("--file is required");
        }
        const result = readPublishedHash(file);
        if (!result) {
            process.stdout.write(`${JSON.stringify({
                verdict: "REFUSE",
                reason: "artifact_not_in_manifest",
                file
            }, null, 2)}\n`);
            process.exitCode = 1;
            return;
        }
        process.stdout.write(`${JSON.stringify({
            verdict: result.match ? "PASS" : "REFUSE",
            ...result
        }, null, 2)}\n`);
        if (!result.match) {
            process.exitCode = 1;
        }
        return;
    }
    if (command === "verify-custody-release" || command === "verify-manifest") {
        printVerificationResult();
        return;
    }
    if (command === "preflight-check") {
        const result = runPreflightCheck({
            configPath: parseFlag(argv, "--config") ?? undefined
        });
        process.stdout.write(`${result.ok ? "PASS" : "REFUSE"}\n${JSON.stringify(result, null, 2)}\n`);
        if (!result.ok) {
            process.exitCode = 1;
        }
        return;
    }
    if (command === "verify-custody-receipt") {
        assertReleaseIntegrity();
        const registryPath = parseFlag(argv, "--registry");
        const receiptPath = parseFlag(argv, "--receipt");
        if (!registryPath || !receiptPath) {
            throw new Error("--registry and --receipt are required");
        }
        const registry = JSON.parse(readFileSync(path.resolve(registryPath), "utf8"));
        const receipt = JSON.parse(readFileSync(path.resolve(receiptPath), "utf8"));
        const result = verifyCustodyReceipt(registry, receipt);
        process.stdout.write(`PASS\n${JSON.stringify({
            verdict: "PASS",
            ...result
        }, null, 2)}\n`);
        return;
    }
    if (command === "custody") {
        runCustodyRuntime({
            once: hasFlag(argv, "--check-startup"),
            configPath: parseFlag(argv, "--config") ?? undefined
        });
        return;
    }
    if (command === "read-config-template") {
        const configPath = path.resolve(process.cwd(), parseFlag(argv, "--file") ?? "config/custody.config.template.json");
        process.stdout.write(readFileSync(configPath, "utf8"));
        return;
    }
    throw new Error(`Unknown command: ${command}`);
}
void main().catch((error)=>{
    process.stderr.write(`${JSON.stringify({
        verdict: "REFUSE",
        error: error.message,
        code: error.code ?? "ERR_RUNTIME_ERROR"
    })}\n`);
    process.exit(1);
});
