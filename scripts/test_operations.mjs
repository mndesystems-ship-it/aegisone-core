import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  appendReceiptRecord,
  buildHealthState,
  checkDiskStatus,
  OPS_ERRORS,
  rotateFile,
  writeBoundedLog
} from "../shared/operations.js";

const root = path.resolve("operations-test-output");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

function testLogRotation() {
  const log = path.join(root, "runtime.log");
  writeFileSync(log, "x".repeat(50));
  writeBoundedLog({ path: log, max_bytes: 20, max_files: 2, required_for_audit_integrity: false }, { event: "one" });
  writeFileSync(log, "y".repeat(50));
  writeBoundedLog({ path: log, max_bytes: 20, max_files: 2, required_for_audit_integrity: false }, { event: "two" });
  writeFileSync(log, "z".repeat(50));
  writeBoundedLog({ path: log, max_bytes: 20, max_files: 2, required_for_audit_integrity: false }, { event: "three" });
  assert.equal(existsSync(`${log}.1`), true);
  assert.equal(existsSync(`${log}.2`), true);
  assert.equal(existsSync(`${log}.3`), false);
}

function testReceiptArchive() {
  const receipts = {
    path: path.join(root, "receipts.jsonl"),
    archive_path: path.join(root, "archive"),
    rotation_mode: "count",
    max_bytes: 1024,
    max_count: 2
  };
  appendReceiptRecord(receipts, { receipt: 1 });
  appendReceiptRecord(receipts, { receipt: 2 });
  appendReceiptRecord(receipts, { receipt: 3 });
  const archives = readdirSync(receipts.archive_path);
  assert.equal(archives.length, 1);
  const archived = readFileSync(path.join(receipts.archive_path, archives[0]), "utf8");
  assert.match(archived, /"receipt":1/);
  assert.match(archived, /"receipt":2/);
  assert.match(readFileSync(receipts.path, "utf8"), /"receipt":3/);
}

function testDiskLowAndHealth() {
  const disk = checkDiskStatus([root], { min_free_bytes: 1000, simulated_free_bytes: 1 });
  assert.equal(disk.ok, false);
  assert.equal(disk.code, OPS_ERRORS.diskLow);
  const health = buildHealthState({
    startup_state: "READY",
    manifest_ok: true,
    config_ok: true,
    log_status: { ok: true, code: "OK_LOG" },
    receipt_store_status: { ok: false, code: OPS_ERRORS.diskLow },
    disk_status: disk,
    custody_status: { ok: true, code: "OK_CUSTODY" },
    signer_status: { ok: true, code: "OK_SIGNER" }
  });
  assert.equal(health.ready, false);
  assert.equal(health.disk_status.code, OPS_ERRORS.diskLow);
}

function testSignatureTimeoutHealth() {
  const health = buildHealthState({
    startup_state: "READY",
    manifest_ok: true,
    config_ok: true,
    log_status: { ok: true, code: "OK_LOG" },
    receipt_store_status: { ok: true, code: "OK_RECEIPTS" },
    disk_status: { ok: true, code: "OK_DISK" },
    custody_status: { ok: true, code: "OK_CUSTODY" },
    signer_status: { ok: false, code: OPS_ERRORS.signatureTimeout }
  });
  assert.equal(health.ready, false);
  assert.equal(health.signer_status.code, OPS_ERRORS.signatureTimeout);
}

testLogRotation();
testReceiptArchive();
testDiskLowAndHealth();
testSignatureTimeoutHealth();
rotateFile(path.join(root, "missing.log"), 1, 1);
process.stdout.write("PASS operations tests\n");
