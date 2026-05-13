import { createHash, createPrivateKey, createPublicKey, sign, verify } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { canonicalizeJson } from "../shared/index.js";
import { MANIFEST_PATH, PACKAGE_ROOT, PROVENANCE_PATH } from "./paths.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const ALLOWED_RELEASE_SIGNING_KEYS = [
    {
        key_id: "release-ed25519-9873a7f3636ae58c",
        public_key: "3daeda5811268def257d56e34a94fd7934d8bb4eb3d625e6f83cbc106e556330",
        fingerprint: "9873a7f3636ae58c92a75a0160fdf273fc28a97c0e6eb1f12761440a848fb783"
    }
];

function sha256Bytes(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

export function hashFile(filePath) {
    const bytes = readFileSync(filePath);
    return {
        sha256: sha256Bytes(bytes),
        bytes: statSync(filePath).size
    };
}

function publicKeyObjectFromRawHex(publicKeyHex) {
    return createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
        format: "der",
        type: "spki"
    });
}

function publicKeyRawHexFromPem(publicKeyPem) {
    const publicKey = createPublicKey(publicKeyPem);
    const der = publicKey.export({ format: "der", type: "spki" });
    return Buffer.from(der).subarray(-32).toString("hex");
}

export function releaseKeyId(publicKeyHex) {
    return `release-ed25519-${createHash("sha256").update(Buffer.from(publicKeyHex, "hex")).digest("hex").slice(0, 16)}`;
}

function payloadWithoutSignature(document) {
    const { signature: _signature, ...payload } = document;
    return payload;
}

export function signReleaseDocument(document, privateKeyPem) {
    const public_key = publicKeyRawHexFromPem(createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "pem", type: "spki" }));
    const key_id = releaseKeyId(public_key);
    const payload = canonicalizeJson(payloadWithoutSignature(document));
    return {
        ...document,
        signature: {
            algorithm: "ED25519",
            key_id,
            public_key,
            value: sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)).toString("hex")
        }
    };
}

export function verifyReleaseDocumentSignature(document, allowedKeys = ALLOWED_RELEASE_SIGNING_KEYS) {
    if (!document || typeof document !== "object" || Array.isArray(document)) {
        return { ok: false, reason: "document_not_object" };
    }
    const signature = document.signature;
    if (!signature || typeof signature !== "object" || Array.isArray(signature)) {
        return { ok: false, reason: "missing_signature" };
    }
    if (signature.algorithm !== "ED25519") {
        return { ok: false, reason: "unsupported_signature_algorithm" };
    }
    const allowed = allowedKeys.find((key) => key.key_id === signature.key_id && key.public_key === signature.public_key);
    if (!allowed) {
        return { ok: false, reason: "signing_key_not_allowed", key_id: signature.key_id ?? null };
    }
    if (releaseKeyId(signature.public_key) !== signature.key_id) {
        return { ok: false, reason: "signing_key_id_mismatch", key_id: signature.key_id };
    }
    if (typeof signature.value !== "string" || !/^[0-9a-fA-F]+$/.test(signature.value)) {
        return { ok: false, reason: "invalid_signature_encoding", key_id: signature.key_id };
    }
    const payload = canonicalizeJson(payloadWithoutSignature(document));
    const ok = verify(null, Buffer.from(payload, "utf8"), publicKeyObjectFromRawHex(signature.public_key), Buffer.from(signature.value, "hex"));
    return ok ? { ok: true, key_id: signature.key_id } : { ok: false, reason: "signature_mismatch", key_id: signature.key_id };
}

function toPackagePath(filePath, packageRoot) {
    return path.relative(packageRoot, filePath).replace(/\\/g, "/");
}

export function walkPackageFiles(packageRoot = PACKAGE_ROOT) {
    const output = [];
    const queue = [packageRoot];
    while (queue.length > 0) {
        const current = queue.pop();
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const nextPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(nextPath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            const relativePath = toPackagePath(nextPath, packageRoot);
            if (relativePath !== "manifest.json") {
                output.push(relativePath);
            }
        }
    }
    return output.sort((left, right) => left.localeCompare(right));
}

function verifyProvenance(provenancePath = PROVENANCE_PATH) {
    if (!existsSync(provenancePath)) {
        return { ok: false, reason: "missing_provenance" };
    }
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
    const signature = verifyReleaseDocumentSignature(provenance);
    return {
        ok: signature.ok,
        signature,
        provenance
    };
}

export function verifyReleaseIntegrity(manifestPath = MANIFEST_PATH, packageRoot = PACKAGE_ROOT) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const manifestSignature = verifyReleaseDocumentSignature(manifest);
    const provenance = verifyProvenance(path.join(packageRoot, "provenance.json"));
    const mismatches = [];
    const listedFiles = new Set((manifest.artifacts ?? []).map((artifact) => artifact.file));
    const listedByFile = new Map((manifest.artifacts ?? []).map((artifact) => [artifact.file, artifact]));

    for (const artifact of manifest.artifacts ?? []) {
        const targetPath = path.join(packageRoot, artifact.file);
        try {
            const actual = hashFile(targetPath);
            if (actual.sha256 !== artifact.sha256) {
                mismatches.push({
                    file: artifact.file,
                    reason: "sha256_mismatch",
                    expected: artifact.sha256,
                    actual: actual.sha256
                });
            }
            if (actual.bytes !== artifact.bytes) {
                mismatches.push({
                    file: artifact.file,
                    reason: "size_mismatch",
                    expected: artifact.bytes,
                    actual: actual.bytes
                });
            }
        } catch {
            mismatches.push({
                file: artifact.file,
                reason: "missing",
                expected: artifact.sha256,
                actual: null
            });
        }
    }

    for (const file of walkPackageFiles(packageRoot)) {
        if (!listedFiles.has(file)) {
            const actual = hashFile(path.join(packageRoot, file));
            mismatches.push({
                file,
                reason: "extra",
                expected: null,
                actual: actual.sha256
            });
        }
    }

    const manifestOnlyMissing = [...listedByFile.keys()].filter((file) => !existsSync(path.join(packageRoot, file)));
    const ok = manifestSignature.ok && provenance.ok && mismatches.length === 0 && manifestOnlyMissing.length === 0;
    return {
        verdict: ok ? "PASS" : "REFUSE",
        ok,
        manifest_signature: manifestSignature,
        provenance_signature: provenance.signature ?? { ok: false, reason: provenance.reason },
        manifest,
        checked_files: (manifest.artifacts ?? []).length,
        disk_files: walkPackageFiles(packageRoot).length,
        mismatches
    };
}

export function assertReleaseIntegrity() {
    const result = verifyReleaseIntegrity();
    if (!result.ok) {
        const error = new Error("ERR_RELEASE_INTEGRITY_REFUSED");
        error.integrity = result;
        throw error;
    }
    return result;
}

export function readPublishedHash(filePath, manifestPath = MANIFEST_PATH, packageRoot = PACKAGE_ROOT) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const normalized = filePath.replace(/\\/g, "/");
    const artifact = (manifest.artifacts ?? []).find((entry) => entry.file === normalized);
    if (!artifact) {
        return null;
    }
    const actual = hashFile(path.join(packageRoot, artifact.file));
    return {
        file: artifact.file,
        published_sha256: artifact.sha256,
        computed_sha256: actual.sha256,
        bytes: artifact.bytes,
        match: artifact.sha256 === actual.sha256 && artifact.bytes === actual.bytes
    };
}
