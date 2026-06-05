import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootstrapReceiptKeys } from "./bootstrap_dev_receipt_keys.mjs";

test("bootstrap creates local development receipt signing keys", () => {
  const root = mkdtempSync(join(tmpdir(), "mnde-bootstrap-"));
  try {
    const result = bootstrapReceiptKeys({ repoRoot: root });
    assert.equal(result.status, "created");
    assert.match(readFileSync(result.privateKeyPath, "utf8"), /BEGIN PRIVATE KEY/);
    assert.match(readFileSync(result.publicKeyPath, "utf8"), /BEGIN PUBLIC KEY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap refuses to overwrite existing receipt signing keys by default", () => {
  const root = mkdtempSync(join(tmpdir(), "mnde-bootstrap-"));
  try {
    const first = bootstrapReceiptKeys({ repoRoot: root });
    const originalPrivateKey = readFileSync(first.privateKeyPath, "utf8");
    const second = bootstrapReceiptKeys({ repoRoot: root });
    assert.equal(second.status, "exists");
    assert.equal(readFileSync(first.privateKeyPath, "utf8"), originalPrivateKey);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap overwrites receipt signing keys only when forced", () => {
  const root = mkdtempSync(join(tmpdir(), "mnde-bootstrap-"));
  try {
    const first = bootstrapReceiptKeys({ repoRoot: root });
    const originalPrivateKey = readFileSync(first.privateKeyPath, "utf8");
    const second = bootstrapReceiptKeys({ repoRoot: root, force: true });
    assert.equal(second.status, "created");
    assert.notEqual(readFileSync(first.privateKeyPath, "utf8"), originalPrivateKey);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
