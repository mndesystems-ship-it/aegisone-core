import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const FORBIDDEN_CONTENT_RULES = Object.freeze({
  extensions: [".pem", ".key", ".p12", ".pfx", ".der"],
  names: ["private_key", "signing_key", "secret"],
  directories: [
    "sidecar-local",
    "fixtures",
    "testdata",
    "mock",
    "sample_keys",
    "audit-bundle",
    "proof-bundle",
    "benchmark"
  ],
  files: [".env"],
  localConfigNames: ["local", "override", "overrides"]
});

const FORBIDDEN_TEXT_PATTERNS = Object.freeze([
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i, reason: "forbidden_content:private_key" },
  { pattern: /\bcreateHmac\s*\(/, reason: "forbidden_content:hmac_secret_signing" },
  { pattern: /\bcreatePrivateKey\s*\(/, reason: "forbidden_content:internal_private_key_loader" },
  { pattern: /\bSIGNING_SECRET\b/, reason: "forbidden_content:hmac_secret" },
  { pattern: /\bPRIVATE_KEY_PEM\b/, reason: "forbidden_content:internal_private_key" },
  { pattern: /\bsignReceiptPayload\s*\(/, reason: "forbidden_content:internal_signer_call" }
]);

function normalizeRelativePath(relativePath) {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function pathSegments(relativePath) {
  return normalizeRelativePath(relativePath)
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function extensionOf(segment) {
  const index = segment.lastIndexOf(".");
  return index === -1 ? "" : segment.slice(index);
}

export function forbiddenContentReasons(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const lower = normalized.toLowerCase();
  const segments = pathSegments(normalized);
  const basename = segments.at(-1) ?? "";
  const reasons = [];

  for (const extension of FORBIDDEN_CONTENT_RULES.extensions) {
    if (segments.some((segment) => segment.endsWith(extension))) {
      reasons.push(`forbidden_extension:${extension}`);
    }
  }

  for (const name of FORBIDDEN_CONTENT_RULES.names) {
    if (lower.includes(name)) {
      reasons.push(`forbidden_name:${name}`);
    }
  }

  for (const directory of FORBIDDEN_CONTENT_RULES.directories) {
    if (segments.includes(directory)) {
      reasons.push(`forbidden_directory:${directory}`);
    }
  }

  if (FORBIDDEN_CONTENT_RULES.files.includes(basename)) {
    reasons.push(`forbidden_file:${basename}`);
  }

  const ext = extensionOf(basename);
  if (
    basename.endsWith(".json") ||
    basename.endsWith(".js") ||
    basename.endsWith(".cmd") ||
    basename.endsWith(".ps1") ||
    basename.endsWith(".toml") ||
    basename.endsWith(".yaml") ||
    basename.endsWith(".yml") ||
    basename.endsWith(".ini") ||
    ext === ""
  ) {
    if (
      FORBIDDEN_CONTENT_RULES.localConfigNames.some((name) => basename.includes(name)) &&
      basename.includes("config")
    ) {
      reasons.push("forbidden_file:local_config_override");
    }
  }

  return [...new Set(reasons)];
}

function forbiddenContentTextReasons(filePath, relativePath) {
  if (normalizeRelativePath(relativePath).endsWith("shared/forbidden_content.js")) {
    return [];
  }
  let text;
  try {
    if (statSync(filePath).size > 1024 * 1024) {
      return [];
    }
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  return FORBIDDEN_TEXT_PATTERNS
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.reason);
}

export function isForbiddenContentPath(relativePath) {
  return forbiddenContentReasons(relativePath).length > 0;
}

export function relativePackagePath(rootDir, filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}

export function walkFiles(rootDir) {
  const output = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(nextPath);
      } else if (entry.isFile()) {
        output.push(nextPath);
      }
    }
  }
  return output.sort((left, right) => left.localeCompare(right));
}

export function scanForbiddenContent(rootDir) {
  return walkFiles(rootDir)
    .map((filePath) => ({
      path: relativePackagePath(rootDir, filePath),
      absolute_path: filePath,
      reasons: [
        ...forbiddenContentReasons(relativePackagePath(rootDir, filePath)),
        ...forbiddenContentTextReasons(filePath, relativePackagePath(rootDir, filePath))
      ],
      bytes: statSync(filePath).size
    }))
    .filter((entry) => entry.reasons.length > 0)
    .sort((left, right) => left.path.localeCompare(right.path));
}
