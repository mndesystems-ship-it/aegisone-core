import { loadPolicyByVersion, lookupPolicy } from "../policy/lifecycle.js";
import { validatePolicyDocument } from "../policy/schema.js";
import { policyHash } from "../shared/policy-trust.js";

export function resolveHistoricalPolicy(policyStore, policyVersion, expectedPolicyHash) {
    let policy = null;
    try {
        policy = loadPolicyByVersion(policyStore, policyVersion);
        if (policyHash(policy) !== expectedPolicyHash) {
            throw new Error("historical_policy_hash_mismatch");
        }
    } catch (error) {
        if (error.message !== "policy_version_not_found") {
            throw error;
        }
        policy = lookupPolicy(policyStore, { hash: expectedPolicyHash });
        if (policy.policy_version !== policyVersion) {
            throw new Error("historical_policy_version_mismatch");
        }
    }
    validatePolicyDocument(policy, { requireTrust: true });
    return policy;
}
