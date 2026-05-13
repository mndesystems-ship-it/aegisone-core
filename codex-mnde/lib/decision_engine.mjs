import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIF+PaZSRVe1X82MhXGEPrReWxifRsZzGxG8K0VSNLPBS
-----END PRIVATE KEY-----`;

export const DEFAULT_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAOOUxTAAm04VBtiBuYm+gEcAybi0aIb1fOg6RgrqkGJ8=
-----END PUBLIC KEY-----`;

const PROMPT_REQUIRED = "PROMPT_REQUIRED";
const ALLOW = "ALLOW";
const REFUSE = "REFUSE";

export function canonicalize(value) {
  return canonicalJson(value);
}

export function hashCanonical(value) {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(path.resolve(filePath), "utf8"));
}

export function loadPolicy(policyPath = process.env.MNDE_CODEX_POLICY ?? path.resolve("codex_mnde_policy.json")) {
  if (!existsSync(policyPath)) {
    throw new Error(`ERR_POLICY_NOT_FOUND:${policyPath}`);
  }
  const policy = readJson(policyPath);
  const expected = policy.policy_hash;
  const actual = policyHash(policy);
  if (expected && expected !== actual) {
    throw new Error("ERR_POLICY_HASH_MISMATCH");
  }
  return { ...policy, policy_hash: expected ?? actual };
}

export function policyHash(policy) {
  const { policy_hash, signatures, ...hashable } = policy;
  return hashCanonical(hashable);
}

export function createDecisionRequest({
  argv,
  cwd,
  actor = "codex",
  tool = "shell",
  policyVersion = "v1",
  workspaceRoot = process.env.MNDE_WORKSPACE_ROOT ?? process.cwd(),
  estimatedCostUsdMicro,
  action = "shell.execute"
}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("ERR_EMPTY_COMMAND");
  }
  const normalizedCwd = normalizePath(cwd ?? process.cwd());
  const command = commandString(argv);
  return {
    action,
    actor,
    command,
    estimated_cost_usd_micro: Number.isInteger(estimatedCostUsdMicro)
      ? estimatedCostUsdMicro
      : estimateCostMicro(argv),
    policy_version: policyVersion,
    risk_level: riskLevelForCommand(argv),
    timestamp_removed: true,
    tool,
    working_directory: normalizedCwd,
    workspace_root: normalizePath(workspaceRoot)
  };
}

export function decide(request, policy) {
  validateDecisionRequest(request);
  const activePolicyHash = policyHash(policy);
  if (policy.policy_hash && policy.policy_hash !== activePolicyHash) {
    throw new Error("ERR_POLICY_HASH_MISMATCH");
  }
  if (request.policy_version !== policy.policy_version) {
    return buildDecision(request, policy, REFUSE, "ERR_POLICY_VERSION_MISMATCH");
  }
  if (!isInsideWorkspace(request.working_directory, request.workspace_root)) {
    return buildDecision(request, policy, REFUSE, "ERR_WORKDIR_OUTSIDE_WORKSPACE");
  }

  const command = normalizeCommandText(request.command);
  const lower = command.toLowerCase();

  for (const pattern of policy.refuse_patterns) {
    if (new RegExp(pattern.regex, "i").test(command)) {
      return buildDecision(request, policy, REFUSE, pattern.reason);
    }
  }
  for (const pattern of policy.prompt_required_patterns) {
    if (new RegExp(pattern.regex, "i").test(command)) {
      return buildDecision(request, policy, PROMPT_REQUIRED, pattern.reason);
    }
  }
  if (looksLikeNetwork(command) && !knownDomainAllowed(command, policy)) {
    return buildDecision(request, policy, REFUSE, "ERR_UNKNOWN_NETWORK_DOMAIN");
  }
  if (looksLikeManifestOrReceiptEdit(command)) {
    return buildDecision(request, policy, REFUSE, "ERR_PROTECTED_AUDIT_ARTIFACT");
  }
  if (lower.startsWith("git ")) {
    const git = decideGit(command, policy);
    if (git) return buildDecision(request, policy, git.decision, git.reason);
  }
  for (const pattern of policy.allow_patterns) {
    if (new RegExp(pattern.regex, "i").test(command)) {
      return buildDecision(request, policy, ALLOW, pattern.reason);
    }
  }
  return buildDecision(request, policy, PROMPT_REQUIRED, "PROMPT_UNCLASSIFIED_COMMAND");
}

export function buildDecision(request, policy, decision, reason) {
  const canonicalPayload = canonicalize(request);
  const requestHash = sha256Text(canonicalPayload);
  const decisionCore = {
    decision,
    policy_hash: policy.policy_hash ?? policyHash(policy),
    policy_version: policy.policy_version,
    reason,
    request_hash: requestHash
  };
  return {
    ...decisionCore,
    canonical_payload_hash: requestHash,
    decision_hash: hashCanonical(decisionCore)
  };
}

export function signReceipt({ request, decision, execution_status, exit_code = null, stdout_hash = null, stderr_hash = null }) {
  const payload = {
    canonical_payload_hash: decision.canonical_payload_hash,
    decision: decision.decision,
    decision_hash: decision.decision_hash,
    execution_status,
    exit_code,
    policy_version: decision.policy_version,
    reason: decision.reason,
    request,
    request_hash: decision.request_hash,
    schema_version: "mnde.codex.receipt.v1",
    stderr_hash,
    stdout_hash
  };
  const bytes = Buffer.from(canonicalize(payload), "utf8");
  const signature = sign(null, bytes, createPrivateKey(process.env.MNDE_RECEIPT_PRIVATE_KEY_PEM ?? DEFAULT_PRIVATE_KEY_PEM)).toString("base64");
  return {
    ...payload,
    signature: {
      alg: "Ed25519",
      key_id: "mnde-codex-local-v1",
      public_key_pem: DEFAULT_PUBLIC_KEY_PEM,
      value: signature
    }
  };
}

export function verifyReceiptSignature(receipt) {
  if (!receipt?.signature?.value) return false;
  const { signature, ...payload } = receipt;
  return verify(
    null,
    Buffer.from(canonicalize(payload), "utf8"),
    createPublicKey(signature.public_key_pem ?? DEFAULT_PUBLIC_KEY_PEM),
    Buffer.from(signature.value, "base64")
  );
}

function decideGit(command, policy) {
  if (/^git\s+push\b/i.test(command)) {
    if (/\s--force\b|\s-f\b|origin\s+main\b|origin\s+master\b/i.test(command)) {
      return { decision: REFUSE, reason: "ERR_GIT_PROTECTED_PUSH" };
    }
    return { decision: PROMPT_REQUIRED, reason: "PROMPT_GIT_PUSH" };
  }
  if (/^git\s+tag\b/i.test(command)) return { decision: PROMPT_REQUIRED, reason: "PROMPT_GIT_TAG" };
  if (/^git\s+reset\s+--hard\b/i.test(command)) return { decision: REFUSE, reason: "ERR_GIT_HISTORY_DELETE" };
  if (/^git\s+clean\b/i.test(command)) return { decision: REFUSE, reason: "ERR_GIT_CLEAN_REFUSED" };
  if (/^git\s+branch\s+-D\b/i.test(command)) return { decision: REFUSE, reason: "ERR_GIT_BRANCH_DELETE" };
  for (const pattern of policy.git_allow_patterns) {
    if (new RegExp(pattern.regex, "i").test(command)) {
      return { decision: ALLOW, reason: pattern.reason };
    }
  }
  return null;
}

function validateDecisionRequest(request) {
  const required = ["action", "command", "working_directory", "actor", "tool", "risk_level", "estimated_cost_usd_micro", "policy_version", "timestamp_removed"];
  for (const key of required) {
    if (!(key in request)) throw new Error(`ERR_DECISION_SCHEMA_MISSING_${key.toUpperCase()}`);
  }
  if (request.timestamp || request.created_at || request.nonce) throw new Error("ERR_NONDETERMINISTIC_FIELD");
  if (request.timestamp_removed !== true) throw new Error("ERR_TIMESTAMP_NOT_REMOVED");
  if (!Number.isInteger(request.estimated_cost_usd_micro)) throw new Error("ERR_COST_NOT_INTEGER_MICRO_USD");
  if (typeof request.command !== "string" || request.command.trim() === "") throw new Error("ERR_EMPTY_COMMAND");
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("ERR_NON_CANONICAL_NUMBER");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("ERR_UNSUPPORTED_JSON_TYPE");
}

function commandString(argv) {
  return argv.map((part) => {
    const text = String(part);
    return /[\s"]/u.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
  }).join(" ");
}

function estimateCostMicro(argv) {
  const command = argv.map(String).join(" ").toLowerCase();
  if (command.startsWith("git push")) return 5000;
  if (command.includes("deploy") || command.includes("terraform") || command.includes("kubectl")) return 25000;
  if (command.includes("npm install")) return 10000;
  return 1000;
}

function riskLevelForCommand(argv) {
  const command = argv.map(String).join(" ").toLowerCase();
  if (/git push|deploy|terraform apply|kubectl apply|docker compose up|rm\s+-rf|del\s+\/s|format\b/.test(command)) return "high";
  if (/npm install|npm update|git tag|git clean/.test(command)) return "medium";
  return "low";
}

function normalizePath(input) {
  return path.resolve(input).replaceAll("\\", "/");
}

function normalizeCommandText(command) {
  return command.trim().replace(/\s+/g, " ");
}

function isInsideWorkspace(cwd, root) {
  const relative = path.relative(path.resolve(root), path.resolve(cwd));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function looksLikeNetwork(command) {
  return /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|ssh|scp|rsync)\b/i.test(command);
}

function knownDomainAllowed(command, policy) {
  return (policy.allowed_network_domains ?? []).some((domain) => command.toLowerCase().includes(domain.toLowerCase()));
}

function looksLikeManifestOrReceiptEdit(command) {
  return /\b(receipts\.jsonl|manifest\.json|policy.*private|private\.pem|receipt_signing_private\.pem)\b/i.test(command)
    && /\b(del|rm|remove-item|set-content|add-content|out-file|>|>>|move-item|copy-item)\b/i.test(command);
}
