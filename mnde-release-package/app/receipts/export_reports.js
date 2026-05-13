import { canonicalHash } from "./format.js";

export function buildSummaryReport(items) {
    const base = {
        schema_version: "mnde.audit_export_summary.v1",
        total_receipts: items.length,
        verified: items.filter((item) => item.verified).length,
        replay_pass: items.filter((item) => item.replay_pass).length,
        drift: items.filter((item) => !item.replay_pass).length,
        proof_resolved: items.filter((item) => item.proof.status === "RESOLVED").length
    };
    return { ...base, report_hash: canonicalHash(base) };
}

export function buildDeterminismReport({ verifyStable, replayStable, proofStable }) {
    const base = {
        schema_version: "mnde.audit_export_determinism.v1",
        verify_runs: 1000,
        replay_runs: 1000,
        proof_runs: 1000,
        stable: verifyStable && replayStable && proofStable
    };
    return { ...base, report_hash: canonicalHash(base) };
}

export function buildAdversarialReport(cases) {
    const base = {
        schema_version: "mnde.audit_export_adversarial.v1",
        cases_run: cases.length,
        failures: cases.filter((item) => item.passed !== true).length,
        cases: cases.sort((a, b) => a.case_id.localeCompare(b.case_id))
    };
    return { ...base, report_hash: canonicalHash(base) };
}
