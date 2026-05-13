import { join } from "path";
import { deriveKeyId, type CanonicalExecutionInput, type SignedReceipt } from "../shared/index.ts";
import { ensureDir, executeDeterministicPipeline, makeBaseInput, rawJson, resetRuntimeState, seedBudgetToken, simulateConcurrentDuplicate, verifySignedReceipt, writeJsonArtifact } from "./node_runtime.ts";
import type { JsonValue } from "../shared/json.ts";

type TestMode = "pipeline" | "double_run" | "receipt_verify";

type RemediationCase = {
  test_id: string;
  category: string;
  intent: string;
  mode: TestMode;
  raw_input?: string;
  build_receipt?: () => SignedReceipt;
  setup?: () => void;
  expected_outcome: "ALLOW" | "REFUSE";
  expected_reason_code: string;
};

type RemediationResult = {
  test_id: string;
  category: string;
  mode: TestMode;
  expected_outcome: "ALLOW" | "REFUSE";
  expected_reason_code: string;
  actual_outcome: "ALLOW" | "REFUSE";
  actual_reason_code: string;
  status: "PASS" | "FAIL";
};

const OUTPUT_DIR = join(process.cwd(), "remediation-wave-bundle");

function baseInput(overrides?: Partial<CanonicalExecutionInput>): CanonicalExecutionInput {
  return makeBaseInput(overrides);
}

function pipelineOutcome(rawInput: string) {
  const result = executeDeterministicPipeline(rawInput);
  if ("parse_boundary" in result) {
    return {
      decision: result.decision,
      reason_code: result.reason_code
    };
  }
  return {
    decision: result.receipt.decision_output.decision,
    reason_code: result.receipt.decision_output.reason_code
  };
}

function addExecutionRequestField(field: string, value: JsonValue) {
  const base = baseInput();
  return rawJson(
    {
      ...base,
      execution_request: {
        ...base.execution_request,
        [field]: value
      }
    } as unknown as JsonValue
  );
}

export function buildRemediationCases(): RemediationCase[] {
  return [
    {
      test_id: "TC-061",
      category: "Semantic intent attack",
      intent: "Allowed code_execution tool containing credential file read and exfil path",
      mode: "pipeline",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            parameters: {
              code: 'open("/etc/credentials").read()'
            }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
    },
    {
      test_id: "TC-062",
      category: "Semantic intent attack",
      intent: "Allowed web workflow targeting localhost admin endpoint",
      mode: "pipeline",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            parameters: {
              query: "http://127.0.0.1:2375/containers/json"
            }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
    },
    {
      test_id: "TC-063",
      category: "Semantic intent attack",
      intent: "Allowed query tool requesting credential material via export semantics",
      mode: "pipeline",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            parameters: {
              query: "EXPORT SELECT api_key FROM secrets"
            }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
    },
    {
      test_id: "TC-064",
      category: "Semantic intent attack",
      intent: "Agent plan contains recursive retry and uncontrolled fanout",
      mode: "pipeline",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            parameters: {
              plan: [{ step: "retry_until_success", limit: "none" }, { step: "spawn", count: 1000 }]
            }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
    },
    {
      test_id: "TC-065",
      category: "Replay or concurrency attack",
      intent: "Two concurrent requests share the same execution_id with identical canonical request",
      mode: "double_run",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "rep-065",
            release_request: { execution_id: "exec-shared-065", hold_state: "APPROVED", already_consumed: false }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_EXECUTION_ID_ALREADY_CONSUMED"
    },
    {
      test_id: "TC-066",
      category: "Replay or concurrency attack",
      intent: "Same canonical request replayed after successful signed receipt exists",
      mode: "double_run",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "rep-066",
            release_request: { execution_id: "exec-replay-066", hold_state: "APPROVED", already_consumed: false }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_EXECUTION_ID_REPLAYED"
    },
    {
      test_id: "TC-067",
      category: "Replay or concurrency attack",
      intent: "Two requests share one budget token and exceed cumulative budget",
      mode: "pipeline",
      raw_input: addExecutionRequestField("budget_token", "B-67"),
      setup: () => seedBudgetToken("B-67", 1000),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_BUDGET_TOKEN_EXHAUSTED"
    },
    {
      test_id: "TC-068",
      category: "Policy trust or version attack",
      intent: "Valid schema but mismatched pinned policy version",
      mode: "pipeline",
      raw_input: rawJson(
        baseInput({
          policy_document: {
            ...baseInput().policy_document,
            policy_version: "policy.v2"
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_POLICY_VERSION_MISMATCH"
    },
    {
      test_id: "TC-069",
      category: "Policy trust or version attack",
      intent: "Trust block key id does not match derived key id",
      mode: "pipeline",
      raw_input: rawJson(
        {
          ...baseInput(),
          policy_document: {
            ...baseInput().policy_document,
            trust: {
              key_id: "trusted-key",
              public_key: "abcd",
              signature: "deadbeef",
              key_version: "ed25519.v1"
            }
          }
        } as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_POLICY_KEY_ID_MISMATCH"
    },
    {
      test_id: "TC-070",
      category: "Policy trust or version attack",
      intent: "Signature verifies over different canonical payload than delivered policy",
      mode: "pipeline",
      raw_input: rawJson(
        {
          ...baseInput(),
          policy_document: {
            ...baseInput().policy_document,
            trust: {
              key_id: deriveKeyId("abcd"),
              public_key: "abcd",
              signature: "signature-for-other-payload",
              key_version: "ed25519.v1"
            },
            rules: {
              max_total_cost_cents: 999999,
              allow_auto_scale: true,
              max_gpu_count: 999,
              max_hours: 999,
              require_manual_approval_above_cents: 999999,
              max_retry_count: 999
            }
          }
        } as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_INVALID_POLICY_SIGNATURE"
    },
    {
      test_id: "TC-071",
      category: "Reason code precision attack",
      intent: "Duplicate key plus unknown field must primary-fail as duplicate key",
      mode: "pipeline",
      raw_input:
        '{"execution_request":{"request_id":"prec-071","request_id":"prec-071-b","submitted_region":"us-west-2","actor":{"user_id":"user-001"},"resources":{"gpu_type":"a10g","gpu_count":2,"hours":4},"execution":{"auto_scale":false,"max_scale_multiplier":1,"retry_on_fail":false,"max_retries":0},"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}],"orbit_intent":{"orbit_version":"2.0","action":"execute","boundary":"gpu-batch","payload":{"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}]},"lifecycle_state":"ARMED","signatures":[{"alg":"hmac-sha256","sig":"orbit-signature-v1"}]},"release_request":{"execution_id":"exec-071","hold_state":"APPROVED","already_consumed":false},"runtime_observation":{"kill_switch_active":false,"actual_gpu_count":2,"actual_hours":4,"actual_total_cost_cents":4000},"rogue_field":true},"policy_document":{"schema_version":"ecs.policy.v1","policy_version":"policy.v1","rules":{"max_total_cost_cents":500000,"allow_auto_scale":true,"max_gpu_count":32,"max_hours":72,"require_manual_approval_above_cents":250000,"max_retry_count":5}},"pricing_data":{"gpu_hour_cents":500}}',
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_DUPLICATE_JSON_KEYS"
    },
    {
      test_id: "TC-072",
      category: "Reason code precision attack",
      intent: "Negative zero plus negative retry must primary-fail as invalid number",
      mode: "pipeline",
      raw_input:
        '{"execution_request":{"request_id":"prec-072","submitted_region":"us-west-2","actor":{"user_id":"user-001"},"resources":{"gpu_type":"a10g","gpu_count":2,"hours":4},"execution":{"auto_scale":false,"max_scale_multiplier":1,"retry_on_fail":false,"max_retries":-1},"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}],"orbit_intent":{"orbit_version":"2.0","action":"execute","boundary":"gpu-batch","payload":{"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}]},"lifecycle_state":"ARMED","signatures":[{"alg":"hmac-sha256","sig":"orbit-signature-v1"}]},"release_request":{"execution_id":"exec-072","hold_state":"APPROVED","already_consumed":false},"runtime_observation":{"kill_switch_active":false,"actual_gpu_count":2,"actual_hours":4,"actual_total_cost_cents":4000}},"policy_document":{"schema_version":"ecs.policy.v1","policy_version":"policy.v1","rules":{"max_total_cost_cents":500000,"allow_auto_scale":true,"max_gpu_count":32,"max_hours":72,"require_manual_approval_above_cents":250000,"max_retry_count":5}},"pricing_data":{"gpu_hour_cents":-0}}',
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_INVALID_JSON_NUMBER"
    }
  ];
}

function executeCase(testCase: RemediationCase): RemediationResult {
  resetRuntimeState();
  testCase.setup?.();
  if (testCase.mode === "pipeline") {
    const outcome = pipelineOutcome(testCase.raw_input ?? "");
    return {
      test_id: testCase.test_id,
      category: testCase.category,
      mode: testCase.mode,
      expected_outcome: testCase.expected_outcome,
      expected_reason_code: testCase.expected_reason_code,
      actual_outcome: outcome.decision,
      actual_reason_code: outcome.reason_code,
      status: outcome.decision === testCase.expected_outcome && outcome.reason_code === testCase.expected_reason_code ? "PASS" : "FAIL"
    };
  }

  if (testCase.mode === "double_run") {
    if (testCase.test_id === "TC-065") {
      const concurrent = simulateConcurrentDuplicate(testCase.raw_input ?? "");
      const actualOutcome = concurrent.first.decision === "ALLOW" && concurrent.second.decision === "REFUSE" ? "REFUSE" : "ALLOW";
      return {
        test_id: testCase.test_id,
        category: testCase.category,
        mode: testCase.mode,
        expected_outcome: testCase.expected_outcome,
        expected_reason_code: testCase.expected_reason_code,
        actual_outcome: actualOutcome,
        actual_reason_code: concurrent.second.reason_code,
        status:
          actualOutcome === testCase.expected_outcome &&
          concurrent.second.reason_code === testCase.expected_reason_code
            ? "PASS"
            : "FAIL"
      };
    }
    const first = pipelineOutcome(testCase.raw_input ?? "");
    const second = pipelineOutcome(testCase.raw_input ?? "");
    const actualOutcome = first.decision === "ALLOW" && second.decision === "ALLOW" ? "ALLOW" : "REFUSE";
    const actualReason = first.decision === "ALLOW" && second.decision === "ALLOW" ? "DOUBLE_ALLOW" : second.reason_code;
    return {
      test_id: testCase.test_id,
      category: testCase.category,
      mode: testCase.mode,
      expected_outcome: testCase.expected_outcome,
      expected_reason_code: testCase.expected_reason_code,
      actual_outcome: actualOutcome,
      actual_reason_code: actualReason,
      status: actualOutcome === testCase.expected_outcome && actualReason === testCase.expected_reason_code ? "PASS" : "FAIL"
    };
  }

  const receipt = testCase.build_receipt?.();
  const signatureValid = receipt ? verifySignedReceipt(receipt) : false;
  return {
    test_id: testCase.test_id,
    category: testCase.category,
    mode: testCase.mode,
    expected_outcome: testCase.expected_outcome,
    expected_reason_code: testCase.expected_reason_code,
    actual_outcome: signatureValid ? "ALLOW" : "REFUSE",
    actual_reason_code: signatureValid ? "RECEIPT_SIGNATURE_VALID" : "RECEIPT_SIGNATURE_INVALID",
    status: !signatureValid ? "PASS" : "FAIL"
  };
}

function main() {
  ensureDir(OUTPUT_DIR);
  const cases = buildRemediationCases();
  const results = cases.map(executeCase);
  const summary = {
    schema_version: "ecs.audit.remediation_wave_report.v1",
    total_cases: results.length,
    pass_count: results.filter((item) => item.status === "PASS").length,
    fail_count: results.filter((item) => item.status === "FAIL").length,
    failures: results.filter((item) => item.status === "FAIL")
  };

  writeJsonArtifact(
    join(OUTPUT_DIR, "remediation_wave_results.json"),
    {
      summary,
      cases: results
    } as unknown as JsonValue
  );

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href === import.meta.url) {
  main();
}
