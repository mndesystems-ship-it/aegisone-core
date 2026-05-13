import { canonicalHash } from "./format.js";

export function buildExportGraph(items) {
    const receiptNodes = items.map((item) => ({
        id: `receipt:${item.receipt_hash}`,
        type: "receipt",
        hash: item.receipt_hash,
        request_hash: item.receipt.request_hash,
        decision_hash: item.receipt.decision_output.decision_hash
    }));
    const policyMap = new Map();
    const keySetMap = new Map();
    const edges = [];
    for (const item of items) {
        const policyId = `policy:${item.receipt.policy_hash}`;
        const keySetId = `keyset:${item.proof.key_set_version}`;
        policyMap.set(policyId, {
            id: policyId,
            type: "policy",
            hash: item.receipt.policy_hash,
            policy_version: item.receipt.decision_output.policy_version
        });
        keySetMap.set(keySetId, {
            id: keySetId,
            type: "keyset",
            key_set_version: item.proof.key_set_version
        });
        edges.push({ from: `receipt:${item.receipt_hash}`, to: policyId, relationship: "verified_against" });
        edges.push({ from: policyId, to: keySetId, relationship: "signed_by" });
    }
    const base = {
        schema_version: "mnde.audit_export_graph.v1",
        nodes: [...receiptNodes, ...policyMap.values(), ...keySetMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
        edges: edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.relationship.localeCompare(b.relationship))
    };
    return { ...base, graph_hash: canonicalHash(base) };
}
