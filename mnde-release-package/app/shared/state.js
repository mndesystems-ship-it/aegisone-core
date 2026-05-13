class InMemoryExecutionAuthorityStore {
    records = new Map();
    begin(executionId, requestHash) {
        const existing = this.records.get(executionId);
        if (!existing) {
            this.records.set(executionId, {
                execution_id: executionId,
                status: "inflight",
                request_hash: requestHash
            });
            return "created";
        }
        return existing.status === "allowed" ? "allowed_exists" : "inflight_exists";
    }
    commitAllow(executionId, requestHash, decisionHash) {
        this.records.set(executionId, {
            execution_id: executionId,
            status: "allowed",
            request_hash: requestHash,
            decision_hash: decisionHash
        });
    }
    snapshot() {
        return [
            ...this.records.values()
        ];
    }
    reset() {
        this.records.clear();
    }
}
class InMemoryBudgetTokenStore {
    records = new Map();
    define(token, maxBudgetCents) {
        this.records.set(token, {
            budget_token: token,
            max_budget_cents: maxBudgetCents,
            consumed_cents: 0
        });
    }
    reserve(token, projectedCostCents) {
        const existing = this.records.get(token);
        if (!existing) {
            return "exhausted";
        }
        if (existing.consumed_cents + projectedCostCents > existing.max_budget_cents) {
            return "exhausted";
        }
        existing.consumed_cents += projectedCostCents;
        this.records.set(token, existing);
        return "reserved";
    }
    snapshot() {
        return [
            ...this.records.values()
        ];
    }
    reset() {
        this.records.clear();
    }
}
export const executionAuthorityStore = new InMemoryExecutionAuthorityStore();
export const budgetTokenStore = new InMemoryBudgetTokenStore();
