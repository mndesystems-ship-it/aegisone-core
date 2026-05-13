import { createHash, createPrivateKey, createPublicKey, sign } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { MANIFEST_PATH, PACKAGE_ROOT, PROVENANCE_PATH } from "./paths.js";
const DEFAULT_RELEASE_PUBLIC_KEY = "3daeda5811268def257d56e34a94fd7934d8bb4eb3d625e6f83cbc106e556330";
const DEFAULT_RELEASE_KEY_FINGERPRINT = "9873a7f3636ae58c92a75a0160fdf273fc28a97c0e6eb1f12761440a848fb783";

const EXCLUDED_FILES = new Set([
    "manifest.json"
]);

function toPackagePath(filePath) {
    return path.relative(PACKAGE_ROOT, filePath).replace(/\\/g, "/");
}

function walk(dir, files = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            walk(path.join(dir, entry.name), files);
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        const fullPath = path.join(dir, entry.name);
        const relativePath = toPackagePath(fullPath);
        if (!EXCLUDED_FILES.has(relativePath)) {
            files.push(fullPath);
        }
    }
    return files;
}

function hashFile(filePath) {
    const bytes = readFileSync(filePath);
    return {
        file: toPackagePath(filePath),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: statSync(filePath).size
    };
}
function canonicalizeJson(value) {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (Array.isArray(value)) return `[${value.map((item)=>canonicalizeJson(item)).join(",")}]`;
    if (typeof value === "object") {
        return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(",")}}`;
    }
    throw new Error("Unsupported JSON value");
}
function publicKeyRawHexFromPem(publicKeyPem) {
    const publicKey = createPublicKey(publicKeyPem);
    const der = publicKey.export({ format: "der", type: "spki" });
    return Buffer.from(der).subarray(-32).toString("hex");
}
function publicKeyRawHexFromPrivatePem(privateKeyPem) {
    return publicKeyRawHexFromPem(createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "pem", type: "spki" }));
}
function releaseKeyId(publicKeyHex) {
    return `release-ed25519-${createHash("sha256").update(Buffer.from(publicKeyHex, "hex")).digest("hex").slice(0, 16)}`;
}
function readReleaseSigningPrivateKey() {
    if (process.env.MNDE_RELEASE_SIGNING_PRIVATE_KEY_PEM) {
        return process.env.MNDE_RELEASE_SIGNING_PRIVATE_KEY_PEM;
    }
    if (process.env.MNDE_RELEASE_SIGNING_PRIVATE_KEY_FILE) {
        return readFileSync(path.resolve(process.env.MNDE_RELEASE_SIGNING_PRIVATE_KEY_FILE), "utf8");
    }
    const localFixtureKey = path.join(PACKAGE_ROOT, "app", "shared", "receipt_keys", "receipt_signing_private.pem");
    if (existsSync(localFixtureKey)) {
        return readFileSync(localFixtureKey, "utf8");
    }
    throw new Error("Release signing requires MNDE_RELEASE_SIGNING_PRIVATE_KEY_PEM or MNDE_RELEASE_SIGNING_PRIVATE_KEY_FILE.");
}
function signReleaseDocument(document, privateKeyPem) {
    const { signature: _signature, ...payload } = document;
    const public_key = publicKeyRawHexFromPrivatePem(privateKeyPem);
    if (public_key !== DEFAULT_RELEASE_PUBLIC_KEY) {
        throw new Error(`Release signing key is not in the allowed key list: ${public_key}`);
    }
    const canonicalPayload = canonicalizeJson(payload);
    return {
        ...payload,
        signature: {
            algorithm: "ED25519",
            key_id: releaseKeyId(public_key),
            public_key,
            value: sign(null, Buffer.from(canonicalPayload, "utf8"), createPrivateKey(privateKeyPem)).toString("hex")
        }
    };
}

function commandVersion(command, args) {
    try {
        return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return "unknown";
    }
}

const releaseVersion = process.env.MNDE_RELEASE_VERSION ?? "1.0.0";
const releaseTag = process.env.MNDE_RELEASE_TAG ?? `v${releaseVersion}`;
let previousProvenance = {};
try {
    previousProvenance = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8"));
} catch {
    previousProvenance = {};
}
const gitCommitHash = process.env.MNDE_RELEASE_COMMIT ?? (commandVersion("git", ["rev-parse", "HEAD"]) === "unknown" ? previousProvenance.git_commit_hash ?? "unknown" : commandVersion("git", ["rev-parse", "HEAD"]));
const buildTimestampUtc = new Date().toISOString();
const releaseSigningPrivateKey = readReleaseSigningPrivateKey();

let previousManifest = {};
try {
    previousManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch {
    previousManifest = {};
}
const publicKeyFingerprint = previousManifest.public_key_fingerprint ?? DEFAULT_RELEASE_KEY_FINGERPRINT;
const rustVersion = process.env.MNDE_RUST_VERSION ?? commandVersion("rustc", ["--version"]);
const cargoVersion = process.env.MNDE_CARGO_VERSION ?? commandVersion("cargo", ["--version"]);

const provenance = {
    schema_version: "mnde.release.provenance.v1",
    release_version: releaseVersion,
    release_tag: releaseTag,
    builder_identity: process.env.MNDE_BUILDER_IDENTITY ?? `${process.env.USERDOMAIN ?? "local"}\\${process.env.USERNAME ?? process.env.USER ?? "unknown"}`,
    build_machine: process.env.MNDE_BUILD_MACHINE ?? `${process.platform}/${process.arch}`,
    build_environment: process.env.MNDE_BUILD_ENVIRONMENT ?? "local",
    git_commit_hash: gitCommitHash,
    build_timestamp_utc: buildTimestampUtc,
    build_command: process.env.MNDE_BUILD_COMMAND ?? "node app/release/build_manifest.js",
    target_platform: process.platform,
    target_arch: process.arch,
    toolchain: {
        node_version: process.version,
        rust_version: rustVersion === "unknown" ? previousProvenance.toolchain?.rust_version ?? "unknown" : rustVersion,
        cargo_version: cargoVersion === "unknown" ? previousProvenance.toolchain?.cargo_version ?? "unknown" : cargoVersion
    },
    artifacts: {
        node_cli: "bin/mnde-node.cmd",
        sidecar: "bin/mnde-sidecar.cmd",
        sidecar_background: "bin/mnde-sidecar-background.cmd",
        example_client: "bin/mnde-example-client.cmd",
        verify_release: "bin/verify-release.cmd",
        verify_receipt: "bin/verify-receipt.cmd",
        audit_runner: "bin/run-audit.cmd",
        benchmark_runner: "bin/run-benchmark.cmd",
        bundled_node: "bin/node/node.exe",
        rust_parity_runner: "bin/rust/parity_runner.exe"
    },
    provenance_status: gitCommitHash === "unknown" ? "incomplete" : "complete",
    provenance_notes: gitCommitHash === "unknown" ? ["git commit hash unavailable in this package workspace"] : []
};

writeFileSync(PROVENANCE_PATH, `${JSON.stringify(signReleaseDocument(provenance, releaseSigningPrivateKey), null, 2)}\n`, "utf8");
const artifacts = walk(PACKAGE_ROOT).map(hashFile).sort((left, right) => left.file.localeCompare(right.file));
const manifest = {
    schema_version: "mnde.release.manifest.v1",
    generated_at: buildTimestampUtc,
    release_version: releaseVersion,
    immutable_after_publish: true,
    overwrite_existing_versions_allowed: false,
    public_key_fingerprint: publicKeyFingerprint,
    allowed_signing_key_ids: [
        releaseKeyId(DEFAULT_RELEASE_PUBLIC_KEY)
    ],
    artifacts
};
writeFileSync(MANIFEST_PATH, `${JSON.stringify(signReleaseDocument(manifest, releaseSigningPrivateKey), null, 2)}\n`, "utf8");
process.stdout.write(JSON.stringify({
    manifest: MANIFEST_PATH,
    provenance: PROVENANCE_PATH,
    artifact_count: artifacts.length,
    generated_at: buildTimestampUtc
}, null, 2) + "\n");
