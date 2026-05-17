import { join } from "path";
import { deriveKeyId, type CanonicalExecutionInput, type JsonValue } from "../shared/index.ts";
import {
  executeDeterministicPipeline,
  resetRuntimeState,
  seedBudgetToken,
} from "./node_runtime.ts";
import {
  ensureDir,
  makeBaseInput,
  rawJson,
  simulateConcurrentDuplicate,
  writeJsonArtifact
} from "./test_helpers.ts";

type TestMode = "pipeline" | "sequence" | "concurrent";

type Step = {
  raw_input: string;
  expected_outcome: "ALLOW" | "REFUSE";
  expected_reason_code: string;
};

type ExpansionCase = {
  test_id: string;
  category:
    | "multi-request interaction"
    | "long-running execution drift"
    | "cross-policy transitions"
    | "adversarial cost shaping"
    | "layered semantic bypass attempts";
  intent: string;
  mode: TestMode;
  why_this_matters: string;
  raw_input?: string;
  steps?: Step[];
  setup?: () => void;
  expected_outcome: "ALLOW" | "REFUSE";
  expected_reason_code: string;
};

function baseInput(overrides?: Partial<CanonicalExecutionInput>): CanonicalExecutionInput {
  return makeBaseInput(overrides);
}

function outcomeFromRaw(rawInput: string) {
  const result = executeDeterministicPipeline(rawInput);
  return "parse_boundary" in result
    ? { decision: result.decision, reason_code: result.reason_code }
    : {
        decision: result.receipt.decision_output.decision,
        reason_code: result.receipt.decision_output.reason_code
      };
}

function sequenceCase(
  test_id: ExpansionCase["test_id"],
  category: ExpansionCase["category"],
  intent: string,
  why_this_matters: string,
  steps: Step[],
  setup?: () => void
): ExpansionCase {
  const last = steps.at(-1)!;
  return {
    test_id,
    category,
    intent,
    mode: "sequence",
    why_this_matters,
    steps,
    setup,
    expected_outcome: last.expected_outcome,
    expected_reason_code: last.expected_reason_code
  };
}

function buildCases(): ExpansionCase[] {
  return [
    sequenceCase(
      "PX-001",
      "multi-request interaction",
      "Semantic refusal must not consume budget for a later clean request sharing the same token",
      "Weak systems burn budget on refused pre-execution paths and then refuse clean follow-up work nondeterministically.",
      [
        {
          raw_input: rawJson(
            baseInput({
              execution_request: {
                request_id: "px-001-a",
                release_request: { execution_id: "px-001-a", hold_state: "APPROVED", already_consumed: false },
                budget_token: "PX-BUDGET-1",
                parameters: { code: "rm -rf /data" }
              }
            }) as unknown as JsonValue
          ),
          expected_outcome: "REFUSE",
          expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
        },
        {
          raw_input: rawJson(
            baseInput({
              execution_request: {
                request_id: "px-001-b",
                release_request: { execution_id: "px-001-b", hold_state: "APPROVED", already_consumed: false },
                budget_token: "PX-BUDGET-1"
              }
            }) as unknown as JsonValue
          ),
          expected_outcome: "ALLOW",
          expected_reason_code: "OK_ALLOW"
        }
      ],
      () => seedBudgetToken("PX-BUDGET-1", 4000)
    ),
    {
      test_id: "PX-002",
      category: "multi-request interaction",
      intent: "Concurrent same execution_id submissions must yield one winner and one deterministic loser",
      mode: "concurrent",
      why_this_matters: "This is the fastest path to duplicate execution authority under load.",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "px-002",
            release_request: { execution_id: "px-002-exec", hold_state: "APPROVED", already_consumed: false }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_EXECUTION_ID_ALREADY_CONSUMED"
    },
    sequenceCase(
      "PX-003",
      "multi-request interaction",
      "A previously allowed execution_id must refuse a later request even if the payload changes",
      "Weak systems key only on payload hash or only on execution_id and lose replay integrity.",
      [
        {
          raw_input: rawJson(
            baseInput({
              execution_request: {
                request_id: "px-003-a",
                release_request: { execution_id: "px-003-exec", hold_state: "APPROVED", already_consumed: false }
              }
            }) as unknown as JsonValue
          ),
          expected_outcome: "ALLOW",
          expected_reason_code: "OK_ALLOW"
        },
        {
          raw_input: rawJson(
            baseInput({
              execution_request: {
                request_id: "px-003-b",
                release_request: { execution_id: "px-003-exec", hold_state: "APPROVED", already_consumed: false },
                parameters: { query: "harmless-change" }
              }
            }) as unknown as JsonValue
          ),
          expected_outcome: "REFUSE",
          expected_reason_code: "ERR_EXECUTION_ID_REPLAYED"
        }
      ]
    ),
    sequenceCase(
      "PX-004",
      "multi-request interaction",
      "Shared budget token must allow within-budget use then refuse the overdraw attempt",
      "Double-spend against a shared budget object is a common cross-request authority failure.",
      [
        {
          raw_input: rawJson(
            baseInput({
              execution_request: {
                request_id: "px-004-a",
                release_request: { execution_id: "px-004-a", hold_state: "APPROVED", already_consumed: false },
                budget_token: "PX-BUDGET-4"
              }
            }) as unknown as JsonValue
          ),
          expected_outcome: "ALLOW",
          expected_reason_code: "OK_ALLOW"
        },
        {
          raw_input: rawJson(
            baseInput({
              execution_request: {
                request_id: "px-004-b",
                release_request: { execution_id: "px-004-b", hold_state: "APPROVED", already_consumed: false },
                budget_token: "PX-BUDGET-4"
              }
            }) as unknown as JsonValue
          ),
          expected_outcome: "REFUSE",
          expected_reason_code: "ERR_BUDGET_TOKEN_EXHAUSTED"
        }
      ],
      () => seedBudgetToken("PX-BUDGET-4", 4000)
    ),
    {
      test_id: "PX-005",
      category: "long-running execution drift",
      intent: "Runtime hours drift above approved hours must refuse at ramona",
      mode: "pipeline",
      why_this_matters: "Long-running tasks often drift in duration after an initially valid allow decision.",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "px-005",
            runtime_observation: { kill_switch_active: false, actual_gpu_count: 2, actual_hours: 5, actual_total_cost_cents: 4000 }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_RUNTIME_HOURS_DRIFT"
    },
    {
      test_id: "PX-006",
      category: "long-running execution drift",
      intent: "Runtime GPU drift above approved gpu_count must refuse at ramona",
      mode: "pipeline",
      why_this_matters: "Auto-attached GPUs after approval are a direct authority expansion.",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "px-006",
            runtime_observation: { kill_switch_active: false, actual_gpu_count: 3, actual_hours: 4, actual_total_cost_cents: 4000 }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_RUNTIME_GPU_DRIFT"
    },
    {
      test_id: "PX-007",
      category: "long-running execution drift",
      intent: "Runtime cost drift above projected total must refuse at ramona",
      mode: "pipeline",
      why_this_matters: "Weak systems often sign the allow but fail to bind observed spend to it.",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "px-007",
            runtime_observation: { kill_switch_active: false, actual_gpu_count: 2, actual_hours: 4, actual_total_cost_cents: 4500 }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_RUNTIME_COST_DRIFT"
    },
    {
      test_id: "PX-008",
      category: "long-running execution drift",
      intent: "Kill switch activation after allow path must refuse deterministically",
      mode: "pipeline",
      why_this_matters: "Emergency control must override otherwise valid plans without introducing drift.",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "px-008",
            runtime_observation: { kill_switch_active: true, actual_gpu_count: 2, actual_hours: 4, actual_total_cost_cents: 4000 }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_KILL_SWITCH"
    },
    {
      test_id: "PX-009",
      category: "cross-policy transitions",
      intent: "Pinned policy version mismatch must refuse before execution planning",
      mode: "pipeline",
      why_this_matters: "Policy churn is a classic route to replay disagreement and silent authority widening.",
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
      test_id: "PX-010",
      category: "cross-policy transitions",
      intent: "Trust key id mismatch must refuse under the pinned policy version",
      mode: "pipeline",
      why_this_matters: "A hostile actor can swap public keys while preserving policy shape.",
      raw_input: rawJson(
        {
          ...baseInput(),
          policy_document: {
            ...baseInput().policy_document,
            trust: {
              key_version: "ed25519.v1",
              key_id: "wrong-key",
              public_key: "abcd",
              signature: "deadbeef"
            }
          }
        } as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_POLICY_KEY_ID_MISMATCH"
    },
    {
      test_id: "PX-011",
      category: "cross-policy transitions",
      intent: "Policy signature mismatch must refuse when key id matches but payload signature does not",
      mode: "pipeline",
      why_this_matters: "This catches stale or tampered rules under a superficially valid trust block.",
      raw_input: rawJson(
        {
          ...baseInput(),
          policy_document: {
            ...baseInput().policy_document,
            trust: {
              key_version: "ed25519.v1",
              key_id: deriveKeyId("abcd"),
              public_key: "abcd",
              signature: "signature-for-other-payload"
            }
          }
        } as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_INVALID_POLICY_SIGNATURE"
    },
    sequenceCase(
      "PX-012",
      "cross-policy transitions",
      "A valid request under the pinned policy must not make a later wrong-version request acceptable",
      "Weak systems leak policy state across requests or cache the first allow too broadly.",
      [
        {
          raw_input: rawJson(
            baseInput({
              execution_request: {
                request_id: "px-012-a",
                release_request: { execution_id: "px-012-a", hold_state: "APPROVED", already_consumed: false }
              }
            }) as unknown as JsonValue
          ),
          expected_outcome: "ALLOW",
          expected_reason_code: "OK_ALLOW"
        },
        {
          raw_input: rawJson(
            baseInput({
              execution_request: {
                request_id: "px-012-b",
                release_request: { execution_id: "px-012-b", hold_state: "APPROVED", already_consumed: false }
              },
              policy_document: {
                ...baseInput().policy_document,
                policy_version: "policy.v2"
              }
            }) as unknown as JsonValue
          ),
          expected_outcome: "REFUSE",
          expected_reason_code: "ERR_POLICY_VERSION_MISMATCH"
        }
      ]
    ),
    {
      test_id: "PX-013",
      category: "adversarial cost shaping",
      intent: "Projected cost exactly at max_total_cost_cents must allow deterministically",
      mode: "pipeline",
      why_this_matters: "Boundary precision is where weak controllers leak or over-block spend.",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "px-013",
            resources: { gpu_type: "a10g", gpu_count: 20, hours: 10 },
            execution: { auto_scale: true, max_scale_multiplier: 5, retry_on_fail: false, max_retries: 0 },
            runtime_observation: { kill_switch_active: false, actual_gpu_count: 20, actual_hours: 10, actual_total_cost_cents: 500000 }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "ALLOW",
      expected_reason_code: "OK_ALLOW"
    },
    {
      test_id: "PX-014",
      category: "adversarial cost shaping",
      intent: "Projected cost just above max_total_cost_cents in the next integer step must refuse",
      mode: "pipeline",
      why_this_matters: "Attackers shape workloads to land just beyond enforcement thresholds.",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "px-014",
            resources: { gpu_type: "a10g", gpu_count: 7, hours: 11 },
            execution: { auto_scale: true, max_scale_multiplier: 13, retry_on_fail: false, max_retries: 0 }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_COST_LIMIT"
    },
    {
      test_id: "PX-015",
      category: "adversarial cost shaping",
      intent: "Manual approval threshold must refuse a shaped request that stays under the hard cost cap",
      mode: "pipeline",
      why_this_matters: "High-spend but under-cap requests are a common approval bypass target.",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "px-015",
            resources: { gpu_type: "a10g", gpu_count: 20, hours: 10 },
            execution: { auto_scale: true, max_scale_multiplier: 3, retry_on_fail: false, max_retries: 0 },
            release_request: { execution_id: "px-015", hold_state: "PENDING", already_consumed: false }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_MANUAL_APPROVAL_REQUIRED"
    },
    {
      test_id: "PX-016",
      category: "adversarial cost shaping",
      intent: "Overflow shaping through massive counts must fail closed before cost comparison",
      mode: "pipeline",
      why_this_matters: "Overflow is the cleanest way to turn catastrophic cost into a false allow.",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "px-016",
            resources: { gpu_type: "a10g", gpu_count: 2_147_483_647, hours: 2_147_483_647 },
            execution: { auto_scale: true, max_scale_multiplier: 2_147_483_647, retry_on_fail: true, max_retries: 2_147_483_647 }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_INTEGER_OVERFLOW"
    },
    {
      test_id: "PX-017",
      category: "layered semantic bypass attempts",
      intent: "Nested destructive code payload must still be blocked",
      mode: "pipeline",
      why_this_matters: "Weak semantic filters only inspect top-level fields.",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "px-017",
            parameters: {
              task: {
                script: "rm -rf /data"
              } as unknown as JsonValue
            }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
    },
    {
      test_id: "PX-018",
      category: "layered semantic bypass attempts",
      intent: "Internal network access hidden under an alternate URL field must still be blocked",
      mode: "pipeline",
      why_this_matters: "Real systems often pass URLs under multiple parameter names.",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "px-018",
            parameters: {
              url: "http://localhost:2375/containers/json"
            }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
    },
    {
      test_id: "PX-019",
      category: "layered semantic bypass attempts",
      intent: "Secret export markers nested in metadata must still be blocked",
      mode: "pipeline",
      why_this_matters: "Exfiltration intent is often wrapped in helper metadata rather than a direct query field.",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "px-019",
            parameters: {
              meta: {
                query: "EXPORT SELECT api_key FROM secrets"
              } as unknown as JsonValue
            }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
    },
    {
      test_id: "PX-020",
      category: "layered semantic bypass attempts",
      intent: "Recursive fan-out plan hidden in nested objects must still be blocked",
      mode: "pipeline",
      why_this_matters: "Attackers hide loop amplification one layer below the obvious plan root.",
      raw_input: rawJson(
        baseInput({
          execution_request: {
            request_id: "px-020",
            parameters: {
              workflow: {
                plan: [{ step: "retry_until_success", limit: "none" }, { step: "spawn", count: 1000 }]
              } as unknown as JsonValue
            }
          }
        }) as unknown as JsonValue
      ),
      expected_outcome: "REFUSE",
      expected_reason_code: "ERR_FORBIDDEN_ACTION_IN_PARAMETERS"
    }
  ];
}

function main() {
  const outputDir = join(process.cwd(), "proof-expansion-bundle");
  ensureDir(outputDir);

  const cases = buildCases();
  const results = cases.map((testCase) => {
    resetRuntimeState();
    testCase.setup?.();

    if (testCase.mode === "pipeline") {
      const outcome = outcomeFromRaw(testCase.raw_input ?? "");
      return {
        ...testCase,
        actual_outcome: outcome.decision,
        actual_reason_code: outcome.reason_code,
        status:
          outcome.decision === testCase.expected_outcome && outcome.reason_code === testCase.expected_reason_code
            ? "PASS"
            : "FAIL"
      };
    }

    if (testCase.mode === "concurrent") {
      const concurrent = simulateConcurrentDuplicate(testCase.raw_input ?? "");
      return {
        ...testCase,
        actual_outcome: concurrent.second.decision,
        actual_reason_code: concurrent.second.reason_code,
        first_outcome: concurrent.first.decision,
        first_reason_code: concurrent.first.reason_code,
        status:
          concurrent.first.decision === "ALLOW" &&
          concurrent.second.decision === testCase.expected_outcome &&
          concurrent.second.reason_code === testCase.expected_reason_code
            ? "PASS"
            : "FAIL"
      };
    }

    const step_results = testCase.steps!.map((step) => {
      const outcome = outcomeFromRaw(step.raw_input);
      return {
        expected_outcome: step.expected_outcome,
        expected_reason_code: step.expected_reason_code,
        actual_outcome: outcome.decision,
        actual_reason_code: outcome.reason_code,
        status:
          outcome.decision === step.expected_outcome && outcome.reason_code === step.expected_reason_code
            ? "PASS"
            : "FAIL"
      };
    });

    const last = step_results.at(-1)!;
    return {
      ...testCase,
      actual_outcome: last.actual_outcome,
      actual_reason_code: last.actual_reason_code,
      step_results,
      status: step_results.every((step) => step.status === "PASS") ? "PASS" : "FAIL"
    };
  });

  const proof_scaling_plan = {
    execution_volume: 10_000_000,
    duration_hours: 24,
    concurrency_level: 512,
    replay_volume: 2_000_000,
    target: "Extend proof volume beyond the current 546-case verification surface and 1,011,280-run legacy audit scale without relaxing any zero-mismatch condition."
  };

  const adversarial_scenarios = [
    {
      story: "A budget token is reused across autonomous agents during a traffic spike.",
      weak_system_failure: "Two or more requests reserve from the same token without atomic accounting and overspend silently.",
      mnde_prevention: "ARM reserves projected cost atomically and refuses the overdraw request with ERR_BUDGET_TOKEN_EXHAUSTED.",
      evidence: ["arm trace budget token", "receipt decision hash", "budget stress samples", "post verification budget summary"]
    },
    {
      story: "A previously approved execution_id is replayed with a tweaked payload after a worker crash.",
      weak_system_failure: "The system keys only on payload and issues a second ALLOW.",
      mnde_prevention: "ARM persists execution authority and refuses the second attempt with ERR_EXECUTION_ID_REPLAYED.",
      evidence: ["execution authority store snapshot", "concurrency summary", "receipt lineage by execution_id"]
    },
    {
      story: "A tool-call plan looks benign, but nested parameters contain destructive code.",
      weak_system_failure: "Only the top-level tool allowlist is inspected, so destructive intent executes.",
      mnde_prevention: "Orbit canonicalizes the full parameter object and blocks the request with ERR_FORBIDDEN_ACTION_IN_PARAMETERS.",
      evidence: ["orbit validation hash", "semantic attack case result", "deterministic refusal code"]
    },
    {
      story: "A stale policy blob is replayed after the runtime has pinned a new policy version.",
      weak_system_failure: "Caching or weak trust handling allows the request under the wrong policy.",
      mnde_prevention: "Preflight refuses before planning with ERR_POLICY_VERSION_MISMATCH or ERR_INVALID_POLICY_SIGNATURE.",
      evidence: ["preflight trace", "policy hash", "parity report", "typed refusal artifacts"]
    },
    {
      story: "A long-running job acquires extra GPUs and exceeds projected cost after approval.",
      weak_system_failure: "The pre-execution allow stands even though runtime behavior drifts upward.",
      mnde_prevention: "Ramona binds runtime observations to the allow envelope and refuses on drift with ERR_RUNTIME_GPU_DRIFT or ERR_RUNTIME_COST_DRIFT.",
      evidence: ["ramona runtime hash", "receipt replay", "drift tests", "runtime drift attack results"]
    }
  ];

  const external_verification_plan = {
    required_artifacts: [
      join(process.cwd(), "audit-proof-bundle", "summary.json"),
      join(process.cwd(), "audit-proof-bundle", "proof_bundle", "signed_receipts.jsonl"),
      join(process.cwd(), "audit-proof-bundle", "proof_bundle", "replay_results.json"),
      join(process.cwd(), "audit-proof-bundle", "proof_bundle", "parity_report.json"),
      join(process.cwd(), "attack-wave-bundle", "attack_wave_results.json"),
      join(process.cwd(), "remediation-wave-bundle", "remediation_wave_results.json"),
      join(process.cwd(), "post-remediation-verification-bundle", "post_verification_report.json"),
      join(outputDir, "proof_expansion_results.json")
    ],
    replay_procedure: [
      "Load each canonical_request from signed_receipts.jsonl",
      "Rerun executeDeterministicPipeline on the canonical_request bytes",
      "Rebuild the receipt",
      "Require exact decision_hash match and exact canonical receipt byte match"
    ],
    signature_verification: [
      "Recompute HMAC over the canonical receipt payload excluding the signature block",
      "Verify algorithm = HMAC-SHA256",
      "Verify key_id = ecs-prod-key-v2",
      "Require exact signature byte match"
    ],
    independent_parity_validation: [
      "Replay parity_vectors.json through the Rust parity runner",
      "Compare receipt_bytes, decision_hash, and decision for every vector",
      "Require mismatch_count = 0"
    ]
  };

  const claim_strengthening = [
    "The system enforces deterministic fail-closed control across preflight, orbit, arm, and ramona with zero unexpected allows and zero known-type schema fallbacks in the audited corpus.",
    "The system produces stable decision hashes, stable primary reason codes, and stable receipt bytes for repeated identical inputs across the audited proof surface.",
    "The system prevents duplicate execution authority and budget-token overdraw under concurrent stress in the audited scenarios.",
    "The system rejects semantic abuse, policy-version drift, trust mismatches, and runtime resource drift with deterministic typed refusal codes in the audited scenarios.",
    "The system reproduces identical decision artifacts across the current Node and Rust parity paths for the audited parity corpus."
  ];

  const summary = {
    total_cases: results.length,
    pass_count: results.filter((item) => item.status === "PASS").length,
    fail_count: results.filter((item) => item.status === "FAIL").length
  };

  writeJsonArtifact(
    join(outputDir, "proof_expansion_results.json"),
    {
      summary,
      new_attack_classes: results,
      proof_scaling_plan,
      adversarial_scenarios,
      external_verification_plan,
      claim_strengthening
    } as unknown as JsonValue
  );

  process.stdout.write(`${JSON.stringify({ summary, output: join(outputDir, "proof_expansion_results.json") }, null, 2)}\n`);
}

main();
