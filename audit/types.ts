import type { JsonValue } from "../shared/json.ts";

export type ToolCall = {
  tool: string;
  priority: number;
};

export type CanonicalExecutionInput = {
  execution_request: {
    request_id: string;
    submitted_region: string;
    actor: {
      user_id: string;
    };
    resources: {
      gpu_type: string;
      gpu_count: number;
      hours: number;
    };
    execution: {
      auto_scale: boolean;
      max_scale_multiplier: number;
      retry_on_fail: boolean;
      max_retries: number;
    };
    tool_calls: ToolCall[];
    orbit_intent: {
      orbit_version: string;
      action: string;
      boundary: string;
      payload: {
        tool_calls: ToolCall[];
      };
      lifecycle_state: string;
      signatures: Array<{
        alg: string;
        sig: string;
      }>;
    };
    release_request: {
      execution_id: string;
      hold_state: "NONE" | "PENDING" | "APPROVED";
      already_consumed: boolean;
    };
    runtime_observation: {
      kill_switch_active: boolean;
      actual_gpu_count: number;
      actual_hours: number;
      actual_total_cost_cents: number;
    };
  };
  policy_document: {
    schema_version: "ecs.policy.v1";
    policy_version: string;
    rules: {
      max_total_cost_cents: number;
      allow_auto_scale: boolean;
      max_gpu_count: number;
      max_hours: number;
      require_manual_approval_above_cents: number;
      max_retry_count: number;
    };
  };
  pricing_data: {
    gpu_hour_cents: number;
  };
};

export type ParsedEnvelope = {
  raw_input: string;
  parsed_input: CanonicalExecutionInput;
  canonical_input: string;
  request_hash: string;
};

export type PreflightStage = {
  layer: "Preflight";
  canonicalization: "RFC8785";
  request_hash: string;
};

export type OrbitStage = {
  layer: "Orbit";
  decision: "PASS" | "FAIL";
  reason_code: string;
  validation_hash: string;
};

export type ArmStage = {
  layer: "ARM";
  decision: "ALLOW" | "REFUSE";
  reason_code: string;
  projected_total_cost_cents: number;
  allowed_cost_cents: number;
  prevented_cost_cents: number;
};

export type RamonaStage = {
  layer: "RAM0NA";
  decision: "ALLOW" | "REFUSE";
  reason_code: string;
  runtime_hash: string;
};

export type DecisionOutput = {
  decision: "ALLOW" | "REFUSE";
  decision_hash: string;
  request_hash: string;
  reason_code: string;
  total_cost_usd: string;
  allowed_cost_usd: string;
  prevented_cost_usd: string;
  policy_version: string;
};

export type SignedReceiptPayload = {
  schema_version: "ecs.receipt.v1";
  request_hash: string;
  canonical_request: string;
  decision_output: DecisionOutput;
  pipeline_trace: {
    preflight: PreflightStage;
    orbit: OrbitStage;
    arm: ArmStage;
    ram0na: RamonaStage;
  };
};

export type SignedReceipt = SignedReceiptPayload & {
  signature: {
    algorithm: "HMAC-SHA256";
    key_id: string;
    value: string;
  };
  verifiable_signature?: {
    algorithm: "ED25519";
    key_id: string;
    public_key_fingerprint: string;
    value: string;
  };
};

export type ExecutionResult = {
  receipt: SignedReceipt;
  receipt_bytes: string;
};

export type PreflightFailure = {
  decision: "REFUSE";
  request_hash: string;
  decision_hash: string;
  reason_code: string;
  parse_boundary: true;
};

export type AdversarialCaseResult = {
  case_id: string;
  status: "PASS" | "FAIL";
  expectation: string;
  observed: JsonValue;
};
