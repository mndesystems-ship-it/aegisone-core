import { canonicalizeJson } from "../shared/json.js";
import { ensureDir, makeBaseInput, rawJson, writeRustParityVectors } from "./node_runtime.js";
export const OUTPUT_DIR = "audit-proof-bundle";
export const FULL_LOGS_DIR = `${OUTPUT_DIR}/full_logs`;
export const PROOF_BUNDLE_DIR = `${OUTPUT_DIR}/proof_bundle`;
export const RECEIPT_PATH = `${PROOF_BUNDLE_DIR}/signed_receipts.jsonl`;
export const PARITY_VECTOR_PATH = `${PROOF_BUNDLE_DIR}/parity_vectors.json`;
export const PROFILE_ORDER = [
    "allow_burst",
    "refuse_burst",
    "mixed_50_50",
    "adversarial_malformed",
    "replay_storm"
];
const VALID_CASES_PER_PROFILE = 200;
const PARITY_CASES_PER_PROFILE = 20;
const CANONICALIZATION_BASE_CASES = 20;
function createRng(seed) {
    let state = seed >>> 0;
    const nextUint = ()=>{
        state = Math.imul(state, 1664525) + 1013904223 >>> 0;
        return state;
    };
    return {
        next () {
            return nextUint() / 0x100000000;
        },
        int (min, max) {
            return min + nextUint() % (max - min + 1);
        },
        pick (items) {
            return items[this.int(0, items.length - 1)];
        },
        shuffle (items) {
            const next = [
                ...items
            ];
            for(let index = next.length - 1; index > 0; index -= 1){
                const swapIndex = this.int(0, index);
                [next[index], next[swapIndex]] = [
                    next[swapIndex],
                    next[index]
                ];
            }
            return next;
        }
    };
}
function makeToken(rng, prefix, targetLength) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-_";
    let output = prefix;
    while(output.length < targetLength){
        output += alphabet[rng.int(0, alphabet.length - 1)];
    }
    return output.slice(0, targetLength);
}
function makeSizeTarget(caseIndex) {
    if (caseIndex === VALID_CASES_PER_PROFILE - 1) {
        return 1024 * 1024;
    }
    if (caseIndex >= VALID_CASES_PER_PROFILE - 3) {
        return 256 * 1024 + (caseIndex - (VALID_CASES_PER_PROFILE - 3)) * 64 * 1024;
    }
    if (caseIndex >= VALID_CASES_PER_PROFILE - 10) {
        return 32 * 1024 + (caseIndex - (VALID_CASES_PER_PROFILE - 10)) * 8 * 1024;
    }
    return 1024 + caseIndex * 32;
}
function buildToolCalls(count) {
    const output = [];
    for(let index = 0; index < count; index += 1){
        output.push({
            tool: `tool-${index.toString().padStart(4, "0")}`,
            priority: index + 1
        });
    }
    return output;
}
function cloneInput(input) {
    return JSON.parse(JSON.stringify(input));
}
function stableSize(value) {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function reorderJson(value, rng) {
    if (Array.isArray(value)) {
        return value.map((item)=>reorderJson(item, rng));
    }
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value);
        const reordered = rng.shuffle(entries);
        const next = {};
        for (const [key, item] of reordered){
            next[key] = reorderJson(item, rng);
        }
        return next;
    }
    return value;
}
function serializeJson(value, rng, whitespace = 0) {
    return JSON.stringify(reorderJson(value, rng), null, whitespace);
}
function computeDepth(value) {
    if (Array.isArray(value)) {
        return 1 + (value.length === 0 ? 0 : Math.max(...value.map((item)=>computeDepth(item))));
    }
    if (value !== null && typeof value === "object") {
        const items = Object.values(value);
        return 1 + (items.length === 0 ? 0 : Math.max(...items.map((item)=>computeDepth(item))));
    }
    return 1;
}
function inflateRequest(input, targetBytes, cardinality, rng, caseId) {
    const next = cloneInput(input);
    const longUser = makeToken(rng, `user-${caseId}-`, 96);
    next.execution_request.actor.user_id = longUser;
    next.execution_request.request_id = makeToken(rng, `${caseId}-`, 72);
    next.execution_request.release_request.execution_id = makeToken(rng, `exec-${caseId}-`, 72);
    next.execution_request.tool_calls = buildToolCalls(cardinality);
    next.execution_request.orbit_intent.payload.tool_calls = buildToolCalls(cardinality);
    next.execution_request.orbit_intent.signatures = [
        {
            alg: "hmac-sha256",
            sig: makeToken(rng, `sig-${caseId}-`, 256)
        }
    ];
    next.execution_request.orbit_intent.boundary = makeToken(rng, `boundary-${caseId}-`, 64);
    let currentSize = stableSize(next);
    if (currentSize >= targetBytes) {
        return next;
    }
    const paddingSize = targetBytes - currentSize;
    next.execution_request.orbit_intent.signatures[0].sig += makeToken(rng, `${caseId}-pad-`, paddingSize + 32);
    currentSize = stableSize(next);
    if (currentSize >= targetBytes) {
        return next;
    }
    next.execution_request.actor.user_id += makeToken(rng, `${caseId}-actor-`, targetBytes - currentSize + 32);
    return next;
}
function makeValidCase(profile, index) {
    const seed = 1000 + PROFILE_ORDER.indexOf(profile) * 10000 + index;
    const rng = createRng(seed);
    const base = makeBaseInput();
    const cardinality = 2 + index % 64;
    const targetBytes = makeSizeTarget(index);
    const caseId = `${profile}-${index.toString().padStart(4, "0")}`;
    const input = inflateRequest(base, targetBytes, cardinality, rng, caseId);
    if (profile === "refuse_burst") {
        input.execution_request.execution.auto_scale = true;
        input.execution_request.execution.max_scale_multiplier = 32;
        input.execution_request.execution.retry_on_fail = true;
        input.execution_request.execution.max_retries = 9;
        input.execution_request.release_request.hold_state = "PENDING";
        input.execution_request.runtime_observation.actual_total_cost_cents = input.pricing_data.gpu_hour_cents * 4 * 2;
    } else if (profile === "mixed_50_50") {
        if (index % 2 === 0) {
            input.execution_request.execution.auto_scale = true;
            input.execution_request.execution.max_scale_multiplier = 16;
            input.execution_request.execution.retry_on_fail = true;
            input.execution_request.execution.max_retries = 8;
            input.execution_request.release_request.hold_state = "PENDING";
        } else {
            input.execution_request.execution.auto_scale = false;
            input.execution_request.execution.max_scale_multiplier = 1;
            input.execution_request.execution.retry_on_fail = false;
            input.execution_request.execution.max_retries = 0;
            input.execution_request.release_request.hold_state = "APPROVED";
        }
    } else if (profile === "replay_storm") {
        input.execution_request.request_id = `replay-sequence-${Math.floor(index / 4).toString().padStart(4, "0")}`;
        input.execution_request.release_request.execution_id = `replay-exec-${Math.floor(index / 4).toString().padStart(4, "0")}`;
        input.execution_request.execution.auto_scale = false;
        input.execution_request.execution.retry_on_fail = false;
        input.execution_request.release_request.hold_state = "APPROVED";
    }
    const rawValue = reorderJson(input, createRng(seed ^ 0xabcddcba));
    const rawInput = JSON.stringify(rawValue);
    return {
        case_id: caseId,
        profile,
        raw_input: rawInput,
        expected_valid: true,
        expected_decision: profile === "allow_burst" || profile === "replay_storm" || profile === "mixed_50_50" && index % 2 === 1 ? "ALLOW" : "REFUSE",
        request_size_bytes: Buffer.byteLength(rawInput, "utf8"),
        nested_depth: computeDepth(rawValue),
        high_cardinality_count: cardinality,
        key_order_seed: seed ^ 0xabcddcba,
        tags: [
            profile,
            "valid"
        ]
    };
}
function deepUnknownObject(depth, leafSize, seed) {
    const rng = createRng(seed);
    let node = makeToken(rng, "leaf-", leafSize);
    for(let index = 0; index < depth; index += 1){
        node = {
            [`layer_${index.toString().padStart(2, "0")}`]: node
        };
    }
    return node;
}
function makeMalformedCase(index) {
    const seed = 40000 + index;
    const rng = createRng(seed);
    const caseId = `adversarial_malformed-${index.toString().padStart(4, "0")}`;
    const template = makeBaseInput();
    const targetBytes = makeSizeTarget(index);
    const cardinality = 2 + index % 64;
    const inflated = inflateRequest(template, Math.max(1024, targetBytes / 2), cardinality, rng, caseId);
    const baseValue = JSON.parse(rawJson(inflated));
    const mutationType = index % 6;
    let rawInput = "";
    let depth = computeDepth(baseValue);
    const keyOrderSeed = seed ^ 0x55aa55aa;
    if (mutationType === 0) {
        const duplicateRequest = `{"execution_request":{"request_id":"${caseId}-a","request_id":"${caseId}-b"},"policy_document":${JSON.stringify(inflated.policy_document)},"pricing_data":${JSON.stringify(inflated.pricing_data)}}`;
        rawInput = duplicateRequest;
        depth = 3;
    } else if (mutationType === 1) {
        baseValue.execution_request.unknown_field = deepUnknownObject(4 + index % 8, 256, seed);
        rawInput = serializeJson(baseValue, createRng(keyOrderSeed), 0);
        depth = computeDepth(baseValue);
    } else if (mutationType === 2) {
        delete baseValue.pricing_data.gpu_hour_cents;
        rawInput = serializeJson(baseValue, createRng(keyOrderSeed), 2);
    } else if (mutationType === 3) {
        const asText = serializeJson(baseValue, createRng(keyOrderSeed), 0);
        rawInput = asText.replace(/"gpu_hour_cents":\d+/, "\"gpu_hour_cents\":1e309");
    } else if (mutationType === 4) {
        const asText = serializeJson(baseValue, createRng(keyOrderSeed), 0);
        rawInput = asText.replace(/"max_retries":\d+/, "\"max_retries\":-1");
    } else {
        rawInput = "{\"execution_request\":";
        depth = 1;
    }
    if (Buffer.byteLength(rawInput, "utf8") < targetBytes) {
        const suffix = makeToken(rng, `${caseId}-tail-`, targetBytes - Buffer.byteLength(rawInput, "utf8") + 32);
        if (mutationType === 5) {
            rawInput += suffix;
        } else {
            rawInput = rawInput.replace(/\}\s*$/, `,"tail":"${suffix}"}`);
        }
    }
    return {
        case_id: caseId,
        profile: "adversarial_malformed",
        raw_input: rawInput,
        expected_valid: false,
        expected_decision: "REFUSE",
        request_size_bytes: Buffer.byteLength(rawInput, "utf8"),
        nested_depth: depth,
        high_cardinality_count: cardinality,
        key_order_seed: keyOrderSeed,
        tags: [
            "adversarial_malformed",
            "invalid"
        ]
    };
}
export function buildBenchmarkMatrix() {
    const cases = [];
    for (const profile of PROFILE_ORDER){
        if (profile === "adversarial_malformed") {
            for(let index = 0; index < VALID_CASES_PER_PROFILE; index += 1){
                cases.push(makeMalformedCase(index));
            }
            continue;
        }
        for(let index = 0; index < VALID_CASES_PER_PROFILE; index += 1){
            cases.push(makeValidCase(profile, index));
        }
    }
    return cases;
}
export function getParityVectors(cases) {
    const output = [];
    for (const profile of PROFILE_ORDER){
        if (profile === "adversarial_malformed") {
            continue;
        }
        const profileCases = cases.filter((item)=>item.profile === profile && item.expected_valid).slice(0, PARITY_CASES_PER_PROFILE);
        for (const testCase of profileCases){
            output.push({
                case_id: testCase.case_id,
                raw_input: testCase.raw_input
            });
        }
    }
    return output;
}
export function getCanonicalizationBaseCases(cases) {
    return cases.filter((item)=>item.expected_valid).slice(0, CANONICALIZATION_BASE_CASES);
}
export function ensureOutputDirs() {
    ensureDir(OUTPUT_DIR);
    ensureDir(FULL_LOGS_DIR);
    ensureDir(PROOF_BUNDLE_DIR);
}
export function writeParityVectors(cases) {
    ensureOutputDirs();
    writeRustParityVectors(PARITY_VECTOR_PATH, getParityVectors(cases));
}
export function buildMatrixReport(cases) {
    return {
        schema_version: "ecs.audit.test_matrix.v2",
        seed: 20260412,
        total_unique_cases: cases.length,
        profiles: PROFILE_ORDER.map((profile)=>{
            const profileCases = cases.filter((item)=>item.profile === profile);
            return {
                profile,
                unique_cases: profileCases.length,
                request_size_bytes: {
                    min: Math.min(...profileCases.map((item)=>item.request_size_bytes)),
                    max: Math.max(...profileCases.map((item)=>item.request_size_bytes))
                },
                nested_depth: {
                    min: Math.min(...profileCases.map((item)=>item.nested_depth)),
                    max: Math.max(...profileCases.map((item)=>item.nested_depth))
                },
                high_cardinality_fields: {
                    min: Math.min(...profileCases.map((item)=>item.high_cardinality_count)),
                    max: Math.max(...profileCases.map((item)=>item.high_cardinality_count))
                },
                randomized_key_order: true,
                valid_cases: profileCases.filter((item)=>item.expected_valid).length,
                invalid_cases: profileCases.filter((item)=>!item.expected_valid).length
            };
        }),
        schema_depth_cap_detected: 8,
        within_schema_depth_variance_for_valid_cases: false,
        out_of_schema_deep_nesting_exercised_via_rejection_cases: true
    };
}
export function buildCanonicalVariant(baseCase, variantIndex) {
    const base = JSON.parse(baseCase.raw_input);
    const rng = createRng(900000 + variantIndex + baseCase.key_order_seed);
    const category = variantIndex % 4;
    const variant = JSON.parse(JSON.stringify(base));
    const executionRequest = variant.execution_request;
    if (category === 0) {
        return serializeJson(variant, rng, 0);
    }
    if (category === 1) {
        const compact = serializeJson(variant, rng, 2);
        return compact.replace(/user/g, "\\u0075ser");
    }
    if (category === 2) {
        executionRequest.execution.max_retries = variantIndex % 8 === 0 ? -0 : 0;
        return serializeJson(variant, rng, 2);
    }
    const compact = serializeJson(variant, rng, 2);
    return compact.replace(/\{/g, "{\n").replace(/\}/g, "\n}");
}
export function canonicalBytes(value) {
    return canonicalizeJson(value);
}
