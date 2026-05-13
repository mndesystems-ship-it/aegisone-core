import { createHash } from "crypto";
import { REASON_CODES, canonicalizeJson, type CanonicalExecutionInput, type JsonValue, type OrbitTrace } from "../shared/index.ts";

type PatternRule = {
  id: string;
  matcher: (parameters: Record<string, JsonValue>) => boolean;
};

const FORBIDDEN_CODE_PATTERNS = ["rm -rf", "drop_database", "delete_database", "/etc/credentials", "os.remove(", "unlink("];
const FORBIDDEN_NETWORK_PATTERNS = ["169.254.169.254", "127.0.0.1", "localhost", ":2375", ":2376"];
const FORBIDDEN_QUERY_PATTERNS = ["select * from secrets", "export select", "api_key", "token dump"];
const FORBIDDEN_PLAN_PATTERNS = ["retry_until_success", "\"limit\":\"none\"", "\"count\":1000", "\"count\":10000"];
const ACTION_FIELD_NAMES = new Set(["action", "actions", "tool_calls", "execution_targets"]);
const ACTION_TEXT_PATTERNS = ["deploy_irreversible", "irreversible", "delete", "destroy", "scale_gpu_cluster", "start_training_job", "retry_failed_job"];

function parameterText(parameters: Record<string, JsonValue>): string {
  return canonicalizeJson(parameters as unknown as JsonValue).toLowerCase();
}

const RULES: PatternRule[] = [
  {
    id: "destructive_code",
    matcher: (parameters) => FORBIDDEN_CODE_PATTERNS.some((pattern) => parameterText(parameters).includes(pattern))
  },
  {
    id: "internal_network",
    matcher: (parameters) => FORBIDDEN_NETWORK_PATTERNS.some((pattern) => parameterText(parameters).includes(pattern))
  },
  {
    id: "data_exfiltration",
    matcher: (parameters) => FORBIDDEN_QUERY_PATTERNS.some((pattern) => parameterText(parameters).includes(pattern))
  },
  {
    id: "recursive_or_fanout",
    matcher: (parameters) => FORBIDDEN_PLAN_PATTERNS.some((pattern) => parameterText(parameters).includes(pattern))
  }
];

function toolCallsEqual(
  left: CanonicalExecutionInput["execution_request"]["tool_calls"],
  right: CanonicalExecutionInput["execution_request"]["orbit_intent"]["payload"]["tool_calls"]
) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.tool !== right[index]?.tool || left[index]?.priority !== right[index]?.priority) {
      return false;
    }
  }
  return true;
}

function countNestedActionMarkers(value: JsonValue): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countNestedActionMarkers(item), 0);
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    return ACTION_TEXT_PATTERNS.some((pattern) => lower.includes(pattern)) && lower.includes("action") ? 1 : 0;
  }
  if (typeof value !== "object" || value === null) {
    return 0;
  }

  let markers = 0;
  for (const [key, nested] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (ACTION_FIELD_NAMES.has(lowerKey)) {
      markers += Array.isArray(nested) ? nested.length : 1;
    }
    markers += countNestedActionMarkers(nested);
  }
  return markers;
}

function hasMultipleActions(input: CanonicalExecutionInput): boolean {
  const parameters = input.execution_request.parameters;
  if (!parameters) {
    return false;
  }
  return countNestedActionMarkers(parameters as unknown as JsonValue) > 0;
}

export function runStrictOrbit(input: CanonicalExecutionInput): OrbitTrace {
  const validationHash = createHash("sha256")
    .update(canonicalizeJson(input.execution_request.orbit_intent as unknown as JsonValue))
    .digest("hex");

  if (input.execution_request.orbit_intent.orbit_version !== "2.0" || input.execution_request.orbit_intent.lifecycle_state !== "ARMED") {
    return {
      layer: "orbit",
      decision: "REFUSE",
      reason_code: REASON_CODES.ToolCallSequence,
      validation_hash: validationHash
    };
  }

  if (!toolCallsEqual(input.execution_request.tool_calls, input.execution_request.orbit_intent.payload.tool_calls)) {
    return {
      layer: "orbit",
      decision: "REFUSE",
      reason_code: REASON_CODES.ToolCallSequence,
      validation_hash: validationHash
    };
  }

  if (hasMultipleActions(input)) {
    return {
      layer: "orbit",
      decision: "REFUSE",
      reason_code: REASON_CODES.OrbitMultipleActions,
      validation_hash: validationHash
    };
  }

  const parameters = input.execution_request.parameters;
  if (parameters) {
    for (const rule of RULES) {
      if (rule.matcher(parameters)) {
        return {
          layer: "orbit",
          decision: "REFUSE",
          reason_code: REASON_CODES.ForbiddenActionInParameters,
          validation_hash: validationHash
        };
      }
    }
  }

  return {
    layer: "orbit",
    decision: "ALLOW",
    reason_code: REASON_CODES.OkOrbit,
    validation_hash: validationHash
  };
}
