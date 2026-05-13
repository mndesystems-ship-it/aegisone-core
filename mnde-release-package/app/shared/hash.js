import { createHash } from "crypto";
import { canonicalizeJson } from "./json.js";
export function sha256Hex(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function hashCanonicalJson(value) {
    return sha256Hex(canonicalizeJson(value));
}
