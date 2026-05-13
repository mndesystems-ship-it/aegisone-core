import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkCustodyStartup, logStartupResult } from "../custody/runtime.ts";
import { verifyReleaseIntegrity } from "../release/integrity.ts";

function withTempDir(prefix, run) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createValidPackage(root) {
  writeJson(path.join(root, "provenance.json"), {
    schema_version: "mnde.custody.provenance.v1",
    release_version: "1.0.0",
    release_tag: "v1.0.0",
    git_commit_hash: "a".repeat(40),
    build_timestamp_utc: "2026-01-01T00:00:00.000Z",
    target_platform: "win32",
    target_arch: "x64",
    toolchain: {
      node_version: "v22.0.0",
      rust_version: "not-bundled",
      cargo_version: "not-bundled"
    },
    artifacts: {},
    provenance_status: "complete",
    provenance_notes: []
  });
  writeJson(path.join(root, "manifest.json"), {
    schema_version: "mnde.custody.manifest.v1",
    generated_at: "2026-01-01T00:00:00.000Z",
    release_version: "1.0.0",
    package_type: "custody-only",
    immutable_after_publish: true,
    artifacts: [
      {
        file: "provenance.json",
        sha256: "placeholder",
        bytes: 0
      }
    ]
  });
}

function testMissingManifestFailsClosed() {
  withTempDir("mnde-integrity-", (root) => {
    writeJson(path.join(root, "provenance.json"), {
      schema_version: "mnde.custody.provenance.v1",
      release_version: "1.0.0",
      release_tag: "v1.0.0",
      git_commit_hash: "a".repeat(40),
      build_timestamp_utc: "2026-01-01T00:00:00.000Z",
      target_platform: "win32",
      target_arch: "x64",
      toolchain: { node_version: "v22.0.0", rust_version: "not-bundled", cargo_version: "not-bundled" },
      artifacts: {},
      provenance_status: "complete",
      provenance_notes: []
    });

    const result = verifyReleaseIntegrity(path.join(root, "manifest.json"), root);
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_RELEASE_INTEGRITY_REFUSED");
    assert.equal(result.reason, "FILE_MISSING");
  });
}

function testMalformedManifestReturnsDeterministicRefusal() {
  withTempDir("mnde-integrity-", (root) => {
    createValidPackage(root);
    writeFileSync(path.join(root, "manifest.json"), "{", "utf8");

    const integrity = verifyReleaseIntegrity(path.join(root, "manifest.json"), root);
    assert.equal(integrity.ok, false);
    assert.equal(integrity.code, "ERR_RELEASE_INTEGRITY_REFUSED");
    assert.equal(integrity.reason, "MANIFEST_PARSE_FAILED");

    const startup = checkCustodyStartup(root);
    assert.equal(startup.ok, false);
    assert.equal(startup.code, "ERR_RELEASE_INTEGRITY_REFUSED");
    assert.equal(startup.reason, "MANIFEST_PARSE_FAILED");
  });
}

function testMalformedProvenanceReturnsDeterministicRefusal() {
  withTempDir("mnde-integrity-", (root) => {
    createValidPackage(root);
    writeFileSync(path.join(root, "provenance.json"), "{", "utf8");

    const integrity = verifyReleaseIntegrity(path.join(root, "manifest.json"), root);
    assert.equal(integrity.ok, false);
    assert.equal(integrity.code, "ERR_RELEASE_INTEGRITY_REFUSED");
    assert.equal(integrity.reason, "PROVENANCE_PARSE_FAILED");
  });
}

function testStartupRefusalWritesDeterministicReceipt() {
  withTempDir("mnde-integrity-", (root) => {
    createValidPackage(root);
    writeFileSync(path.join(root, "manifest.json"), "{", "utf8");

    const startup = checkCustodyStartup(root);
    const configA = {
      receipts: {
        path: path.join(root, "receipts-a", "receipts.jsonl"),
        archive_path: path.join(root, "receipts-a", "archive"),
        rotation_mode: "size",
        max_bytes: 1024,
        max_count: 10
      }
    };
    const configB = {
      receipts: {
        path: path.join(root, "receipts-b", "receipts.jsonl"),
        archive_path: path.join(root, "receipts-b", "archive"),
        rotation_mode: "size",
        max_bytes: 1024,
        max_count: 10
      }
    };

    logStartupResult(startup, configA);
    logStartupResult(startup, configB);

    const receiptA = readFileSync(configA.receipts.path, "utf8").trim();
    const receiptB = readFileSync(configB.receipts.path, "utf8").trim();
    assert.equal(receiptA, receiptB);
    const parsed = JSON.parse(receiptA);
    assert.equal(parsed.decision, "REFUSE");
    assert.equal(parsed.reason_code, "MANIFEST_PARSE_FAILED");
  });
}

testMissingManifestFailsClosed();
testMalformedManifestReturnsDeterministicRefusal();
testMalformedProvenanceReturnsDeterministicRefusal();
testStartupRefusalWritesDeterministicReceipt();
process.stdout.write("PASS release integrity tests\n");
