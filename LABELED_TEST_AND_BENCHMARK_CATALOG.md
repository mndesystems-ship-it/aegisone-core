# Labeled Test And Benchmark Catalog

## 1. Audit-Grade Core Claims

- stable manifest SHA-256: `6f62088b0e60f32574e6556a85553e194dc92f2773efd211e61f3cdb0cc1e8c9`
- stable receipts SHA-256: `f134996223a184864622da8a3d44d774dfe35beaed0cfb9ae3580cb4ccce28f8`
- zero drift over `1,011,280` audit executions
- zero replay mismatches
- zero cross-runtime mismatches

## 2. Stable Reproducibility Scope

- scope: `stable-proof-bundle`
- claim: deterministic decision layer produces byte-identical receipts and manifests across independent reruns
- excluded from reproducibility scope: `volatile-benchmark-bundle`

## 3. Audit Summary Numbers

| label | value |
| --- | --- |
| schema_version | `ecs.audit.summary.v2` |
| generated_at | `2026-04-16T05:53:24.107Z` |
| total_runs | `1,011,280` |
| determinism_mismatch_rate | `0` |
| parity_mismatch_rate | `0` |
| replay_drift_rate | `0` |
| rejection_accuracy | `100` |

## 4. Audit Throughput By Profile

| profile | throughput_rps |
| --- | ---: |
| allow_burst | 5946.162258 |
| refuse_burst | 6003.445978 |
| mixed_50_50 | 6266.791083 |
| adversarial_malformed | 10557.867142 |
| replay_storm | 5232.380482 |

## 5. Audit Latency By Profile

| profile | p50_ms | p95_ms | p99_ms |
| --- | ---: | ---: | ---: |
| allow_burst | 0.1475 | 0.3136 | 0.6563 |
| refuse_burst | 0.1464 | 0.3052 | 0.6585 |
| mixed_50_50 | 0.1394 | 0.2875 | 0.4805 |
| adversarial_malformed | 0.0818 | 0.2504 | 0.4379 |
| replay_storm | 0.1605 | 0.3970 | 0.6589 |

## 6. Attack Wave Summary

| label | value |
| --- | --- |
| schema_version | `ecs.audit.attack_wave_report.v1` |
| total_cases | `20` |
| pass_count | `20` |
| fail_count | `0` |

## 7. Attack Wave Cases

| test_id | category | mode | expected_outcome | expected_reason_code | actual_outcome | actual_reason_code | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TC-041 | Multi vector attack | pipeline | REFUSE | ERR_NON_DETERMINISTIC_INPUT | REFUSE | ERR_NON_DETERMINISTIC_INPUT | PASS |
| TC-042 | Multi vector attack | pipeline | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | PASS |
| TC-043 | Multi vector attack | pipeline | REFUSE | ERR_INTEGER_OVERFLOW | REFUSE | ERR_INTEGER_OVERFLOW | PASS |
| TC-044 | Multi vector attack | pipeline | REFUSE | ERR_POLICY_VERSION_MISMATCH | REFUSE | ERR_POLICY_VERSION_MISMATCH | PASS |
| TC-045 | Multi vector attack | pipeline | REFUSE | ERR_NON_DETERMINISTIC_INPUT | REFUSE | ERR_NON_DETERMINISTIC_INPUT | PASS |
| TC-046 | Numeric edge case | pipeline | REFUSE | ERR_INVALID_JSON_NUMBER | REFUSE | ERR_INVALID_JSON_NUMBER | PASS |
| TC-047 | Numeric edge case | pipeline | REFUSE | ERR_INVALID_JSON_NUMBER | REFUSE | ERR_INVALID_JSON_NUMBER | PASS |
| TC-048 | Numeric edge case | pipeline | REFUSE | ERR_TYPE_MISMATCH | REFUSE | ERR_TYPE_MISMATCH | PASS |
| TC-049 | Numeric edge case | pipeline | REFUSE | ERR_INVALID_JSON_NUMBER | REFUSE | ERR_INVALID_JSON_NUMBER | PASS |
| TC-050 | Numeric edge case | pipeline | REFUSE | ERR_INVALID_JSON_NUMBER | REFUSE | ERR_INVALID_JSON_NUMBER | PASS |
| TC-051 | Cross layer semantic attack | pipeline | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | PASS |
| TC-052 | Cross layer semantic attack | pipeline | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | PASS |
| TC-053 | Cross layer semantic attack | pipeline | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | PASS |
| TC-054 | Cross layer semantic attack | pipeline | REFUSE | ERR_TOOL_CALL_SEQUENCE | REFUSE | ERR_TOOL_CALL_SEQUENCE | PASS |
| TC-055 | Cross layer semantic attack | pipeline | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | PASS |
| TC-056 | Replay or concurrency attack | double_run | REFUSE | ERR_EXECUTION_ID_ALREADY_CONSUMED | REFUSE | ERR_EXECUTION_ID_ALREADY_CONSUMED | PASS |
| TC-057 | Replay or concurrency attack | double_run | REFUSE | ERR_EXECUTION_ID_REPLAYED | REFUSE | ERR_EXECUTION_ID_REPLAYED | PASS |
| TC-058 | Replay or concurrency attack | pipeline | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED | PASS |
| TC-059 | Replay or concurrency attack | pipeline | REFUSE | ERR_POLICY_VERSION_MISMATCH | REFUSE | ERR_POLICY_VERSION_MISMATCH | PASS |
| TC-060 | Replay or concurrency attack | receipt_verify | REFUSE | ERR_RECEIPT_SIGNATURE_INVALID | REFUSE | RECEIPT_SIGNATURE_INVALID | PASS |

## 8. Remediation Wave Summary

| label | value |
| --- | --- |
| schema_version | `ecs.audit.remediation_wave_report.v1` |
| total_cases | `12` |
| pass_count | `12` |
| fail_count | `0` |

## 9. Remediation Wave Cases

| test_id | category | mode | expected_outcome | expected_reason_code | actual_outcome | actual_reason_code | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TC-061 | Semantic intent attack | pipeline | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | PASS |
| TC-062 | Semantic intent attack | pipeline | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | PASS |
| TC-063 | Semantic intent attack | pipeline | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | PASS |
| TC-064 | Semantic intent attack | pipeline | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | REFUSE | ERR_FORBIDDEN_ACTION_IN_PARAMETERS | PASS |
| TC-065 | Replay or concurrency attack | double_run | REFUSE | ERR_EXECUTION_ID_ALREADY_CONSUMED | REFUSE | ERR_EXECUTION_ID_ALREADY_CONSUMED | PASS |
| TC-066 | Replay or concurrency attack | double_run | REFUSE | ERR_EXECUTION_ID_REPLAYED | REFUSE | ERR_EXECUTION_ID_REPLAYED | PASS |
| TC-067 | Replay or concurrency attack | pipeline | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED | PASS |
| TC-068 | Policy trust or version attack | pipeline | REFUSE | ERR_POLICY_VERSION_MISMATCH | REFUSE | ERR_POLICY_VERSION_MISMATCH | PASS |
| TC-069 | Policy trust or version attack | pipeline | REFUSE | ERR_POLICY_KEY_ID_MISMATCH | REFUSE | ERR_POLICY_KEY_ID_MISMATCH | PASS |
| TC-070 | Policy trust or version attack | pipeline | REFUSE | ERR_INVALID_POLICY_SIGNATURE | REFUSE | ERR_INVALID_POLICY_SIGNATURE | PASS |
| TC-071 | Reason code precision attack | pipeline | REFUSE | ERR_DUPLICATE_JSON_KEYS | REFUSE | ERR_DUPLICATE_JSON_KEYS | PASS |
| TC-072 | Reason code precision attack | pipeline | REFUSE | ERR_INVALID_JSON_NUMBER | REFUSE | ERR_INVALID_JSON_NUMBER | PASS |

## 10. Post-Remediation Verification Executive Numbers

| label | value |
| --- | --- |
| total_tests_run | `546` |
| total_passed | `546` |
| total_failed | `0` |
| unexpected_allow_count | `0` |
| double_allow_count | `0` |
| generic_schema_fallback_count | `0` |
| drift_mismatch_count | `0` |
| replay_mismatch_count | `0` |
| final_verdict | `PASS_READY_FOR_PROOF_EXPANSION` |

## 11. Post-Remediation Verification Regression Flags

| check | value |
| --- | --- |
| semantic_intent_blocking | `true` |
| execution_id_single_use | `true` |
| budget_token_enforcement | `true` |
| policy_version_pinning | `true` |
| policy_trust_validation | `true` |
| invalid_number_precision | `true` |
| duplicate_key_precedence | `true` |
| decision_hash_stability | `true` |
| reason_code_stability | `true` |
| receipt_byte_stability | `true` |
| preflight | `true` |
| orbit | `true` |
| arm | `true` |
| ramona | `true` |

## 12. Concurrency Summary

| label | value |
| --- | --- |
| winner_count | `100` |
| loser_count | `100` |
| duplicate_allows | `0` |
| refusal_code_distribution.ERR_EXECUTION_ID_ALREADY_CONSUMED | `100` |

## 13. Budget State Summary

| label | value |
| --- | --- |
| correct_reservations | `50` |
| correct_refusals | `50` |
| overdraft_or_double_spend | `0` |

### Budget Samples

| token | firstDecision | firstOutcome | secondDecision | secondOutcome |
| --- | --- | --- | --- | --- |
| budget-0 | ALLOW | OK_ALLOW | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED |
| budget-1 | ALLOW | OK_ALLOW | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED |
| budget-2 | ALLOW | OK_ALLOW | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED |
| budget-3 | ALLOW | OK_ALLOW | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED |
| budget-4 | ALLOW | OK_ALLOW | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED |
| budget-5 | ALLOW | OK_ALLOW | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED |
| budget-6 | ALLOW | OK_ALLOW | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED |
| budget-7 | ALLOW | OK_ALLOW | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED |
| budget-8 | ALLOW | OK_ALLOW | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED |
| budget-9 | ALLOW | OK_ALLOW | REFUSE | ERR_BUDGET_TOKEN_EXHAUSTED |

## 14. Legacy Audit Summary Imported Into Verification

| label | value |
| --- | --- |
| determinism_mismatch_rate | `0` |
| replay_drift_rate | `0` |
| parity_mismatch_rate | `0` |
| rejection_accuracy | `100` |

## 15. Controlled Benchmark Summary

| label | value |
| --- | --- |
| benchmark_version | `mnde.controlled_benchmark.v2` |
| bundle | `mnde-controlled-benchmark-bundle` |
| reproducibility.identical_inputs_tested | `100000` |
| reproducibility.replayed_decisions | `200000` |
| reproducibility.zero_drift | `true` |
| reproducibility.zero_replay_mismatch | `true` |
| cost_control.without_mnde_micro_usd | `8905519092207` |
| cost_control.with_mnde_micro_usd | `180601897452` |
| cost_control.cost_reduction_percent | `98` |
| cost_control.runaway_prevented_percent | `100` |
| agent_control.without_mnde_micro_usd | `137079282240` |
| agent_control.with_mnde_micro_usd | `19020952015` |
| agent_control.unsafe_actions_blocked_percent | `100` |
| agent_control.loop_termination_rate | `100` |
| agent_control.decision_accuracy | `100` |
| agent_control.measured_p99_latency_ns | `13600` |
| success_criteria.cost_reduction_gt_80_percent | `true` |
| success_criteria.runaway_events_prevented_near_100_percent | `true` |
| success_criteria.unsafe_actions_blocked_near_100_percent | `true` |
| success_criteria.real_latency_p99_under_1ms_measured | `true` |
| success_criteria.zero_drift | `true` |
| success_criteria.zero_replay_mismatch | `true` |

## 16. Controlled Benchmark Anchor Reference

| label | value |
| --- | --- |
| name | `mixed_50_50_allow_refuse` |
| execution_count | `500000` |
| warmup_discarded | `25000` |
| warmup_hold_seconds | `60` |
| warmup_iterations | `10809266` |
| throughput_rps | `174378` |
| latency_ns.sample_size | `500000` |
| latency_ns.p50 | `4200` |
| latency_ns.p95 | `8300` |
| latency_ns.p99 | `13800` |
| latency_ns.min | `3000` |
| latency_ns.max | `6478200` |
| latency_ns.average | `5348` |

## 17. Benchmark Workload And Measurement Policy

| label | value |
| --- | --- |
| workload_hash | `af2d45b747cfee085681b966dc05723ca3f3447f02f9ae65c663e3c19b811199` |
| anchor_test.workload_hash | `1f0a84e497756186718948c735580b2a2730c312bc03270a17c71b3c6b74cb7c` |
| anchor_test.concurrency | `1` |
| anchor_test.duration_mode | `fixed_execution_count` |
| anchor_test.execution_count | `500` |
| measurement_policy.monotonic_clock | `process.hrtime.bigint` |
| measurement_policy.reported_runs | `3` |
| measurement_policy.tolerance_percent | `3` |
| measurement_policy.warmup_seconds | `60` |

## 18. Volatile Benchmark Validation Numbers

| label | value |
| --- | --- |
| scope | `volatile-benchmark-bundle` |
| tolerance_percent.throughput_delta_max | `3` |
| tolerance_percent.latency_p99_delta_max | `3` |
| metrics.controlled_benchmark_p99_ns | `13600` |

### Volatile Throughput Metrics

| profile | throughput_rps |
| --- | ---: |
| allow_burst | 5946.162258 |
| refuse_burst | 6003.445978 |
| mixed_50_50 | 6266.791083 |
| adversarial_malformed | 10557.867142 |
| replay_storm | 5232.380482 |

### Volatile p99 Metrics

| profile | p99_ms |
| --- | ---: |
| allow_burst | 0.6563 |
| refuse_burst | 0.6585 |
| mixed_50_50 | 0.4805 |
| adversarial_malformed | 0.4379 |
| replay_storm | 0.6589 |

## 19. Locked Machine-State Triplicate Benchmark Result

| label | value |
| --- | --- |
| benchmark_environment.monotonic_clock | `process.hrtime.bigint` |
| benchmark_environment.warmup_window_seconds | `60` |
| benchmark_environment.anchor_sample_target | `500000` |
| benchmark_environment.cost_latency_samples | `200000` |
| benchmark_environment.agent_latency_samples | `100000` |
| benchmark_environment.tolerance_percent | `3` |
| benchmark_environment.pass_definition | `within band across 3 consecutive runs` |
| same_workload_across_runs | `true` |
| same_anchor_across_runs | `true` |
| within_band | `false` |
| throughput.median_rps | `174378` |
| throughput.spread_percent | `4.34057` |
| p99_latency.median_ns | `15700` |
| p99_latency.spread_percent | `12.101911` |
| combined_decision_layer_p99.median_ns | `13600` |
| combined_decision_layer_p99.spread_percent | `5.147059` |

### Triplicate Run Details

| run | workload_hash | anchor_hash | anchor_throughput_rps | anchor_p99_ns | combined_p99_ns |
| --- | --- | --- | ---: | ---: | ---: |
| 1 | af2d45b747cfee085681b966dc05723ca3f3447f02f9ae65c663e3c19b811199 | 1f0a84e497756186718948c735580b2a2730c312bc03270a17c71b3c6b74cb7c | 166809 | 15700 | 12900 |
| 2 | af2d45b747cfee085681b966dc05723ca3f3447f02f9ae65c663e3c19b811199 | 1f0a84e497756186718948c735580b2a2730c312bc03270a17c71b3c6b74cb7c | 171534 | 14000 | 13200 |
| 3 | af2d45b747cfee085681b966dc05723ca3f3447f02f9ae65c663e3c19b811199 | 1f0a84e497756186718948c735580b2a2730c312bc03270a17c71b3c6b74cb7c | 174378 | 13800 | 13600 |

## 20. Failure Proof Catalog

| test_name | input | refusal_code | reason |
| --- | --- | --- | --- |
| replay_consistency | audit-proof-bundle/proof_bundle/failure_corrupted_entry.jsonl | ERR_REPLAY_MISMATCH | Corrupted receipt entry fails exact replay equivalence and is recorded as a mismatch. |
| concurrency_storm | TC-056 duplicate execution_id under double_run | ERR_EXECUTION_ID_ALREADY_CONSUMED | The second concurrent claimant must lose and refuse once the shared execution_id is consumed. |
| malformed_input | TC-046 malformed numeric edge case | ERR_INVALID_JSON_NUMBER | Invalid numeric payloads fail at the parse boundary instead of being normalized. |
| policy_trust | TC-070 delivered policy differs from signed canonical payload | ERR_INVALID_POLICY_SIGNATURE | Policy trust verification must refuse when the signature covers different bytes than the delivered policy. |
| proof_bundle_check | audit-proof-bundle/proof_bundle/failure_partial_write.jsonl | ERR_RECEIPT_STREAM_TRUNCATED | Interrupted or partial receipt writes must fail closed during proof replay. |

## 21. Current Claim Posture

- Scoped claim: deterministic decision layer produces byte-identical receipts and manifests across independent reruns.
- Performance claim: performance characteristics are stable within defined tolerance bands under controlled conditions, with workload and environment hashes recorded.
- Performance posture: benchmark methodology is fixed and falsifiable; current environment does not yet satisfy the `3%` stability band.
- Current locked-run result: throughput spread `4.34057%`, anchor p99 spread `12.101911%`, combined decision-layer p99 spread `5.147059%`.
