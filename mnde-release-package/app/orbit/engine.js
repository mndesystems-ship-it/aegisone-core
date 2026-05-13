import { createHash } from "crypto";
import { REASON_CODES, canonicalizeJson } from "../shared/index.js";
const FORBIDDEN_CODE_PATTERNS = [
    "rm -rf",
    "drop_database",
    "delete_database",
    "/etc/credentials",
    "os.remove(",
    "unlink("
];
const FORBIDDEN_NETWORK_PATTERNS = [
    "169.254.169.254",
    "127.0.0.1",
    "localhost",
    ":2375",
    ":2376"
];
const FORBIDDEN_QUERY_PATTERNS = [
    "select * from secrets",
    "export select",
    "api_key",
    "token dump"
];
const FORBIDDEN_PLAN_PATTERNS = [
    "retry_until_success",
    "\"limit\":\"none\"",
    "\"count\":1000",
    "\"count\":10000"
];
function parameterText(parameters) {
    return canonicalizeJson(parameters).toLowerCase();
}
const RULES = [
    {
        id: "destructive_code",
        matcher: (parameters)=>FORBIDDEN_CODE_PATTERNS.some((pattern)=>parameterText(parameters).includes(pattern))
    },
    {
        id: "internal_network",
        matcher: (parameters)=>FORBIDDEN_NETWORK_PATTERNS.some((pattern)=>parameterText(parameters).includes(pattern))
    },
    {
        id: "data_exfiltration",
        matcher: (parameters)=>FORBIDDEN_QUERY_PATTERNS.some((pattern)=>parameterText(parameters).includes(pattern))
    },
    {
        id: "recursive_or_fanout",
        matcher: (parameters)=>FORBIDDEN_PLAN_PATTERNS.some((pattern)=>parameterText(parameters).includes(pattern))
    }
];
function toolCallsEqual(left, right) {
    if (left.length !== right.length) {
        return false;
    }
    for(let index = 0; index < left.length; index += 1){
        if (left[index]?.tool !== right[index]?.tool || left[index]?.priority !== right[index]?.priority) {
            return false;
        }
    }
    return true;
}
export function runStrictOrbit(input) {
    const validationHash = createHash("sha256").update(canonicalizeJson(input.execution_request.orbit_intent)).digest("hex");
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
    const parameters = input.execution_request.parameters;
    if (parameters) {
        for (const rule of RULES){
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
