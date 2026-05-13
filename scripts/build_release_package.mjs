import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  forbiddenContentReasons,
  scanForbiddenContent,
  walkFiles
} from "../shared/forbidden_content.js";
import {
  buildProvenanceMetadata,
  readGitCommit,
  readGitTagForCommit
} from "./release_provenance_helpers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(REPO_ROOT, "mnde-custody-release");
const APP_DIR = path.join(OUTPUT_DIR, "app");
const BIN_DIR = path.join(OUTPUT_DIR, "bin");
const CONFIG_DIR = path.join(OUTPUT_DIR, "config");
const EXAMPLES_DIR = path.join(OUTPUT_DIR, "examples");
const LIFECYCLE_DIR = path.join(OUTPUT_DIR, "lifecycle");
const NODE_EXECUTABLE = process.execPath;

const RUNTIME_SOURCE_FILES = [
  "release/cli.ts",
  "release/integrity.ts",
  "release/paths.ts",
  "release/provenance.ts",
  "release/verify_manifest.ts",
  "custody/runtime.ts",
  "shared/custody_keys.js",
  "shared/operations.js",
  "shared/forbidden_content.js",
  "shared/policy-trust.ts",
  "shared/json.ts"
];

const ROOT_COMMANDS = ["install.cmd", "start.cmd", "stop.cmd", "restart.cmd", "status.cmd", "uninstall.cmd"];
const LIFECYCLE_FILES = [
  "lifecycle/common.ps1",
  "lifecycle/install.ps1",
  "lifecycle/start.ps1",
  "lifecycle/stop.ps1",
  "lifecycle/restart.ps1",
  "lifecycle/status.ps1",
  "lifecycle/uninstall.ps1",
  "lifecycle/MNDeServiceHost.cs"
];

function rewriteTypeScriptImports(source) {
  return source.replace(
    /(["'])(\.[^"']+)\.ts\1/g,
    (_, quote, specifier) => `${quote}${specifier}.js${quote}`
  );
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function toPackagePath(filePath) {
  return path.relative(OUTPUT_DIR, filePath).replace(/\\/g, "/");
}

function sourceToOutputPath(relativeSourcePath) {
  const outputRelativePath = relativeSourcePath.replace(/\.ts$/i, ".js");
  return path.join(APP_DIR, outputRelativePath);
}

function isAllowedProductionPath(relativePath) {
  if (relativePath === "manifest.json" || relativePath === "provenance.json") {
    return true;
  }
  if (relativePath === "config/custody.config.template.json") {
    return true;
  }
  if (relativePath === "custody.md" || relativePath === "operator_runbook.md" || relativePath === "examples/custody_rotation_example.mjs") {
    return true;
  }
  if (ROOT_COMMANDS.includes(relativePath) || LIFECYCLE_FILES.includes(relativePath)) {
    return true;
  }
  if (
    relativePath === "bin/mnde-custody.cmd" ||
    relativePath === "bin/verify-custody-release.cmd" ||
    relativePath === "bin/preflight-check.cmd" ||
    relativePath === `bin/node/${path.basename(NODE_EXECUTABLE)}`
  ) {
    return true;
  }
  return [
    "app/release/cli.js",
    "app/release/integrity.js",
    "app/release/paths.js",
    "app/release/provenance.js",
    "app/release/verify_manifest.js",
    "app/custody/runtime.js",
    "app/shared/custody_keys.js",
    "app/shared/operations.js",
    "app/shared/forbidden_content.js",
    "app/shared/policy-trust.js",
    "app/shared/json.js"
  ].includes(relativePath);
}

function assertNoForbiddenSelected(paths) {
  const offenders = [];
  for (const relativePath of paths) {
    const reasons = forbiddenContentReasons(relativePath);
    if (reasons.length > 0) {
      offenders.push({ path: relativePath, reasons });
    }
  }
  if (offenders.length === 0) {
    return;
  }
  for (const offender of offenders) {
    process.stderr.write(`${offender.path} ${offender.reasons.join(",")}\n`);
  }
  throw new Error("ERR_FORBIDDEN_ARTIFACT_PRESENT");
}

function assertAllowedProductionPaths(paths) {
  const rejected = paths.filter((relativePath) => !isAllowedProductionPath(relativePath));
  if (rejected.length === 0) {
    return;
  }
  for (const relativePath of rejected) {
    process.stderr.write(`${relativePath}\n`);
  }
  throw new Error("ERR_RELEASE_ALLOWLIST_REJECTED");
}

function copyRuntimeSourceFiles() {
  const selectedPackagePaths = RUNTIME_SOURCE_FILES.map((relativeSourcePath) =>
    toPackagePath(sourceToOutputPath(relativeSourcePath))
  );
  assertNoForbiddenSelected(selectedPackagePaths);
  assertAllowedProductionPaths(selectedPackagePaths);

  for (const relativeSourcePath of RUNTIME_SOURCE_FILES) {
    const sourcePath = path.join(REPO_ROOT, relativeSourcePath);
    const outputPath = sourceToOutputPath(relativeSourcePath);
    ensureDir(path.dirname(outputPath));

    if (relativeSourcePath.endsWith(".ts")) {
      const source = readFileSync(sourcePath, "utf8");
      const transformed = stripTypeScriptTypes(source, { mode: "transform" });
      writeFileSync(outputPath, rewriteTypeScriptImports(transformed), "utf8");
    } else {
      cpSync(sourcePath, outputPath);
    }
  }
}

function copyRuntimeArtifacts() {
  const nodeOutputPath = path.join(BIN_DIR, "node", path.basename(NODE_EXECUTABLE));
  ensureDir(path.dirname(nodeOutputPath));
  cpSync(NODE_EXECUTABLE, nodeOutputPath);
}

function writeWrappers() {
  const wrappers = {
    "mnde-custody.cmd": [
      "@echo off",
      "setlocal",
      "\"%~dp0node\\node.exe\" \"%~dp0..\\app\\release\\cli.js\" %*"
    ].join("\r\n"),
    "verify-custody-release.cmd": [
      "@echo off",
      "setlocal",
      "\"%~dp0node\\node.exe\" \"%~dp0..\\app\\release\\cli.js\" verify-custody-release %*"
    ].join("\r\n"),
    "preflight-check.cmd": [
      "@echo off",
      "setlocal",
      "\"%~dp0node\\node.exe\" \"%~dp0..\\app\\release\\cli.js\" preflight-check %*"
    ].join("\r\n")
  };

  for (const [fileName, contents] of Object.entries(wrappers)) {
    writeFileSync(path.join(BIN_DIR, fileName), `${contents}\r\n`, "utf8");
  }
}

function copyConfigTemplate() {
  ensureDir(CONFIG_DIR);
  cpSync(path.join(REPO_ROOT, "config", "custody.config.template.json"), path.join(CONFIG_DIR, "custody.config.template.json"));
}

function copyCustodyDocsAndExamples() {
  cpSync(path.join(REPO_ROOT, "custody.md"), path.join(OUTPUT_DIR, "custody.md"));
  cpSync(path.join(REPO_ROOT, "operator_runbook.md"), path.join(OUTPUT_DIR, "operator_runbook.md"));
  ensureDir(EXAMPLES_DIR);
  const exampleSource = readFileSync(path.join(REPO_ROOT, "examples", "custody_rotation_example.mjs"), "utf8")
    .replace("../shared/custody_keys.js", "../app/shared/custody_keys.js");
  writeFileSync(path.join(EXAMPLES_DIR, "custody_rotation_example.mjs"), exampleSource, "utf8");
}

function copyLifecycleFiles() {
  for (const command of ROOT_COMMANDS) {
    cpSync(path.join(REPO_ROOT, command), path.join(OUTPUT_DIR, command));
  }
  ensureDir(LIFECYCLE_DIR);
  for (const relativePath of LIFECYCLE_FILES) {
    cpSync(path.join(REPO_ROOT, relativePath), path.join(OUTPUT_DIR, relativePath));
  }
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function writeProvenance() {
  const gitCommit = readGitCommit(REPO_ROOT) ?? process.env.MNDE_RELEASE_COMMIT ?? null;
  const releaseTag = readGitTagForCommit(REPO_ROOT, gitCommit) ?? process.env.MNDE_RELEASE_TAG ?? null;
  const provenance = {
    ...buildProvenanceMetadata({
      packageVersion: JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version,
      gitCommitHash: gitCommit,
      releaseTag,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    }),
    artifacts: {
      custody_runtime: "bin/mnde-custody.cmd",
      verifier: "bin/verify-custody-release.cmd",
      preflight: "bin/preflight-check.cmd",
      bundled_node: `bin/node/${path.basename(NODE_EXECUTABLE)}`
    },
    provenance_notes: [
      ...buildProvenanceMetadata({
        packageVersion: JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version,
        gitCommitHash: gitCommit,
        releaseTag,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch
      }).provenance_notes,
      "custody-only production package; no internal signing material is bundled"
    ]
  };
  const strictProvenance = process.env.STRICT_PROVENANCE ?? "true";
  if (strictProvenance === "true" && provenance.provenance_status !== "complete") {
    throw new Error(`STRICT_PROVENANCE requires complete provenance, got ${provenance.provenance_status}`);
  }
  writeFileSync(path.join(OUTPUT_DIR, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  return provenance;
}

function packageFilesForManifest() {
  return walkFiles(OUTPUT_DIR)
    .map((filePath) => toPackagePath(filePath))
    .filter((relativePath) => relativePath !== "manifest.json")
    .sort((left, right) => left.localeCompare(right));
}

function writeManifest() {
  const files = packageFilesForManifest();
  assertNoForbiddenSelected(files);
  assertAllowedProductionPaths(files);

  const manifest = {
    schema_version: "mnde.custody.manifest.v1",
    generated_at: new Date().toISOString(),
    release_version: JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version,
    package_type: "custody-only",
    immutable_after_publish: true,
    artifacts: files.map((relativePath) => ({
      file: relativePath,
      sha256: sha256File(path.join(OUTPUT_DIR, relativePath)),
      bytes: statSync(path.join(OUTPUT_DIR, relativePath)).size
    }))
  };
  writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function assertManifestMatchesExactly(manifest) {
  const diskFiles = packageFilesForManifest();
  const manifestFiles = manifest.artifacts.map((artifact) => artifact.file).sort((left, right) => left.localeCompare(right));
  const extra = diskFiles.filter((file) => !manifestFiles.includes(file));
  const missing = manifestFiles.filter((file) => !diskFiles.includes(file));
  const mismatched = [];

  for (const artifact of manifest.artifacts) {
    const filePath = path.join(OUTPUT_DIR, artifact.file);
    const actualSha = sha256File(filePath);
    const actualBytes = statSync(filePath).size;
    if (actualSha !== artifact.sha256 || actualBytes !== artifact.bytes) {
      mismatched.push(artifact.file);
    }
  }

  if (extra.length > 0 || missing.length > 0 || mismatched.length > 0) {
    process.stderr.write(`${JSON.stringify({ extra, missing, mismatched }, null, 2)}\n`);
    throw new Error("ERR_MANIFEST_DRIFT");
  }
}

function assertPackageClean() {
  const allFiles = walkFiles(OUTPUT_DIR).map((filePath) => toPackagePath(filePath));
  assertNoForbiddenSelected(allFiles);
  assertAllowedProductionPaths(allFiles);
  const forbidden = scanForbiddenContent(OUTPUT_DIR);
  if (forbidden.length > 0) {
    for (const offender of forbidden) {
      process.stderr.write(`${offender.path} ${offender.reasons.join(",")}\n`);
    }
    throw new Error("ERR_FORBIDDEN_ARTIFACT_PRESENT");
  }
}

function setReadOnlyRecursive(targetPath) {
  const mode = statSync(targetPath);
  if (mode.isDirectory()) {
    for (const entry of readdirSync(targetPath)) {
      setReadOnlyRecursive(path.join(targetPath, entry));
    }
    return;
  }
  if (mode.isFile()) {
    chmodSync(targetPath, 0o444);
  }
}

function publishImmutableDistribution(releaseVersion) {
  const distributionRoot = process.env.MNDE_RELEASE_DISTRIBUTION_DIR;
  if (!distributionRoot) {
    return null;
  }

  const releaseDir = path.join(path.resolve(distributionRoot), releaseVersion);
  if (existsSync(releaseDir)) {
    throw new Error(`Distribution version already exists and cannot be overwritten: ${releaseDir}`);
  }

  mkdirSync(path.dirname(releaseDir), { recursive: true });
  cpSync(OUTPUT_DIR, releaseDir, { recursive: true, errorOnExist: true, force: false });
  setReadOnlyRecursive(releaseDir);
  return releaseDir;
}

function main() {
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  ensureDir(OUTPUT_DIR);
  ensureDir(APP_DIR);
  ensureDir(BIN_DIR);

  copyRuntimeSourceFiles();
  copyRuntimeArtifacts();
  writeWrappers();
  copyConfigTemplate();
  copyCustodyDocsAndExamples();
  copyLifecycleFiles();
  const provenance = writeProvenance();
  assertPackageClean();
  const manifest = writeManifest();
  assertManifestMatchesExactly(manifest);
  const distribution_dir = publishImmutableDistribution(provenance.release_version);

  process.stdout.write(
    `${JSON.stringify(
      {
        output_dir: OUTPUT_DIR,
        distribution_dir,
        package_type: "custody-only",
        manifest: path.join(OUTPUT_DIR, "manifest.json"),
        total_file_count: manifest.artifacts.length + 1,
        forbidden_artifacts: 0
      },
      null,
      2
    )}\n`
  );
}

main();
