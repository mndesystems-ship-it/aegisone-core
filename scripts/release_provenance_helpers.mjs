import os from "node:os";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

function packedRefsLines(gitDir) {
  const packedRefsPath = path.join(gitDir, "packed-refs");
  if (!existsSync(packedRefsPath)) {
    return [];
  }
  return readFileSync(packedRefsPath, "utf8").split(/\r?\n/);
}

export function resolveGitDir(repoPath) {
  const gitPath = path.join(repoPath, ".git");
  if (!existsSync(gitPath)) {
    return null;
  }
  const stats = lstatSync(gitPath);
  if (stats.isDirectory()) {
    return gitPath;
  }
  if (!stats.isFile()) {
    return null;
  }
  const pointer = readFileSync(gitPath, "utf8").trim();
  const match = /^gitdir:\s*(.+)\s*$/i.exec(pointer);
  if (!match) {
    return null;
  }
  return path.resolve(repoPath, match[1]);
}

export function readGitCommit(repoPath) {
  const gitDir = resolveGitDir(repoPath);
  if (!gitDir) {
    return null;
  }
  const headPath = path.join(gitDir, "HEAD");
  if (!existsSync(headPath)) {
    return null;
  }
  const head = readFileSync(headPath, "utf8").trim();
  if (/^[0-9a-f]{40}$/i.test(head)) {
    return head;
  }
  if (!head.startsWith("ref: ")) {
    return null;
  }
  const refName = head.slice(5).trim();
  const refPath = path.join(gitDir, ...refName.split("/"));
  if (existsSync(refPath)) {
    return readFileSync(refPath, "utf8").trim();
  }
  for (const line of packedRefsLines(gitDir)) {
    if (!line || line.startsWith("#") || line.startsWith("^")) {
      continue;
    }
    const [hash, ref] = line.split(" ");
    if (ref === refName) {
      return hash ?? null;
    }
  }
  return null;
}

export function readGitTagForCommit(repoPath, commitHash) {
  if (!commitHash) {
    return null;
  }
  const gitDir = resolveGitDir(repoPath);
  if (!gitDir) {
    return null;
  }
  const tagsDir = path.join(gitDir, "refs", "tags");
  if (existsSync(tagsDir)) {
    const stack = [tagsDir];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (readFileSync(entryPath, "utf8").trim() === commitHash) {
          return path.relative(tagsDir, entryPath).replace(/\\/g, "/");
        }
      }
    }
  }
  let lastTagRef = null;
  for (const line of packedRefsLines(gitDir)) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("^")) {
      const peeled = line.slice(1).trim();
      if (lastTagRef && peeled === commitHash) {
        return lastTagRef.slice("refs/tags/".length);
      }
      lastTagRef = null;
      continue;
    }
    const [hash, ref] = line.split(" ");
    if (!ref?.startsWith("refs/tags/")) {
      lastTagRef = null;
      continue;
    }
    if (hash === commitHash) {
      return ref.slice("refs/tags/".length);
    }
    lastTagRef = ref;
  }
  return null;
}

export function buildProvenanceMetadata({
  packageVersion,
  gitCommitHash,
  releaseTag,
  nodeVersion,
  platform,
  arch
}) {
  const provenanceStatus = gitCommitHash ? (releaseTag ? "complete" : "partial") : "incomplete";
  const notes = [];
  if (!gitCommitHash) {
    notes.push("git commit hash unavailable");
  }
  if (gitCommitHash && !releaseTag) {
    notes.push("release tag unavailable");
  }
  return {
    schema_version: "mnde.custody.provenance.v1",
    release_version: packageVersion,
    release_tag: releaseTag,
    package_type: "custody-only",
    git_commit_hash: gitCommitHash,
    build_timestamp_utc: new Date().toISOString(),
    build_command: "npm run release:build",
    target_platform: platform,
    target_arch: arch,
    builder_identity: {
      user: process.env.USERNAME ?? process.env.USER ?? null,
      host: os.hostname()
    },
    toolchain: {
      node_version: nodeVersion,
      rust_version: "not-bundled",
      cargo_version: "not-bundled"
    },
    provenance_status: provenanceStatus,
    provenance_notes: notes
  };
}
