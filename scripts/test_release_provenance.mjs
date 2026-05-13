import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildProvenanceMetadata,
  readGitCommit,
  readGitTagForCommit,
  resolveGitDir
} from "./release_provenance_helpers.mjs";

function withTempDir(prefix, run) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testResolveGitDirFromPointerFile() {
  withTempDir("mnde-git-", (root) => {
    const actualGitDir = path.join(root, ".git-worktrees", "main");
    mkdirSync(actualGitDir, { recursive: true });
    writeFileSync(path.join(root, ".git"), "gitdir: .git-worktrees/main\n", "utf8");
    assert.equal(resolveGitDir(root), actualGitDir);
  });
}

function testReadCommitFromWorktreePointer() {
  withTempDir("mnde-git-", (root) => {
    const actualGitDir = path.join(root, ".git-worktrees", "main");
    mkdirSync(path.join(actualGitDir, "refs", "heads"), { recursive: true });
    writeFileSync(path.join(root, ".git"), "gitdir: .git-worktrees/main\n", "utf8");
    writeFileSync(path.join(actualGitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(path.join(actualGitDir, "refs", "heads", "main"), `${"b".repeat(40)}\n`, "utf8");
    assert.equal(readGitCommit(root), "b".repeat(40));
  });
}

function testReadTagFromPackedRefs() {
  withTempDir("mnde-git-", (root) => {
    const gitDir = path.join(root, ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "HEAD"), `${"c".repeat(40)}\n`, "utf8");
    writeFileSync(
      path.join(gitDir, "packed-refs"),
      `# pack-refs with: peeled fully-peeled sorted\n${"c".repeat(40)} refs/tags/v1.2.3\n`,
      "utf8"
    );
    assert.equal(readGitTagForCommit(root, "c".repeat(40)), "v1.2.3");
  });
}

function testProvenanceStatusDoesNotOverclaim() {
  const complete = buildProvenanceMetadata({
    packageVersion: "1.0.0",
    gitCommitHash: "d".repeat(40),
    releaseTag: "v1.0.0",
    nodeVersion: "v22.0.0",
    platform: "win32",
    arch: "x64"
  });
  assert.equal(complete.provenance_status, "complete");

  const partial = buildProvenanceMetadata({
    packageVersion: "1.0.0",
    gitCommitHash: "d".repeat(40),
    releaseTag: null,
    nodeVersion: "v22.0.0",
    platform: "win32",
    arch: "x64"
  });
  assert.equal(partial.provenance_status, "partial");

  const incomplete = buildProvenanceMetadata({
    packageVersion: "1.0.0",
    gitCommitHash: null,
    releaseTag: null,
    nodeVersion: "v22.0.0",
    platform: "win32",
    arch: "x64"
  });
  assert.equal(incomplete.provenance_status, "incomplete");
}

testResolveGitDirFromPointerFile();
testReadCommitFromWorktreePointer();
testReadTagFromPackedRefs();
testProvenanceStatusDoesNotOverclaim();
process.stdout.write("PASS release provenance tests\n");
