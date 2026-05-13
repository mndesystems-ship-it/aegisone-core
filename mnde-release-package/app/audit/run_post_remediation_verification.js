import { join } from "path";
import { readFileSync, writeFileSync } from "fs";
import { canonicalizeJson } from "../shared/index.js";
import { buildRemediationCases } from "./run_remediation_wave.js";
import { appendReceipts, ensureDir, executeDeterministicPipeline, makeBaseInput, rawJson, replayReceiptStore, resetRuntimeState, seedBudgetToken, simulateConcurrentDuplicate, verifySignedReceipt, writeJsonArtifact } from "./node_runtime.js";
const OUTPUT_DIR = join(process.cwd(), "post-remediation-verification-bundle");
const RECEIPT_PATH = join(OUTPUT_DIR, "produced_receipts.jsonl");
const REPORT_PATH = join(OUTPUT_DIR, "post_verification_report.json");
function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}
function runCase(caseDef) {
    resetRuntimeState();
    if (typeof caseDef.setup === "function") {
        caseDef.setup();
    }
    const result = executeDeterministicPipeline(caseDef.raw_input ?? "");
    if ("parse_boundary" in result) {
        return {
            decision: result.decision,
            reason_code: result.reason_code,
            decision_hash: result.decision_hash,
            receipt_bytes: null,
            valid_receipt: false
        };
    }
    return {
        decision: result.receipt.decision_output.decision,
        reason_code: result.receipt.decision_output.reason_code,
        decision_hash: result.receipt.decision_output.decision_hash,
        receipt_bytes: result.receipt_bytes,
        valid_receipt: true
    };
}
function runSequentialDouble(rawInput) {
    resetRuntimeState();
    const firstRaw = executeDeterministicPipeline(rawInput);
    const first = "parse_boundary" in firstRaw ? {
        decision: firstRaw.decision,
        reason_code: firstRaw.reason_code,
        decision_hash: firstRaw.decision_hash,
        receipt_bytes: null,
        valid_receipt: false
    } : {
        decision: firstRaw.receipt.decision_output.decision,
        reason_code: firstRaw.receipt.decision_output.reason_code,
        decision_hash: firstRaw.receipt.decision_output.decision_hash,
        receipt_bytes: firstRaw.receipt_bytes,
        valid_receipt: true
    };
    const secondRaw = executeDeterministicPipeline(rawInput);
    const second = "parse_boundary" in secondRaw ? {
        decision: secondRaw.decision,
        reason_code: secondRaw.reason_code,
        decision_hash: secondRaw.decision_hash,
        receipt_bytes: null,
        valid_receipt: false
    } : {
        decision: secondRaw.receipt.decision_output.decision,
        reason_code: secondRaw.receipt.decision_output.reason_code,
        decision_hash: secondRaw.receipt.decision_output.decision_hash,
        receipt_bytes: secondRaw.receipt_bytes,
        valid_receipt: true
    };
    return {
        first,
        second
    };
}
function resultFingerprint(result) {
    return canonicalizeJson(result);
}
function runDriftChecks() {
    const cases = buildRemediationCases();
    let driftMismatchCount = 0;
    let decisionHashStable = true;
    let reasonCodeStable = true;
    let receiptBytesStable = true;
    const sampleResults = [];
    for (const caseDef of cases){
        let baseline = null;
        for(let iteration = 0; iteration < 25; iteration += 1){
            let current;
            if (caseDef.mode === "pipeline") {
                current = resultFingerprint(runCase(caseDef));
            } else if (caseDef.test_id === "TC-065") {
                current = resultFingerprint(simulateConcurrentDuplicate(caseDef.raw_input ?? ""));
            } else {
                current = resultFingerprint(runSequentialDouble(caseDef.raw_input ?? ""));
            }
            if (baseline === null) {
                baseline = current;
            } else if (baseline !== current) {
                driftMismatchCount += 1;
            }
        }
        if (caseDef.mode === "pipeline") {
            const first = runCase(caseDef);
            const second = runCase(caseDef);
            decisionHashStable &&= first.decision_hash === second.decision_hash;
            reasonCodeStable &&= first.reason_code === second.reason_code;
            receiptBytesStable &&= first.receipt_bytes === second.receipt_bytes;
            sampleResults.push({
                test_id: caseDef.test_id,
                first,
                second
            });
        }
    }
    return {
        repeated_inputs: buildRemediationCases().length * 25,
        drift_mismatch_count: driftMismatchCount,
        decision_hash_stability: decisionHashStable,
        reason_code_stability: reasonCodeStable,
        receipt_byte_stability: receiptBytesStable,
        samples: sampleResults
    };
}
function collectReceiptsFromThisRun() {
    const cases = buildRemediationCases();
    const receipts = [];
    for (const caseDef of cases){
        if (caseDef.mode !== "pipeline") {
            continue;
        }
        resetRuntimeState();
        caseDef.setup?.();
        const result = executeDeterministicPipeline(caseDef.raw_input ?? "");
        if (!("parse_boundary" in result)) {
            receipts.push(result.receipt);
        }
    }
    appendReceipts(RECEIPT_PATH, receipts);
    return replayReceiptStore(RECEIPT_PATH);
}
function runConcurrencyStress() {
    const refusalCodes = {};
    let winnerCount = 0;
    let loserCount = 0;
    let duplicateAllows = 0;
    for(let index = 0; index < 100; index += 1){
        const rawInput = rawJson(makeBaseInput({
            execution_request: {
                request_id: `conc-${index}`,
                release_request: {
                    execution_id: `conc-exec-${index}`,
                    hold_state: "APPROVED",
                    already_consumed: false
                }
            }
        }));
        const result = simulateConcurrentDuplicate(rawInput);
        if (result.first.decision === "ALLOW") {
            winnerCount += 1;
        }
        if (result.second.decision === "REFUSE") {
            loserCount += 1;
            refusalCodes[result.second.reason_code] = (refusalCodes[result.second.reason_code] ?? 0) + 1;
        }
        if (result.first.decision === "ALLOW" && result.second.decision === "ALLOW") {
            duplicateAllows += 1;
        }
    }
    return {
        winner_count: winnerCount,
        loser_count: loserCount,
        duplicate_allows: duplicateAllows,
        refusal_code_distribution: refusalCodes
    };
}
function runBudgetStress() {
    let correctReservations = 0;
    let correctRefusals = 0;
    let overdraftOrDoubleSpend = 0;
    const cases = [];
    for(let index = 0; index < 50; index += 1){
        resetRuntimeState();
        const token = `budget-${index}`;
        seedBudgetToken(token, 5000);
        const firstInput = rawJson(makeBaseInput({
            execution_request: {
                request_id: `budget-allow-${index}`,
                release_request: {
                    execution_id: `budget-exec-a-${index}`,
                    hold_state: "APPROVED",
                    already_consumed: false
                },
                budget_token: token
            }
        }));
        const secondInput = rawJson(makeBaseInput({
            execution_request: {
                request_id: `budget-refuse-${index}`,
                release_request: {
                    execution_id: `budget-exec-b-${index}`,
                    hold_state: "APPROVED",
                    already_consumed: false
                },
                budget_token: token
            }
        }));
        const first = executeDeterministicPipeline(firstInput);
        const second = executeDeterministicPipeline(secondInput);
        const firstOutcome = "parse_boundary" in first ? first.reason_code : first.receipt.decision_output.reason_code;
        const secondOutcome = "parse_boundary" in second ? second.reason_code : second.receipt.decision_output.reason_code;
        const firstDecision = "parse_boundary" in first ? first.decision : first.receipt.decision_output.decision;
        const secondDecision = "parse_boundary" in second ? second.decision : second.receipt.decision_output.decision;
        if (firstDecision === "ALLOW") {
            correctReservations += 1;
        }
        if (secondDecision === "REFUSE" && secondOutcome === "ERR_BUDGET_TOKEN_EXHAUSTED") {
            correctRefusals += 1;
        }
        if (secondDecision === "ALLOW") {
            overdraftOrDoubleSpend += 1;
        }
        cases.push({
            token,
            firstDecision,
            firstOutcome,
            secondDecision,
            secondOutcome
        });
    }
    return {
        correct_reservations: correctReservations,
        correct_refusals: correctRefusals,
        overdraft_or_double_spend: overdraftOrDoubleSpend,
        samples: cases.slice(0, 10)
    };
}
function runCrossLayerRegressionChecks() {
    const remediation = buildRemediationCases();
    const checks = {
        preflight: true,
        orbit: true,
        arm: true,
        ramona: true
    };
    for (const caseDef of remediation){
        if (caseDef.test_id === "TC-068" || caseDef.test_id === "TC-069" || caseDef.test_id === "TC-070" || caseDef.test_id === "TC-071" || caseDef.test_id === "TC-072") {
            const result = runCase(caseDef);
            checks.preflight &&= result.reason_code === caseDef.expected_reason_code;
        }
        if (caseDef.test_id === "TC-061" || caseDef.test_id === "TC-062" || caseDef.test_id === "TC-063" || caseDef.test_id === "TC-064") {
            const result = runCase(caseDef);
            checks.orbit &&= result.reason_code === caseDef.expected_reason_code;
        }
    }
    const concurrency = runConcurrencyStress();
    checks.arm &&= concurrency.duplicate_allows === 0;
    const receiptReplay = collectReceiptsFromThisRun();
    checks.ramona &&= receiptReplay.mismatches.length === 0;
    return checks;
}
function main() {
    ensureDir(OUTPUT_DIR);
    const legacySummary = readJson(join(process.cwd(), "audit-proof-bundle", "summary.json"));
    const legacyDeterminism = readJson(join(process.cwd(), "audit-proof-bundle", "determinism_proof.json"));
    const legacyReplay = readJson(join(process.cwd(), "audit-proof-bundle", "proof_bundle", "replay_results.json"));
    const legacyParity = readJson(join(process.cwd(), "audit-proof-bundle", "proof_bundle", "parity_report.json"));
    const attackWave = readJson(join(process.cwd(), "attack-wave-bundle", "attack_wave_results.json"));
    const remediationWave = readJson(join(process.cwd(), "remediation-wave-bundle", "remediation_wave_results.json"));
    const drift = runDriftChecks();
    const replay = collectReceiptsFromThisRun();
    const concurrency = runConcurrencyStress();
    const budget = runBudgetStress();
    const crossLayer = runCrossLayerRegressionChecks();
    const unexpectedAllowCount = attackWave.cases.filter((item)=>item.expected_outcome === "REFUSE" && item.actual_outcome === "ALLOW").length + remediationWave.cases.filter((item)=>item.expected_outcome === "REFUSE" && item.actual_outcome === "ALLOW").length;
    const doubleAllowCount = concurrency.duplicate_allows;
    const genericSchemaFallbackCount = attackWave.cases.filter((item)=>item.actual_reason_code === "ERR_SCHEMA_VALIDATION").length + remediationWave.cases.filter((item)=>item.actual_reason_code === "ERR_SCHEMA_VALIDATION").length;
    const regressionSummary = {
        semantic_intent_blocking: remediationWave.cases.filter((item)=>[
                "TC-061",
                "TC-062",
                "TC-063",
                "TC-064"
            ].includes(item.test_id)).every((item)=>item.status === "PASS"),
        execution_id_single_use: remediationWave.cases.filter((item)=>[
                "TC-065",
                "TC-066"
            ].includes(item.test_id)).every((item)=>item.status === "PASS"),
        budget_token_enforcement: remediationWave.cases.find((item)=>item.test_id === "TC-067")?.status === "PASS",
        policy_version_pinning: remediationWave.cases.find((item)=>item.test_id === "TC-068")?.status === "PASS",
        policy_trust_validation: remediationWave.cases.filter((item)=>[
                "TC-069",
                "TC-070"
            ].includes(item.test_id)).every((item)=>item.status === "PASS"),
        invalid_number_precision: remediationWave.cases.find((item)=>item.test_id === "TC-072")?.status === "PASS",
        duplicate_key_precedence: remediationWave.cases.find((item)=>item.test_id === "TC-071")?.status === "PASS"
    };
    const totalTestsRun = 5 + attackWave.summary.total_cases + remediationWave.summary.total_cases + drift.repeated_inputs + replay.total + 100 + 100 + 4;
    const totalFailed = (legacyDeterminism.mismatch_count > 0 ? 1 : 0) + (legacyReplay.drift_count > 0 ? 1 : 0) + (legacyParity.mismatch_count > 0 ? 1 : 0) + (legacySummary.rejection_accuracy !== 100 ? 1 : 0) + (legacySummary.determinism_mismatch_rate !== 0 ? 1 : 0) + attackWave.summary.fail_count + remediationWave.summary.fail_count + drift.drift_mismatch_count + replay.mismatches.length + concurrency.duplicate_allows + budget.overdraft_or_double_spend + Object.values(crossLayer).filter((value)=>!value).length;
    const totalPassed = totalTestsRun - totalFailed;
    const determinismSummary = {
        decision_hash_stability: drift.decision_hash_stability,
        reason_code_stability: drift.reason_code_stability,
        receipt_byte_stability: drift.receipt_byte_stability
    };
    const finalVerdict = drift.drift_mismatch_count > 0 || replay.mismatches.length > 0 ? "FAIL_DETERMINISM_GAP" : unexpectedAllowCount > 0 || doubleAllowCount > 0 ? "FAIL_AUTHORITY_GAP" : legacyParity.mismatch_count > 0 || attackWave.summary.fail_count > 0 ? "FAIL_REGRESSION_DETECTED" : "PASS_READY_FOR_PROOF_EXPANSION";
    const report = {
        executive_result: {
            total_tests_run: totalTestsRun,
            total_passed: totalPassed,
            total_failed: totalFailed,
            unexpected_allow_count: unexpectedAllowCount,
            double_allow_count: doubleAllowCount,
            generic_schema_fallback_count: genericSchemaFallbackCount,
            drift_mismatch_count: drift.drift_mismatch_count,
            replay_mismatch_count: replay.mismatches.length
        },
        regression_summary: regressionSummary,
        determinism_summary: determinismSummary,
        concurrency_summary: concurrency,
        budget_state_summary: budget,
        legacy_audit_summary: {
            determinism_mismatch_rate: legacySummary.determinism_mismatch_rate,
            replay_drift_rate: legacySummary.replay_drift_rate,
            parity_mismatch_rate: legacySummary.parity_mismatch_rate,
            rejection_accuracy: legacySummary.rejection_accuracy
        },
        cross_layer_regression_checks: crossLayer,
        final_verdict: finalVerdict,
        artifact_list: [
            join(process.cwd(), "audit-proof-bundle"),
            join(process.cwd(), "attack-wave-bundle", "attack_wave_results.json"),
            join(process.cwd(), "remediation-wave-bundle", "remediation_wave_results.json"),
            REPORT_PATH,
            RECEIPT_PATH
        ]
    };
    writeJsonArtifact(REPORT_PATH, report);
    writeFileSync(join(OUTPUT_DIR, "artifact_paths.txt"), `${report.artifact_list.join("\n")}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
main();
