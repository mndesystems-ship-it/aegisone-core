import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scanForbiddenContent, walkFiles } from "../shared/forbidden_content.js";
import { buildProvenanceMetadata, readGitCommit, readGitTagForCommit } from "./release_provenance_helpers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO_ROOT, "mnde-sidecar-custody-release");
const ZIP_PATH = path.join(REPO_ROOT, "mnde-sidecar-custody-release-v1.0.0-win32-x64.zip");
const VERIFY_EXTRACT = path.join(REPO_ROOT, ".tmp-sidecar-custody-verify");
const NODE_EXE = process.execPath;

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  writeFileSync(file, text, "utf8");
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function packagePath(file) {
  return path.relative(OUT_DIR, file).replace(/\\/g, "/");
}

function rawPublicKeyHex(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(der).subarray(-32).toString("hex");
}

function assertCleanPackage() {
  const forbidden = scanForbiddenContent(OUT_DIR);
  if (forbidden.length > 0) {
    process.stderr.write(`${JSON.stringify({ forbidden }, null, 2)}\n`);
    throw new Error("ERR_FORBIDDEN_ARTIFACT_PRESENT");
  }
}

function copyReleaseFiles(releasePublicKeyHex) {
  ensureDir(path.join(OUT_DIR, "app", "sidecar"));
  ensureDir(path.join(OUT_DIR, "app", "release"));
  ensureDir(path.join(OUT_DIR, "app", "shared"));
  cpSync(path.join(REPO_ROOT, "sidecar-custody", "server.js"), path.join(OUT_DIR, "app", "sidecar", "server.js"));
  cpSync(path.join(REPO_ROOT, "sidecar-custody", "verify-custody-receipt.js"), path.join(OUT_DIR, "app", "release", "verify-custody-receipt.js"));
  const verifier = readFileSync(path.join(REPO_ROOT, "sidecar-custody", "verify-release.js"), "utf8")
    .replace("__MNDE_RELEASE_PUBLIC_KEY_HEX__", releasePublicKeyHex);
  writeText(path.join(OUT_DIR, "app", "release", "verify-release.js"), verifier);
  cpSync(path.join(REPO_ROOT, "shared", "forbidden_content.js"), path.join(OUT_DIR, "app", "shared", "forbidden_content.js"));
  ensureDir(path.join(OUT_DIR, "bin", "node"));
  cpSync(NODE_EXE, path.join(OUT_DIR, "bin", "node", "node.exe"));

  writeText(path.join(OUT_DIR, "bin", "mnde-sidecar-custody.cmd"), [
    "@echo off",
    "setlocal",
    "\"%~dp0node\\node.exe\" \"%~dp0..\\app\\sidecar\\server.js\" %*"
  ].join("\r\n") + "\r\n");
  writeText(path.join(OUT_DIR, "bin", "verify-release.cmd"), [
    "@echo off",
    "setlocal",
    "\"%~dp0node\\node.exe\" \"%~dp0..\\app\\release\\verify-release.js\" %*"
  ].join("\r\n") + "\r\n");
  writeText(path.join(OUT_DIR, "bin", "verify-custody-receipt.cmd"), [
    "@echo off",
    "setlocal",
    "\"%~dp0node\\node.exe\" \"%~dp0..\\app\\release\\verify-custody-receipt.js\" %*"
  ].join("\r\n") + "\r\n");

  writeText(path.join(OUT_DIR, "README.md"), `# MNDe Sidecar Custody Release

This package combines MNDe execution-control sidecar behavior with custody-clean release hygiene.

Endpoints:

- GET /healthz
- GET /readyz
- POST /v1/decisions

Runtime state defaults to C:\\mnde-runtime and can be changed with --runtime-dir or MNDE_RUNTIME_DIR.

Production startup requires a valid customer custody signer config. If --signer-config or
MNDE_CUSTODY_SIGNER_CONFIG is not supplied, the sidecar looks for custody.signers.json in the
runtime directory and fails closed if it is missing or invalid. The sidecar never creates receipt
signing keys inside the runtime directory.

Supported signer modes:

- external_http
- aws_kms
- azure_key_vault
- gcp_cloud_kms
- offline_operator

Only external_http is executed directly by this package. Cloud and offline modes are accepted by
the schema for customer custody integration but return deterministic REFUSE until their adapters
are supplied by the deploying operator.
`);
  writeText(path.join(OUT_DIR, "docs", "INTEGRATION_QUICKSTART.md"), `# Integration Quickstart

Create a customer custody signer config outside the release tree:

\`\`\`json
{
  "key_set_version": "ksv_2026_01",
  "signers": [
    {
      "id": "customer-prod-signer-1",
      "mode": "external_http",
      "endpoint": "https://signer.customer.example/v1/sign",
      "public_key": "64 lowercase hex characters",
      "timeout_ms": 20,
      "latency_target_ms": 5,
      "latency_slo_ms": 15,
      "enabled": true
    }
  ],
  "threshold": 1
}
\`\`\`

Start:

\`\`\`powershell
.\\bin\\mnde-sidecar-custody.cmd --runtime-dir C:\\mnde-runtime --signer-config C:\\mnde-runtime\\custody.signers.json
\`\`\`

Call POST /v1/decisions before executing a job or tool call. Continue only when decision is ALLOW.
Receipts are written to the external runtime directory and verified with:

\`\`\`powershell
.\\bin\\verify-custody-receipt.cmd --config C:\\mnde-runtime\\custody.signers.json --receipt C:\\path\\to\\receipt.json
\`\`\`
`);
  writeText(path.join(OUT_DIR, "docs", "FAILURE_BEHAVIOR.md"), `# Failure Behavior

- Release integrity failure: startup refuses.
- Forbidden artifact in release tree: startup refuses.
- Missing or malformed custody signer config: startup refuses.
- Unknown signer mode, duplicate signer id, duplicate public key, or missing public key: startup refuses.
- Missing external_http endpoint: startup refuses.
- Custody signer timeout: deterministic REFUSE.
- Invalid signer response or signature verification failure: deterministic REFUSE.
- Unknown signer id or key set version: deterministic REFUSE.
- Invalid request body: request refuses.
- Risk threshold exceeded: decision REFUSE with a customer-custody signed receipt.
- Internal custody signing attempt: ERR_INTERNAL_SIGNING_DISABLED.
- Runtime logs and receipts are outside the release tree.
`);
  writeText(path.join(OUT_DIR, "docs", "CLEAN_ROOM_TEST.md"), `# Clean Room Test

Run from the repository:

\`\`\`powershell
powershell -ExecutionPolicy Bypass -File .\\scripts\\test_sidecar_custody_clean_room.ps1
\`\`\`

The script copies only mnde-sidecar-custody-release-v1.0.0-win32-x64.zip into C:\\mnde-clean-test\\input,
extracts it into C:\\mnde-clean-test\\release, uses C:\\mnde-clean-runtime for runtime state, and prints
MNDE_CUSTOMER_CUSTODY_CLEAN_ROOM_REPORT.
`);
}

function writeProvenance() {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const gitCommit = readGitCommit(REPO_ROOT) ?? process.env.MNDE_RELEASE_COMMIT ?? null;
  const releaseTag = readGitTagForCommit(REPO_ROOT, gitCommit) ?? process.env.MNDE_RELEASE_TAG ?? `v${pkg.version}`;
  const provenance = {
    ...buildProvenanceMetadata({
      packageVersion: pkg.version,
      gitCommitHash: gitCommit,
      releaseTag,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    }),
    package_type: "sidecar-custody",
    build_command: "node scripts/build_sidecar_custody_release.mjs",
    artifacts: {
      sidecar: "bin/mnde-sidecar-custody.cmd",
      verifier: "bin/verify-release.cmd",
      receipt_verifier: "bin/verify-custody-receipt.cmd",
      bundled_node: "bin/node/node.exe"
    }
  };
  writeText(path.join(OUT_DIR, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

function writeManifestAndSignature(privateKey) {
  const files = walkFiles(OUT_DIR)
    .map(packagePath)
    .filter((file) => file !== "manifest.json" && file !== "manifest.sig")
    .sort((left, right) => left.localeCompare(right));
  const manifest = {
    schema_version: "mnde.sidecar_custody.manifest.v1",
    release_version: "1.0.0",
    package_type: "sidecar-custody",
    immutable_after_publish: true,
    artifacts: files.map((file) => ({
      file,
      sha256: sha256File(path.join(OUT_DIR, file)),
      bytes: statSync(path.join(OUT_DIR, file)).size
    }))
  };
  writeText(path.join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sig = sign(null, readFileSync(path.join(OUT_DIR, "manifest.json")), privateKey).toString("hex");
  writeText(path.join(OUT_DIR, "manifest.sig"), `${sig}\n`);
  return manifest;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function zipTime() {
  return { time: 0, date: ((2026 - 1980) << 9) | (1 << 5) | 1 };
}

function writeZip(zipPath, rootDir) {
  const files = walkFiles(rootDir).map((file) => path.relative(rootDir, file).replace(/\\/g, "/"));
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, date } = zipTime();
  for (const file of files) {
    const name = Buffer.from(file, "utf8");
    const bytes = readFileSync(path.join(rootDir, file));
    const crc = crc32(bytes);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
      u32(crc), u32(bytes.length), u32(bytes.length), u16(name.length), u16(0), name, bytes
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
      u32(crc), u32(bytes.length), u32(bytes.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name
    ]));
    offset += local.length;
  }
  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralData.length), u32(localData.length), u16(0)
  ]);
  writeFileSync(zipPath, Buffer.concat([localData, centralData, end]));
}

function extractStoredZip(zipPath, targetDir) {
  const bytes = readFileSync(zipPath);
  let offset = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (method !== 0 || compressedSize !== uncompressedSize) throw new Error(`Unsupported zip entry: ${name}`);
    const out = path.join(targetDir, name);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, bytes.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }
}

async function zipAndVerify() {
  rmSync(ZIP_PATH, { force: true });
  rmSync(VERIFY_EXTRACT, { recursive: true, force: true });
  ensureDir(VERIFY_EXTRACT);
  writeZip(ZIP_PATH, OUT_DIR);
  extractStoredZip(ZIP_PATH, VERIFY_EXTRACT);
  const verifier = await import(pathToFileURL(path.join(VERIFY_EXTRACT, "app", "release", "verify-release.js")));
  const result = verifier.verifyReleaseIntegrity(VERIFY_EXTRACT);
  if (!result.ok) throw new Error(`fresh extract verification failed: ${JSON.stringify(result)}`);
  rmSync(VERIFY_EXTRACT, { recursive: true, force: true });
}

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  ensureDir(OUT_DIR);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  copyReleaseFiles(rawPublicKeyHex(publicKey));
  writeProvenance();
  assertCleanPackage();
  const manifest = writeManifestAndSignature(privateKey);
  assertCleanPackage();
  await zipAndVerify();
  process.stdout.write(`${JSON.stringify({
    artifact: ZIP_PATH,
    output_dir: OUT_DIR,
    files: manifest.artifacts.length,
    forbidden_artifacts: 0,
    fresh_extract_verify: "PASS"
  }, null, 2)}\n`);
}

await main();
