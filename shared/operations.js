import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const OPS_ERRORS = Object.freeze({
  logPathUnavailable: "ERR_LOG_PATH_UNAVAILABLE",
  receiptArchiveFailed: "ERR_RECEIPT_ARCHIVE_FAILED",
  diskLow: "ERR_DISK_LOW",
  receiptWriteFailed: "ERR_RECEIPT_WRITE_FAILED",
  signatureTimeout: "ERR_SIGNATURE_TIMEOUT",
  policyRejected: "ERR_POLICY_REJECTED",
  invalidPolicySchema: "ERR_INVALID_POLICY_SCHEMA",
  policySignatureMismatch: "ERR_POLICY_SIGNATURE_MISMATCH",
  portBindFailed: "ERR_PORT_BIND_FAILED",
  serviceStartFailed: "ERR_SERVICE_START_FAILED"
});

export function opError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function rotateFile(filePath, maxBytes, maxFiles) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (!existsSync(filePath) || statSync(filePath).size < maxBytes) return { rotated: false };
  if (maxFiles <= 0) {
    unlinkSync(filePath);
    return { rotated: true };
  }
  const oldest = `${filePath}.${maxFiles}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    const target = `${filePath}.${index + 1}`;
    if (existsSync(source)) renameSync(source, target);
  }
  renameSync(filePath, `${filePath}.1`);
  return { rotated: true };
}

export function writeBoundedLog(logging, event) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
  try {
    rotateFile(logging.path, logging.max_bytes, logging.max_files);
    appendFileSync(logging.path, line, "utf8");
    return { ok: true, code: "OK_LOG_WRITTEN", warning: null };
  } catch (error) {
    const result = { ok: false, code: OPS_ERRORS.logPathUnavailable, warning: error.message };
    if (logging.required_for_audit_integrity) throw opError(OPS_ERRORS.logPathUnavailable, error.message, result);
    process.stderr.write(`${JSON.stringify({ event: "mnde.log", decision: "WARN", reason_code: OPS_ERRORS.logPathUnavailable, error: error.message })}\n`);
    return result;
  }
}

export function receiptCount(filePath) {
  if (!existsSync(filePath)) return 0;
  const text = readFileSync(filePath, "utf8").trim();
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function archiveName(activePath) {
  const base = path.basename(activePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base}.${stamp}.archive`;
}

export function rotateReceiptsIfNeeded(receipts) {
  mkdirSync(path.dirname(receipts.path), { recursive: true });
  mkdirSync(receipts.archive_path, { recursive: true });
  if (!existsSync(receipts.path)) return { rotated: false };
  const sizeExceeded = receipts.rotation_mode === "size" && statSync(receipts.path).size >= receipts.max_bytes;
  const countExceeded = receipts.rotation_mode === "count" && receiptCount(receipts.path) >= receipts.max_count;
  if (!sizeExceeded && !countExceeded) return { rotated: false };
  const target = path.join(receipts.archive_path, archiveName(receipts.path));
  try {
    renameSync(receipts.path, target);
    writeFileSync(receipts.path, "", { flag: "wx" });
    return { rotated: true, archive: target };
  } catch (error) {
    throw opError(OPS_ERRORS.receiptArchiveFailed, error.message, { archive_path: receipts.archive_path });
  }
}

export function appendReceiptRecord(receipts, record) {
  try {
    rotateReceiptsIfNeeded(receipts);
    appendFileSync(receipts.path, `${typeof record === "string" ? record : JSON.stringify(record)}\n`, "utf8");
    return { ok: true, code: "OK_RECEIPT_APPENDED" };
  } catch (error) {
    if (error.code === OPS_ERRORS.receiptArchiveFailed) throw error;
    throw opError(OPS_ERRORS.receiptWriteFailed, error.message, { path: receipts.path });
  }
}

export function checkDiskStatus(paths, threshold) {
  const free = typeof threshold.simulated_free_bytes === "number" ? threshold.simulated_free_bytes : os.freemem();
  const min = threshold.min_free_bytes ?? 0;
  const ok = free >= min;
  return {
    ok,
    code: ok ? "OK_DISK" : OPS_ERRORS.diskLow,
    free_bytes: free,
    min_free_bytes: min,
    monitored_paths: paths
  };
}

export function buildHealthState({ startup_state, manifest_ok, config_ok, log_status, receipt_store_status, disk_status, custody_status, signer_status }) {
  const criticalOk = Boolean(manifest_ok && config_ok && receipt_store_status.ok && disk_status.ok && custody_status.ok && signer_status.ok);
  return {
    ok: Boolean(config_ok && custody_status.ok),
    ready: criticalOk,
    startup_state,
    manifest_ok,
    config_ok,
    log_status,
    receipt_store_status,
    disk_status,
    custody_status,
    signer_status
  };
}
