import { readFileSync } from "fs";
import { executeDeterministicPipeline, resetRuntimeState } from "./node_runtime.js";
import { canonicalizeJson } from "../shared/index.js";
function main() {
    const vectorPath = process.argv[2];
    if (!vectorPath) {
        throw new Error("vector path is required");
    }
    const vectors = JSON.parse(readFileSync(vectorPath, "utf8"));
    const outputs = vectors.map((vector)=>{
        resetRuntimeState();
        const result = executeDeterministicPipeline(vector.raw_input);
        if ("parse_boundary" in result) {
            return {
                case_id: vector.case_id,
                decision: result.decision,
                decision_hash: result.decision_hash,
                receipt_bytes: canonicalizeJson(result)
            };
        }
        return {
            case_id: vector.case_id,
            decision: result.receipt.decision_output.decision,
            decision_hash: result.receipt.decision_output.decision_hash,
            receipt_bytes: result.receipt_bytes
        };
    });
    process.stdout.write(JSON.stringify(outputs));
}
main();
