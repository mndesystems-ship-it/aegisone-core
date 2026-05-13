const REASON_MESSAGES = {
    OK_ALLOW: "Allowed by active MNDe policy.",
    ERR_COST_LIMIT: "Blocked because projected cost exceeds the active boundary.",
    ERR_GPU_LIMIT: "Blocked because requested GPU count exceeds the active boundary.",
    ERR_HOURS_LIMIT: "Blocked because requested runtime exceeds the active boundary.",
    ERR_RETRY_LIMIT: "Blocked because retry count exceeds the active boundary.",
    ERR_AUTO_SCALE_DENIED: "Blocked because autoscale is not allowed by the active boundary.",
    ERR_KILL_SWITCH: "Blocked because kill switch is active.",
    ERR_RUNTIME_GPU_DRIFT: "Blocked because runtime GPU usage exceeded the approved request.",
    ERR_RUNTIME_HOURS_DRIFT: "Blocked because runtime hours exceeded the approved request.",
    ERR_RUNTIME_COST_DRIFT: "Blocked because runtime cost exceeded the approved request.",
    ERR_MANUAL_APPROVAL_REQUIRED: "Blocked because this request requires approval.",
    ERR_SCHEMA_VALIDATION: "Blocked because the request schema is invalid.",
    ERR_REQUEST_SIGNATURE_INVALID: "Blocked because request signature is invalid.",
    ERR_REQUEST_NONCE_REPLAY: "Blocked because the request nonce was already used.",
    ERR_REQUEST_TIMESTAMP_SKEW: "Blocked because the request timestamp is outside the allowed window.",
    ERR_REQUEST_BODY_HASH_MISMATCH: "Blocked because the body hash does not match the signed body."
};

export function translateReason(reasonCode) {
    const machine_code = reasonCode;
    return {
        schema_version: "mnde.reason_translation.v1",
        machine_code,
        human_message: REASON_MESSAGES[reasonCode] ?? `Blocked with reason code ${reasonCode}.`
    };
}

export function translateDecisionResponse(response) {
    return {
        ...response,
        reason: translateReason(response.reason_code)
    };
}
