import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
import { scanForbiddenContent, walkFiles } from "../shared/forbidden_content.js";
import { MANIFEST_PATH, PACKAGE_ROOT, PROVENANCE_PATH } from "./paths.js";
export function hashFile(filePath) {
    const bytes = readFileSync(filePath);
    return {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: statSync(filePath).size
    };
}
export function safeReadJson(filePath) {
    try {
        const text = readFileSync(filePath, "utf8");
        return {
            ok: true,
            data: JSON.parse(text),
            path: filePath,
            sha256: createHash("sha256").update(text, "utf8").digest("hex"),
            bytes: Buffer.byteLength(text, "utf8")
        };
    } catch (error) {
        const fileExists = existsSync(filePath);
        let rawSha = null;
        let rawBytes = null;
        if (fileExists) {
            try {
                const bytes = readFileSync(filePath);
                rawSha = createHash("sha256").update(bytes).digest("hex");
                rawBytes = bytes.byteLength;
            } catch  {
                rawSha = null;
                rawBytes = null;
            }
        }
        return {
            ok: false,
            code: fileExists ? "ERR_JSON_PARSE_FAILED" : "ERR_FILE_READ_FAILED",
            path: filePath,
            error: error.message,
            sha256: rawSha,
            bytes: rawBytes
        };
    }
}
function toPackagePath(filePath, packageRoot) {
    return path.relative(packageRoot, filePath).replace(/\\/g, "/");
}
export function walkPackageFiles(packageRoot = PACKAGE_ROOT) {
    return walkFiles(packageRoot).map((filePath)=>toPackagePath(filePath, packageRoot)).filter((relativePath)=>relativePath !== "manifest.json").sort((left, right)=>left.localeCompare(right));
}
function refusal(reason, options = {}) {
    return {
        verdict: "REFUSE",
        ok: false,
        code: "ERR_RELEASE_INTEGRITY_REFUSED",
        reason,
        manifest: options.manifest ?? null,
        provenance: options.provenance ?? null,
        checked_files: options.checkedFiles ?? 0,
        disk_files: options.diskFiles ?? 0,
        mismatches: options.mismatches ?? [],
        forbidden_artifacts: options.forbiddenArtifacts ?? [],
        custody_only: true,
        integrity_context: options.integrityContext ?? null
    };
}
export function verifyReleaseIntegrity(manifestPath = MANIFEST_PATH, packageRoot = PACKAGE_ROOT) {
    try {
        const resolvedManifestPath = manifestPath === MANIFEST_PATH && packageRoot !== PACKAGE_ROOT ? path.join(packageRoot, "manifest.json") : manifestPath;
        const diskFiles = existsSync(packageRoot) ? walkPackageFiles(packageRoot).length : 0;
        const manifestRead = safeReadJson(resolvedManifestPath);
        if (!manifestRead.ok) {
            return refusal(manifestRead.code === "ERR_FILE_READ_FAILED" ? "FILE_MISSING" : "MANIFEST_PARSE_FAILED", {
                diskFiles,
                integrityContext: {
                    file: path.basename(manifestPath),
                    path: manifestRead.path,
                    parse_code: manifestRead.code,
                    observed_sha256: manifestRead.sha256,
                    observed_bytes: manifestRead.bytes
                },
                mismatches: [
                    {
                        file: "manifest.json",
                        reason: manifestRead.code === "ERR_FILE_READ_FAILED" ? "missing" : "parse_failed",
                        expected: "valid_json",
                        actual: manifestRead.error
                    }
                ]
            });
        }
        const provenanceRead = safeReadJson(path.join(packageRoot, path.basename(PROVENANCE_PATH)));
        if (!provenanceRead.ok) {
            return refusal(provenanceRead.code === "ERR_FILE_READ_FAILED" ? "FILE_MISSING" : "PROVENANCE_PARSE_FAILED", {
                manifest: manifestRead.data,
                checkedFiles: manifestRead.data.artifacts?.length ?? 0,
                diskFiles,
                integrityContext: {
                    file: "provenance.json",
                    path: provenanceRead.path,
                    parse_code: provenanceRead.code,
                    observed_sha256: provenanceRead.sha256,
                    observed_bytes: provenanceRead.bytes
                },
                mismatches: [
                    {
                        file: "provenance.json",
                        reason: provenanceRead.code === "ERR_FILE_READ_FAILED" ? "missing" : "parse_failed",
                        expected: "valid_json",
                        actual: provenanceRead.error
                    }
                ]
            });
        }
        if (manifestRead.data?.schema_version !== "mnde.custody.manifest.v1") {
            return refusal("INVALID_MANIFEST_SCHEMA", {
                manifest: manifestRead.data,
                provenance: provenanceRead.data,
                checkedFiles: manifestRead.data?.artifacts?.length ?? 0,
                diskFiles,
                integrityContext: {
                    file: "manifest.json",
                    expected_schema: "mnde.custody.manifest.v1",
                    actual_schema: manifestRead.data?.schema_version ?? null
                },
                mismatches: [
                    {
                        file: "manifest.json",
                        reason: "invalid_schema",
                        expected: "mnde.custody.manifest.v1",
                        actual: manifestRead.data?.schema_version ?? null
                    }
                ]
            });
        }
        if (manifestRead.data?.package_type !== "custody-only") {
            return refusal("INVALID_PACKAGE_TYPE", {
                manifest: manifestRead.data,
                provenance: provenanceRead.data,
                checkedFiles: manifestRead.data?.artifacts?.length ?? 0,
                diskFiles,
                integrityContext: {
                    file: "manifest.json",
                    expected_package_type: "custody-only",
                    actual_package_type: manifestRead.data?.package_type ?? null
                },
                mismatches: [
                    {
                        file: "manifest.json",
                        reason: "invalid_package_type",
                        expected: "custody-only",
                        actual: manifestRead.data?.package_type ?? null
                    }
                ]
            });
        }
        const forbiddenArtifacts = scanForbiddenContent(packageRoot);
        if (forbiddenArtifacts.length > 0) {
            return refusal("FORBIDDEN_ARTIFACT_PRESENT", {
                manifest: manifestRead.data,
                provenance: provenanceRead.data,
                checkedFiles: manifestRead.data.artifacts.length,
                diskFiles,
                forbiddenArtifacts,
                integrityContext: {
                    file: forbiddenArtifacts[0]?.path ?? null,
                    reasons: forbiddenArtifacts[0]?.reasons ?? []
                }
            });
        }
        const artifacts = manifestRead.data.artifacts ?? [];
        const listedFiles = new Set(artifacts.map((artifact)=>artifact.file));
        for (const artifact of artifacts){
            const targetPath = path.join(packageRoot, artifact.file);
            if (!existsSync(targetPath)) {
                return refusal("FILE_MISSING", {
                    manifest: manifestRead.data,
                    provenance: provenanceRead.data,
                    checkedFiles: artifacts.length,
                    diskFiles,
                    integrityContext: {
                        file: artifact.file,
                        expected_sha256: artifact.sha256,
                        expected_bytes: artifact.bytes
                    },
                    mismatches: [
                        {
                            file: artifact.file,
                            reason: "missing",
                            expected: artifact.sha256,
                            actual: null
                        }
                    ]
                });
            }
            const actual = hashFile(targetPath);
            if (actual.sha256 !== artifact.sha256) {
                return refusal("MANIFEST_HASH_MISMATCH", {
                    manifest: manifestRead.data,
                    provenance: provenanceRead.data,
                    checkedFiles: artifacts.length,
                    diskFiles,
                    integrityContext: {
                        file: artifact.file,
                        expected_sha256: artifact.sha256,
                        observed_sha256: actual.sha256
                    },
                    mismatches: [
                        {
                            file: artifact.file,
                            reason: "sha256_mismatch",
                            expected: artifact.sha256,
                            actual: actual.sha256
                        }
                    ]
                });
            }
            if (actual.bytes !== artifact.bytes) {
                return refusal("MANIFEST_SIZE_MISMATCH", {
                    manifest: manifestRead.data,
                    provenance: provenanceRead.data,
                    checkedFiles: artifacts.length,
                    diskFiles,
                    integrityContext: {
                        file: artifact.file,
                        expected_bytes: artifact.bytes,
                        observed_bytes: actual.bytes
                    },
                    mismatches: [
                        {
                            file: artifact.file,
                            reason: "size_mismatch",
                            expected: artifact.bytes,
                            actual: actual.bytes
                        }
                    ]
                });
            }
        }
        for (const file of walkPackageFiles(packageRoot)){
            if (!listedFiles.has(file)) {
                return refusal("EXTRA_FILE", {
                    manifest: manifestRead.data,
                    provenance: provenanceRead.data,
                    checkedFiles: artifacts.length,
                    diskFiles,
                    integrityContext: {
                        file,
                        observed_sha256: hashFile(path.join(packageRoot, file)).sha256
                    },
                    mismatches: [
                        {
                            file,
                            reason: "extra",
                            expected: null,
                            actual: hashFile(path.join(packageRoot, file)).sha256
                        }
                    ]
                });
            }
        }
        return {
            verdict: "PASS",
            ok: true,
            code: "OK_RELEASE_INTEGRITY",
            reason: null,
            manifest: manifestRead.data,
            provenance: provenanceRead.data,
            checked_files: artifacts.length,
            disk_files: diskFiles,
            mismatches: [],
            forbidden_artifacts: [],
            custody_only: true,
            integrity_context: null
        };
    } catch (error) {
        return refusal("UNHANDLED_INTEGRITY_EXCEPTION", {
            integrityContext: {
                error: error.message
            }
        });
    }
}
export function assertReleaseIntegrity() {
    const result = verifyReleaseIntegrity();
    if (!result.ok) {
        const error = new Error(result.reason);
        error.code = result.code;
        error.integrity = result;
        throw error;
    }
    return result;
}
export function readPublishedHash(filePath, manifestPath = MANIFEST_PATH, packageRoot = PACKAGE_ROOT) {
    const manifestRead = safeReadJson(manifestPath);
    if (!manifestRead.ok) {
        return null;
    }
    const normalized = filePath.replace(/\\/g, "/");
    const artifact = (manifestRead.data.artifacts ?? []).find((entry)=>entry.file === normalized);
    if (!artifact) return null;
    const actual = hashFile(path.join(packageRoot, artifact.file));
    return {
        file: artifact.file,
        published_sha256: artifact.sha256,
        computed_sha256: actual.sha256,
        bytes: artifact.bytes,
        match: artifact.sha256 === actual.sha256 && artifact.bytes === actual.bytes
    };
}
