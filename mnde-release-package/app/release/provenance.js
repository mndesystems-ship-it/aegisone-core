import { readFileSync } from "fs";
import { PROVENANCE_PATH } from "./paths.js";
export function readProvenance() {
    return JSON.parse(readFileSync(PROVENANCE_PATH, "utf8"));
}
export function formatProvenanceForDisplay(provenance) {
    return JSON.stringify(provenance, null, 2);
}
