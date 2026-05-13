import { readFileSync } from "fs";
import { join } from "path";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const attackWave = readJson(join(process.cwd(), "attack-wave-bundle", "attack_wave_results.json"));
  const parityReport = readJson(join(process.cwd(), "audit-proof-bundle", "proof_bundle", "parity_report.json"));

  const unexpectedAllowCase = attackWave.cases.find((item: any) => item.test_id === "TC-042");
  assert(unexpectedAllowCase?.status === "PASS", "test_unexpected_allow_regression failed");
  assert(unexpectedAllowCase?.actual_reason_code === "ERR_FORBIDDEN_ACTION_IN_PARAMETERS", "TC-042 reason code regressed");

  const typedFailureCase = attackWave.cases.find((item: any) => item.test_id === "TC-058");
  assert(typedFailureCase?.status === "PASS", "test_no_schema_fallback_for_typed_failure failed");
  assert(typedFailureCase?.actual_reason_code === "ERR_BUDGET_TOKEN_EXHAUSTED", "TC-058 typed failure regressed");

  assert(parityReport.mismatch_count === 0, "test_cross_runtime_parity_core_cases failed");

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        tests: [
          "test_unexpected_allow_regression",
          "test_no_schema_fallback_for_typed_failure",
          "test_cross_runtime_parity_core_cases"
        ]
      },
      null,
      2
    )}\n`
  );
}

main();
