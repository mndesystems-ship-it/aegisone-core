import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanForbiddenContent } from "../shared/forbidden_content.js";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifest.json");
const MANIFEST_SIG_PATH = path.join(PACKAGE_ROOT, "manifest.sig");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RELEASE_PUBLIC_KEY_HEX = "b5bb131daa8768707546bb26c7f30bff1b44b21ac377f536ac683a593fc13fd7";

function sha256File(filePath) {
  const bytes = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: statSync(filePath).size
  };
}

function publicKeyFromRawHex(publicKeyHex) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
    format: "der",
    type: "spki"
  });
}

function walkFiles(rootDir) {
  const output = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(next);
      if (entry.isFile()) output.push(path.relative(rootDir, next).replace(/\\/g, "/"));
    }
  }
  return output.sort((left, right) => left.localeCompare(right));
}

function verifyManifestSignature() {
  if (!existsSync(MANIFEST_PATH) || !existsSync(MANIFEST_SIG_PATH)) {
    return { ok: false, reason: "missing_manifest_or_signature" };
  }
  const manifestBytes = readFileSync(MANIFEST_PATH);
  const signature = Buffer.from(readFileSync(MANIFEST_SIG_PATH, "utf8").trim(), "hex");
  const ok = verify(null, manifestBytes, publicKeyFromRawHex(RELEASE_PUBLIC_KEY_HEX), signature);
  return ok ? { ok: true } : { ok: false, reason: "invalid_signature" };
}

export function verifyReleaseIntegrity(packageRoot = PACKAGE_ROOT) {
  const mismatches = [];
  const signature = verifyManifestSignature();
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(path.join(packageRoot, "manifest.json"), "utf8"));
  } catch (error) {
    return {
      verdict: "REFUSE",
      ok: false,
      release_signature: signature,
      manifest: null,
      checked_files: 0,
      disk_files: existsSync(packageRoot) ? walkFiles(packageRoot).length : 0,
      mismatches: [{ file: "manifest.json", reason: "parse_failed", actual: error.message }],
      forbidden_artifacts: []
    };
  }

  const forbiddenArtifacts = scanForbiddenContent(packageRoot);
  const artifacts = manifest.artifacts ?? [];
  const listed = new Set(artifacts.map((artifact) => artifact.file));
  for (const artifact of artifacts) {
    const target = path.join(packageRoot, artifact.file);
    if (!existsSync(target)) {
      mismatches.push({ file: artifact.file, reason: "missing", expected: artifact.sha256, actual: null });
      continue;
    }
    const actual = sha256File(target);
    if (actual.sha256 !== artifact.sha256) {
      mismatches.push({ file: artifact.file, reason: "sha256_mismatch", expected: artifact.sha256, actual: actual.sha256 });
    }
    if (actual.bytes !== artifact.bytes) {
      mismatches.push({ file: artifact.file, reason: "size_mismatch", expected: artifact.bytes, actual: actual.bytes });
    }
  }
  for (const file of walkFiles(packageRoot)) {
    if (file === "manifest.json" || file === "manifest.sig") continue;
    if (!listed.has(file)) {
      mismatches.push({ file, reason: "extra", expected: null, actual: sha256File(path.join(packageRoot, file)).sha256 });
    }
  }

  const ok = signature.ok && mismatches.length === 0 && forbiddenArtifacts.length === 0;
  return {
    verdict: ok ? "PASS" : "REFUSE",
    ok,
    release_signature: signature,
    manifest,
    checked_files: artifacts.length,
    disk_files: walkFiles(packageRoot).filter((file) => file !== "manifest.json" && file !== "manifest.sig").length,
    mismatches,
    forbidden_artifacts: forbiddenArtifacts
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyReleaseIntegrity();
  process.stdout.write(`${result.ok ? "PASS" : "REFUSE"}\n${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
