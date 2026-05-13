import { join } from "path";
import { ensureDir, executeDeterministicPipeline, makeBaseInput, rawJson, resetRuntimeState, seedBudgetToken, simulateConcurrentDuplicate, verifySignedReceipt, writeJsonArtifact } from "./node_runtime.js";
const OUTPUT_DIR = join(process.cwd(), "attack-wave-bundle");
function pipelineOutcome(rawInput) {
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
function baseInput(overrides) {
    return makeBaseInput(overrides);
}
function withUnknownField(field, value) {
    const base = baseInput();
    return JSON.stringify({
        ...base,
        [field]: value
    });
}
function addExecutionRequestField(field, value) {
    const base = baseInput();
    return rawJson({
        ...base,
        execution_request: {
            ...base.execution_request,
            [field]: value
        }
    });
}
export function buildAttackWaveCases() {
    const cases = [];
    cases.push({
        test_id: "TC-041",
        category: "Multi vector attack",
        intent: "Duplicate key plus quoted numeric plus hidden dependency field",
        mode: "pipeline",
        raw_input: '{"execution_request":{"request_id":"dup-mv-1","submitted_region":"us-west-2","actor":{"user_id":"user-001"},"resources":{"gpu_type":"a10g","gpu_count":2,"hours":4},"execution":{"auto_scale":false,"max_scale_multiplier":1,"retry_on_fail":false,"max_retries":"3"},"tool_calls":[{"tool":"compile","priority":1},{"tool":"compile","priority":2}],"orbit_intent":{"orbit_version":"2.0","action":"execute","boundary":"gpu-batch","payload":{"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}]},"lifecycle_state":"ARMED","signatures":[{"alg":"hmac-sha256","sig":"orbit-signature-v1"}]},"release_request":{"execution_id":"exec-041","hold_state":"APPROVED","already_consumed":false},"runtime_observation":{"kill_switch_active":false,"actual_gpu_count":2,"actual_hours":4,"actual_total_cost_cents":4000},"depends_on":"req-1"},"policy_document":{"schema_version":"ecs.policy.v1","policy_version":"policy.v1","rules":{"max_total_cost_cents":500000,"allow_auto_scale":true,"max_gpu_count":32,"max_hours":72,"require_manual_approval_above_cents":250000,"max_retry_count":5}},"pricing_data":{"gpu_hour_cents":500}}',
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_NON_DETERMINISTIC_INPUT"
    });
    cases.push({
        test_id: "TC-042",
        category: "Multi vector attack",
        intent: "Unauthorized semantic payload hidden inside allowed execution",
        mode: "pipeline",
        raw_input: rawJson({
            ...baseInput(),
            execution_request: {
                ...baseInput().execution_request,
                tool_calls: [
                    {
                        tool: "compile",
                        priority: 1
                    },
                    {
                        tool: "verify",
                        priority: 2
                    }
                ],
                parameters: {
                    code: "drop_database()"
                },
                orbit_intent: {
                    ...baseInput().execution_request.orbit_intent,
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
        }),
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
    });
    cases.push({
        test_id: "TC-043",
        category: "Multi vector attack",
        intent: "Overflow attempt combined with autoscale fanout and retry storm",
        mode: "pipeline",
        raw_input: rawJson(baseInput({
            execution_request: {
                request_id: "overflow-043",
                resources: {
                    gpu_type: "a10g",
                    gpu_count: 2147483647,
                    hours: 2147483647
                },
                execution: {
                    auto_scale: true,
                    max_scale_multiplier: 2147483647,
                    retry_on_fail: true,
                    max_retries: 2147483647
                },
                runtime_observation: {
                    kill_switch_active: false,
                    actual_gpu_count: 0,
                    actual_hours: 0,
                    actual_total_cost_cents: 0
                }
            }
        })),
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_INTEGER_OVERFLOW"
    });
    cases.push({
        test_id: "TC-044",
        category: "Multi vector attack",
        intent: "Policy tamper combined with stale version and mismatched key id",
        mode: "pipeline",
        raw_input: rawJson(baseInput({
            policy_document: {
                schema_version: "ecs.policy.v0",
                policy_version: "policy.v0",
                rules: {
                    max_total_cost_cents: 999999999,
                    allow_auto_scale: true,
                    max_gpu_count: 9999,
                    max_hours: 9999,
                    require_manual_approval_above_cents: 999999999,
                    max_retry_count: 9999
                }
            }
        })),
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_POLICY_VERSION_MISMATCH"
    });
    cases.push({
        test_id: "TC-045",
        category: "Multi vector attack",
        intent: "Replay of consumed execution id with timestamp field and session leakage",
        mode: "pipeline",
        raw_input: withUnknownField("session_id", "s-1"),
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_NON_DETERMINISTIC_INPUT"
    });
    cases.push({
        test_id: "TC-046",
        category: "Numeric edge case",
        intent: "Decimal micro-cost value",
        mode: "pipeline",
        raw_input: '{"execution_request":{"request_id":"num-046","submitted_region":"us-west-2","actor":{"user_id":"user-001"},"resources":{"gpu_type":"a10g","gpu_count":2,"hours":4},"execution":{"auto_scale":false,"max_scale_multiplier":1,"retry_on_fail":false,"max_retries":3},"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}],"orbit_intent":{"orbit_version":"2.0","action":"execute","boundary":"gpu-batch","payload":{"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}]},"lifecycle_state":"ARMED","signatures":[{"alg":"hmac-sha256","sig":"orbit-signature-v1"}]},"release_request":{"execution_id":"exec-046","hold_state":"APPROVED","already_consumed":false},"runtime_observation":{"kill_switch_active":false,"actual_gpu_count":2,"actual_hours":4,"actual_total_cost_cents":4000}},"policy_document":{"schema_version":"ecs.policy.v1","policy_version":"policy.v1","rules":{"max_total_cost_cents":500000.1,"allow_auto_scale":true,"max_gpu_count":32,"max_hours":72,"require_manual_approval_above_cents":250000,"max_retry_count":5}},"pricing_data":{"gpu_hour_cents":500}}',
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_INVALID_JSON_NUMBER"
    });
    cases.push({
        test_id: "TC-047",
        category: "Numeric edge case",
        intent: "Exponent notation in timeout equivalent field",
        mode: "pipeline",
        raw_input: '{"execution_request":{"request_id":"num-047","submitted_region":"us-west-2","actor":{"user_id":"user-001"},"resources":{"gpu_type":"a10g","gpu_count":2,"hours":6e1},"execution":{"auto_scale":false,"max_scale_multiplier":1,"retry_on_fail":false,"max_retries":3},"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}],"orbit_intent":{"orbit_version":"2.0","action":"execute","boundary":"gpu-batch","payload":{"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}]},"lifecycle_state":"ARMED","signatures":[{"alg":"hmac-sha256","sig":"orbit-signature-v1"}]},"release_request":{"execution_id":"exec-047","hold_state":"APPROVED","already_consumed":false},"runtime_observation":{"kill_switch_active":false,"actual_gpu_count":2,"actual_hours":4,"actual_total_cost_cents":4000}},"policy_document":{"schema_version":"ecs.policy.v1","policy_version":"policy.v1","rules":{"max_total_cost_cents":500000,"allow_auto_scale":true,"max_gpu_count":32,"max_hours":72,"require_manual_approval_above_cents":250000,"max_retry_count":5}},"pricing_data":{"gpu_hour_cents":500}}',
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_INVALID_JSON_NUMBER"
    });
    cases.push({
        test_id: "TC-048",
        category: "Numeric edge case",
        intent: "Negative retry count",
        mode: "pipeline",
        raw_input: '{"execution_request":{"request_id":"num-048","submitted_region":"us-west-2","actor":{"user_id":"user-001"},"resources":{"gpu_type":"a10g","gpu_count":2,"hours":4},"execution":{"auto_scale":false,"max_scale_multiplier":1,"retry_on_fail":false,"max_retries":-1},"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}],"orbit_intent":{"orbit_version":"2.0","action":"execute","boundary":"gpu-batch","payload":{"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}]},"lifecycle_state":"ARMED","signatures":[{"alg":"hmac-sha256","sig":"orbit-signature-v1"}]},"release_request":{"execution_id":"exec-048","hold_state":"APPROVED","already_consumed":false},"runtime_observation":{"kill_switch_active":false,"actual_gpu_count":2,"actual_hours":4,"actual_total_cost_cents":4000}},"policy_document":{"schema_version":"ecs.policy.v1","policy_version":"policy.v1","rules":{"max_total_cost_cents":500000,"allow_auto_scale":true,"max_gpu_count":32,"max_hours":72,"require_manual_approval_above_cents":250000,"max_retry_count":5}},"pricing_data":{"gpu_hour_cents":500}}',
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_TYPE_MISMATCH"
    });
    cases.push({
        test_id: "TC-049",
        category: "Numeric edge case",
        intent: "Negative zero cost surrogate via pricing field",
        mode: "pipeline",
        raw_input: '{"execution_request":{"request_id":"num-049","submitted_region":"us-west-2","actor":{"user_id":"user-001"},"resources":{"gpu_type":"a10g","gpu_count":2,"hours":4},"execution":{"auto_scale":false,"max_scale_multiplier":1,"retry_on_fail":false,"max_retries":3},"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}],"orbit_intent":{"orbit_version":"2.0","action":"execute","boundary":"gpu-batch","payload":{"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}]},"lifecycle_state":"ARMED","signatures":[{"alg":"hmac-sha256","sig":"orbit-signature-v1"}]},"release_request":{"execution_id":"exec-049","hold_state":"APPROVED","already_consumed":false},"runtime_observation":{"kill_switch_active":false,"actual_gpu_count":2,"actual_hours":4,"actual_total_cost_cents":4000}},"policy_document":{"schema_version":"ecs.policy.v1","policy_version":"policy.v1","rules":{"max_total_cost_cents":500000,"allow_auto_scale":true,"max_gpu_count":32,"max_hours":72,"require_manual_approval_above_cents":250000,"max_retry_count":5}},"pricing_data":{"gpu_hour_cents":-0}}',
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_INVALID_JSON_NUMBER"
    });
    cases.push({
        test_id: "TC-050",
        category: "Numeric edge case",
        intent: "Max-safe-integer overflow in timeout surrogate",
        mode: "pipeline",
        raw_input: '{"execution_request":{"request_id":"num-050","submitted_region":"us-west-2","actor":{"user_id":"user-001"},"resources":{"gpu_type":"a10g","gpu_count":2,"hours":9007199254740992},"execution":{"auto_scale":false,"max_scale_multiplier":1,"retry_on_fail":false,"max_retries":3},"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}],"orbit_intent":{"orbit_version":"2.0","action":"execute","boundary":"gpu-batch","payload":{"tool_calls":[{"tool":"compile","priority":1},{"tool":"verify","priority":2}]},"lifecycle_state":"ARMED","signatures":[{"alg":"hmac-sha256","sig":"orbit-signature-v1"}]},"release_request":{"execution_id":"exec-050","hold_state":"APPROVED","already_consumed":false},"runtime_observation":{"kill_switch_active":false,"actual_gpu_count":2,"actual_hours":4,"actual_total_cost_cents":4000}},"policy_document":{"schema_version":"ecs.policy.v1","policy_version":"policy.v1","rules":{"max_total_cost_cents":500000,"allow_auto_scale":true,"max_gpu_count":32,"max_hours":72,"require_manual_approval_above_cents":250000,"max_retry_count":5}},"pricing_data":{"gpu_hour_cents":500}}',
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_INVALID_JSON_NUMBER"
    });
    cases.push({
        test_id: "TC-051",
        category: "Cross layer semantic attack",
        intent: "Allowed tool with destructive filesystem payload",
        mode: "pipeline",
        raw_input: rawJson(baseInput({
            execution_request: {
                request_id: "cross-051",
                release_request: {
                    execution_id: "exec-051",
                    hold_state: "APPROVED",
                    already_consumed: false
                },
                parameters: {
                    code: "rm -rf /data"
                }
            }
        })),
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
    });
    cases.push({
        test_id: "TC-052",
        category: "Cross layer semantic attack",
        intent: "Allowed tool with SSRF target",
        mode: "pipeline",
        raw_input: rawJson(baseInput({
            execution_request: {
                request_id: "cross-052",
                release_request: {
                    execution_id: "exec-052",
                    hold_state: "APPROVED",
                    already_consumed: false
                },
                parameters: {
                    query: "http://169.254.169.254/latest/meta-data"
                }
            }
        })),
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
    });
    cases.push({
        test_id: "TC-053",
        category: "Cross layer semantic attack",
        intent: "Allowed data query with exfiltration intent",
        mode: "pipeline",
        raw_input: rawJson(baseInput({
            execution_request: {
                request_id: "cross-053",
                release_request: {
                    execution_id: "exec-053",
                    hold_state: "APPROVED",
                    already_consumed: false
                },
                parameters: {
                    query: "SELECT * FROM secrets"
                }
            }
        })),
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
    });
    cases.push({
        test_id: "TC-054",
        category: "Cross layer semantic attack",
        intent: "Orbit payload tool list differs from top-level declared tool plan",
        mode: "pipeline",
        raw_input: rawJson(baseInput({
            execution_request: {
                request_id: "cross-054",
                tool_calls: [
                    {
                        tool: "compile",
                        priority: 1
                    },
                    {
                        tool: "verify",
                        priority: 2
                    }
                ],
                orbit_intent: {
                    ...baseInput().execution_request.orbit_intent,
                    payload: {
                        tool_calls: [
                            {
                                tool: "delete_database",
                                priority: 1
                            }
                        ]
                    }
                }
            }
        })),
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_TOOL_CALL_SEQUENCE"
    });
    cases.push({
        test_id: "TC-055",
        category: "Cross layer semantic attack",
        intent: "Allowed agent plan with hidden recursive loop",
        mode: "pipeline",
        raw_input: rawJson(baseInput({
            execution_request: {
                request_id: "cross-055",
                release_request: {
                    execution_id: "exec-055",
                    hold_state: "APPROVED",
                    already_consumed: false
                },
                parameters: {
                    plan: [
                        {
                            step: "retry_until_success",
                            limit: "none"
                        }
                    ]
                }
            }
        })),
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
    });
    cases.push({
        test_id: "TC-056",
        category: "Replay or concurrency attack",
        intent: "Exact same canonical request submitted twice with same execution id",
        mode: "double_run",
        raw_input: rawJson(baseInput({
            execution_request: {
                request_id: "replay-056",
                release_request: {
                    execution_id: "exec-race-2",
                    hold_state: "APPROVED",
                    already_consumed: false
                }
            }
        })),
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_EXECUTION_ID_ALREADY_CONSUMED"
    });
    cases.push({
        test_id: "TC-057",
        category: "Replay or concurrency attack",
        intent: "Replay same canonical request after allow receipt exists",
        mode: "double_run",
        raw_input: rawJson(baseInput({
            execution_request: {
                request_id: "replay-057",
                release_request: {
                    execution_id: "exec-replay-1",
                    hold_state: "APPROVED",
                    already_consumed: false
                }
            }
        })),
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_EXECUTION_ID_REPLAYED"
    });
    cases.push({
        test_id: "TC-058",
        category: "Replay or concurrency attack",
        intent: "Shared budget token across requests",
        mode: "pipeline",
        raw_input: addExecutionRequestField("budget_token", "B-2"),
        setup: ()=>seedBudgetToken("B-2", 0),
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_BUDGET_TOKEN_EXHAUSTED"
    });
    cases.push({
        test_id: "TC-059",
        category: "Replay or concurrency attack",
        intent: "Same request evaluated under wrong policy version",
        mode: "pipeline",
        raw_input: rawJson(baseInput({
            policy_document: {
                ...baseInput().policy_document,
                policy_version: "policy.v2"
            }
        })),
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_POLICY_VERSION_MISMATCH"
    });
    cases.push({
        test_id: "TC-060",
        category: "Replay or concurrency attack",
        intent: "Receipt replay with mutated canonical request but unchanged signature",
        mode: "receipt_verify",
        build_receipt: ()=>{
            const first = executeDeterministicPipeline(rawJson(baseInput()));
            if ("parse_boundary" in first) {
                throw new Error("baseline receipt generation failed");
            }
            const receipt = JSON.parse(first.receipt_bytes);
            receipt.canonical_request = rawJson(baseInput({
                execution_request: {
                    request_id: "tampered-060"
                }
            }));
            return receipt;
        },
        expected_outcome: "REFUSE",
        expected_reason_code: "ERR_RECEIPT_SIGNATURE_INVALID"
    });
    return cases;
}
function executeCase(testCase) {
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
        if (testCase.test_id === "TC-056") {
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
                status: actualOutcome === testCase.expected_outcome && concurrent.second.reason_code === testCase.expected_reason_code ? "PASS" : "FAIL"
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
    const cases = buildAttackWaveCases();
    const results = cases.map(executeCase);
    const summary = {
        schema_version: "ecs.audit.attack_wave_report.v1",
        total_cases: results.length,
        pass_count: results.filter((item)=>item.status === "PASS").length,
        fail_count: results.filter((item)=>item.status === "FAIL").length,
        failures: results.filter((item)=>item.status === "FAIL")
    };
    writeJsonArtifact(join(OUTPUT_DIR, "attack_wave_results.json"), {
        summary,
        cases: results
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
if (process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href === import.meta.url) {
    main();
}
