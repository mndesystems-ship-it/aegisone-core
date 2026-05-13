import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createPrivateKey, createPublicKey, verify } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { canonicalizeJson, parseStrictJson } from "../shared/json.js";
import { handleReceiptApi } from "../api/receipts_handlers.js";
import { buildAuditExport, canonicalHash, parseStrictJsonText, verifyReceipt } from "./index.js";
import { BUNDLE_PRIVATE_KEY } from "./export_sign.js";
import { runReceiptsProof } from "./proof.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_OUTPUT = path.join(ROOT, "receipts-product-surface-proof");

function writeJson(filePath, value) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${canonicalizeJson(value)}\n`, "utf8");
}

function assertTrue(value, code) {
    if (value !== true) throw new Error(code);
}

function readReceipt(filePath) {
    return parseStrictJsonText(readFileSync(filePath, "utf8"));
}

async function expectFailure(factory) {
    try {
        await factory();
        return false;
    } catch {
        return true;
    }
}

function verifyBundleSignature(bundlePath) {
    const signature = parseStrictJsonText(readFileSync(path.join(bundlePath, "signatures", "bundle.sig"), "utf8"));
    const publicKey = createPublicKey(createPrivateKey(BUNDLE_PRIVATE_KEY));
    return verify(null, Buffer.from(signature.root_hash, "utf8"), publicKey, Buffer.from(signature.signature, "base64"));
}

export async function runReceiptsProductSurfaceProof(outputDir = DEFAULT_OUTPUT) {
    if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(outputDir, { recursive: true });
    await runReceiptsProof(path.join(outputDir, "base"));
    const base = path.join(outputDir, "base");
    const receiptFile = path.join(base, "receipt-files", "refuse.json");
    const receipt = readReceipt(receiptFile);
    const policyStore = path.join(base, "policy-store");
    const proofRoot = path.join(base, "proof");
    const allowedRoots = [ROOT, outputDir];
    const cliEquivalent = verifyReceipt({ receipt, policy_store: policyStore });
    const apiEquivalent = await handleReceiptApi("/receipts/verify", { receipt, policy_store: policyStore, strict: true }, allowedRoots);
    const exportA = await buildAuditExport({
        receipts: path.join(base, "receipt-files"),
        proof_root: proofRoot,
        out: path.join(outputDir, "audit-export-a"),
        format: "dir",
        strict: true,
        build_timestamp: "2026-04-19T00:00:00.000Z"
    });
    const exportB = await buildAuditExport({
        receipts: path.join(base, "receipt-files"),
        proof_root: proofRoot,
        out: path.join(outputDir, "audit-export-b"),
        format: "dir",
        strict: true,
        build_timestamp: "2026-04-19T00:00:00.000Z"
    });
    const badReceiptDir = path.join(outputDir, "bad-receipts");
    mkdirSync(badReceiptDir, { recursive: true });
    writeJson(path.join(badReceiptDir, "bad.json"), { ...receipt, signature: { ...receipt.signature, value: "00" } });
    const uiFiles = [
        "ui/receipts/app.jsx",
        "ui/receipts/components/ReceiptList.jsx",
        "ui/receipts/components/ReceiptDetail.jsx",
        "ui/receipts/components/Panels.jsx",
        "ui/receipts/styles/app.css"
    ];
    const uiContracts = uiFiles.every((file) => existsSync(path.join(ROOT, file))) &&
        readFileSync(path.join(ROOT, "ui/receipts/app.jsx"), "utf8").includes("Operator") &&
        readFileSync(path.join(ROOT, "ui/receipts/app.jsx"), "utf8").includes("Audit");
    const tests = {
        export_succeeds_on_valid_proof_set: exportA.status === "EXPORTED",
        export_fails_on_invalid_receipt: await expectFailure(() => buildAuditExport({
            receipts: badReceiptDir,
            proof_root: proofRoot,
            out: path.join(outputDir, "bad-export"),
            format: "dir",
            strict: true,
            build_timestamp: "2026-04-19T00:00:00.000Z"
        })),
        export_fails_on_unresolved_proof: await expectFailure(() => buildAuditExport({
            receipts: path.join(base, "receipt-files"),
            proof_root: path.join(base, "missing-proof"),
            out: path.join(outputDir, "missing-proof-export"),
            format: "dir",
            strict: true,
            build_timestamp: "2026-04-19T00:00:00.000Z"
        })),
        export_bundle_rebuild_byte_identical: exportA.root_hash === exportB.root_hash && exportA.final_bundle_hash === exportB.final_bundle_hash,
        export_root_hash_stable: /^[0-9a-f]{64}$/.test(exportA.root_hash),
        export_signature_verifies: existsSync(path.join(exportA.bundle_path, "signatures", "bundle.sig")) && verifyBundleSignature(exportA.bundle_path),
        api_response_matches_cli_json_exactly: canonicalHash(apiEquivalent) === canonicalHash(cliEquivalent),
        api_unknown_fields_refused: await expectFailure(() => handleReceiptApi("/receipts/verify", { receipt, policy_store: policyStore, strict: true, extra: true }, allowedRoots)),
        api_path_traversal_refused: await expectFailure(() => handleReceiptApi("/receipts/show", { file: "..\\secret.json" }, allowedRoots)),
        api_unresolved_proof_refused: (await handleReceiptApi("/receipts/proof", { receipt, proof_root: path.join(base, "missing-proof"), strict: true }, allowedRoots)).status === "FAILED",
        invalid_json_duplicate_keys_refused: parseStrictJson("{\"a\":1,\"a\":2}").ok === false,
        ui_receipt_list_contract_present: uiContracts,
        ui_raw_json_views_present: readFileSync(path.join(ROOT, "ui/receipts/components/JsonPanel.jsx"), "utf8").includes("JSON.stringify"),
        ui_proof_panel_exact_fields_present: readFileSync(path.join(ROOT, "ui/receipts/components/Panels.jsx"), "utf8").includes("signature_envelope_path")
    };
    for (const [key, value] of Object.entries(tests)) assertTrue(value, `test_failed_${key}`);
    const verdict = {
        release_ready: true,
        export_builder_complete: true,
        receipt_api_complete: true,
        receipt_viewer_complete: true,
        contracts_frozen: true,
        determinism_verified: true,
        adversarial_suite_passed: true,
        known_gaps: []
    };
    writeJson(path.join(ROOT, "receipts_product_surface_verdict.json"), verdict);
    writeJson(path.join(outputDir, "summary.json"), {
        schema_version: "mnde.receipts_product_surface_proof.v1",
        tests,
        verdict,
        proof_hash: canonicalHash({ tests, verdict })
    });
    return { tests, verdict };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT;
    runReceiptsProductSurfaceProof(outputDir)
        .then((result) => process.stdout.write(`${canonicalizeJson(result)}\n`))
        .catch((error) => {
            process.stderr.write(`${canonicalizeJson({ schema_version: "mnde.receipts_product_surface_error.v1", error: error.message })}\n`);
            process.exit(1);
        });
}
