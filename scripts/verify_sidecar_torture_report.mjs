import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SUMMARY_PATH = join(process.cwd(), "hostile-verifier-proof-bundle", "sidecar-torture-summary.json");
const REQUIRED = [
  "total_requests",
  "completed_requests",
  "completed_http_responses",
  "failed_requests",
  "http_2xx",
  "http_4xx",
  "http_5xx",
  "request_timeout_count",
  "connection_error_count",
  "connection_errors",
  "l0_total_sheds",
  "l0_503_sheds",
  "l0_destroy_sheds",
  "l0_preparse_destroy_sheds",
  "l0_malformed_destroy_sheds",
  "l0_timeout_destroy_sheds",
  "l0_overload_503_sheds",
  "accepted_requests",
  "l0_503_receipt_count",
  "server_p99_ms",
  "socket_transfer_overhead_p99_ms",
  "warmup_p99_ms",
  "warmup_server_p99_ms",
  "warmup_socket_transfer_overhead_p99_ms",
  "mixed_server_p99_ms",
  "mixed_socket_transfer_overhead_p99_ms",
  "spike_server_p99_ms",
  "spike_socket_transfer_overhead_p99_ms",
  "min_ms",
  "avg_ms",
  "p50_ms",
  "p90_ms",
  "p95_ms",
  "p99_ms",
  "p999_ms",
  "max_ms",
  "requests_per_second_avg",
  "requests_per_second_peak",
  "bytes_sent_total",
  "bytes_received_total",
  "total_allow",
  "total_refuse",
  "unexpected_allows",
  "unexpected_refuses",
  "unsigned_allows",
  "missing_decision_hash",
  "missing_request_hash",
  "missing_policy_hash",
  "missing_signature_or_proof",
  "receipt_response_count",
  "allow_fixed_unique_decision_hashes",
  "refuse_fixed_unique_decision_hashes",
  "drift_mismatches",
  "signer_timeouts",
  "signer_late_responses",
  "late_response_upgrades",
  "custody_refuses",
  "internal_signing_fallbacks",
  "persisted_receipts",
  "expected_persisted_receipts",
  "malformed_receipt_lines",
  "partial_receipt_lines",
  "receipt_count_mismatch",
  "append_only_violations",
  "replay_sample_size",
  "replay_mismatches",
  "signature_failures",
  "policy_hash_mismatches",
  "refused_by_admission_total",
  "refused_by_worker_pool_total",
  "refused_by_receipt_queue_total",
  "total_cost_usd",
  "allowed_cost_usd",
  "prevented_cost_usd",
  "prevented_cost_percent"
];

if (!existsSync(SUMMARY_PATH)) {
  throw new Error(`missing summary: ${SUMMARY_PATH}`);
}

const summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf8"));
const failures = [];
for (const key of REQUIRED) {
  if (!(key in summary)) {
    failures.push(`missing metric ${key}`);
  }
}

const checks = {
  "completed_http_responses + connection_errors = total_requests": summary.completed_http_responses + summary.connection_errors === summary.total_requests,
  "l0_503_sheds + l0_destroy_sheds = l0_total_sheds": summary.l0_503_sheds + summary.l0_destroy_sheds === summary.l0_total_sheds,
  "all L0 sheds classified": summary.l0_overload_503_sheds + summary.l0_preparse_destroy_sheds + summary.l0_malformed_destroy_sheds + summary.l0_timeout_destroy_sheds === summary.l0_total_sheds,
  "http_5xx are valid L0 503 sheds": summary.http_5xx === summary.l0_503_sheds && summary.l0_transport_shed_responses === summary.l0_503_sheds,
  "L0 503 sheds produce no receipts": summary.l0_503_receipt_count === 0,
  "request_timeout_count = 0": summary.request_timeout_count === 0,
  "unexpected_allows = 0": summary.unexpected_allows === 0,
  "unsigned_allows = 0": summary.unsigned_allows === 0,
  "internal_signing_fallbacks = 0": summary.internal_signing_fallbacks === 0,
  "late_response_upgrades = 0": summary.late_response_upgrades === 0,
  "drift_mismatches = 0": summary.drift_mismatches === 0,
  "replay_mismatches = 0": summary.replay_mismatches === 0,
  "signature_failures = 0": summary.signature_failures === 0,
  "policy_hash_mismatches = 0": summary.policy_hash_mismatches === 0,
  "malformed_receipt_lines = 0": summary.malformed_receipt_lines === 0,
  "partial_receipt_lines = 0": summary.partial_receipt_lines === 0,
  "receipt_count_mismatch = 0": summary.receipt_count_mismatch === 0,
  "persisted_receipts = accepted plus refused decisions": summary.persisted_receipts === summary.expected_persisted_receipts,
  "allow_fixed_unique_decision_hashes = 1": summary.allow_fixed_unique_decision_hashes === 1,
  "refuse_fixed_unique_decision_hashes = 1": summary.refuse_fixed_unique_decision_hashes === 1,
  "server p99 < 25ms": summary.server_p99_ms < 25,
  "accepted request p99 < 100ms": summary.accepted_request_p99_ms < 100,
  "socket overhead p99 materially lower than 635ms": summary.socket_transfer_overhead_p99_ms < 572,
  "destroy sheds reduced by at least 80%": summary.l0_destroy_sheds <= 95967,
  "mixed p99 reported": Number.isFinite(summary.mixed_p99_ms),
  "spike p99 reported": Number.isFinite(summary.spike_p99_ms),
  "overall p99 reported": Number.isFinite(summary.p99_ms)
};

for (const [label, ok] of Object.entries(checks)) {
  if (!ok) failures.push(`${label} (actual summary value failed)`);
}

const verdict = failures.length === 0 && summary.verdict === "PASS" ? "PASS" : "FAIL";
process.stdout.write("SIDECAR_TORTURE_BENCH_REPORT\n");
for (const key of [
  "verdict",
  "total_requests",
  "requests_per_second_avg",
  "requests_per_second_peak",
  "p95_ms",
  "p99_ms",
  "p999_ms",
  "http_5xx",
  "l0_503_sheds",
  "l0_destroy_sheds",
  "completed_http_responses",
  "connection_errors",
  "unexpected_allows",
  "unsigned_allows",
  "drift_mismatches",
  "replay_mismatches",
  "signature_failures",
  "late_response_upgrades",
  "persisted_receipts",
  "prevented_cost_usd",
  "prevented_cost_percent"
]) {
  process.stdout.write(`${key}: ${key === "verdict" ? verdict : summary[key]}\n`);
}
if (verdict === "FAIL") {
  for (const failure of failures) {
    process.stdout.write(`failed_criterion: ${failure}\n`);
  }
}
process.exitCode = verdict === "PASS" ? 0 : 1;
