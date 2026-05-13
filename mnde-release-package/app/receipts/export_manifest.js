import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { sha256Hex } from "../shared/hash.js";
import { canonicalHash } from "./format.js";

function listFiles(root, dir = root) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    const files = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFiles(root, fullPath));
        } else {
            files.push(path.relative(root, fullPath).replaceAll("\\", "/"));
        }
    }
    return files;
}

export function hashBundleFiles(bundleRoot, excluded = ["manifest.json", "signatures/bundle.sig"]) {
    const files = listFiles(bundleRoot).filter((file) => !excluded.includes(file)).sort();
    const file_entries = files.map((file) => {
        const fullPath = path.join(bundleRoot, file);
        return {
            path: file,
            size: statSync(fullPath).size,
            sha256: sha256Hex(readFileSync(fullPath))
        };
    });
    const root_hash = canonicalHash({ file_entries });
    return { file_entries, root_hash };
}

export function buildExportManifest({ generatedAt, receiptCount, policyVersions, keySetVersions, fileEntries, rootHash }) {
    return {
        bundle_version: "audit-bundle.v1",
        generated_at: generatedAt,
        root_hash: rootHash,
        receipt_count: receiptCount,
        policy_versions: [...policyVersions].sort(),
        key_set_versions: [...keySetVersions].sort(),
        deterministic: true,
        file_entries: fileEntries
    };
}
