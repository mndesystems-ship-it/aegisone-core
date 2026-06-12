import type { AppLog, DecisionEvent, TelemetryState } from "../types";

const longHash = "sha256:" + "0123456789abcdef".repeat(12);
const longSignature = "ed25519:" + "abcdef0123456789".repeat(18);
const longUrl = "https://authority.mnde.local.example/reviewer/audit/bundles/2026/06/11/" + "very-long-path-segment-".repeat(10) + "receipt.json";
const longReason = "ERR_POLICY_REFUSED_DESTRUCTIVE_RECURSIVE_OPERATION_BECAUSE_BACKUP_RETENTION_AND_CUSTOMER_DATA_EXPORT_GUARDRAILS_MATCHED_MULTIPLE_RULES_WITH_ESCALATION_REQUIRED";
const longPolicy = "enterprise.production.customer-data.backups.database.deployments.exports.strict-authority-policy-version-" + "v12-".repeat(16);

export function isStressUiRequested() {
  return new URLSearchParams(window.location.search).has("stressUi");
}

export function makeStressTelemetry(base: TelemetryState): TelemetryState {
  const stressEvents = Array.from({ length: 24 }, (_, index) => makeStressEvent(index));
  return {
    ...base,
    systemState: "REFUSING",
    liveConnectionState: base.liveConnectionState,
    connectionState: "Stress UI mode: intentionally hostile text payloads are loaded for layout auditing.",
    statusMessage: "Stress UI mode: long receipts, hashes, authority names, policy names, JSON, URLs, signatures, and error text.",
    metrics: {
      ...base.metrics,
      policyName: longPolicy,
      policyHash: longHash,
      signerStatus: "Warning",
      uptime: "999999d 23h 59m with deliberately long uptime label",
      sidecarConnectionState: base.metrics.sidecarConnectionState
    },
    events: stressEvents,
    latestRefusal: stressEvents[0],
    proof: {
      ...base.proof,
      lastSignerHeartbeatMs: Date.now(),
      lastPolicyVerificationMs: Date.now(),
      lastReplayVerificationMs: Date.now(),
      lastSidecarContactMs: Date.now(),
      receiptPersistenceLagMs: 123456789,
      runtimeTelemetryAgeMs: 987654321
    },
    integrity: {
      ...base.integrity,
      activeKeySetFingerprint: longHash,
      signerKeyId: "receipt-key-" + "2026-q2-".repeat(12),
      receiptChainContinuity: "VALID",
      policySignatureStatus: "VALID",
      receiptSignatureValidity: "VALID",
      replayReproducibilityState: "VALID"
    }
  };
}

export function makeStressLogs(): AppLog[] {
  return Array.from({ length: 32 }, (_, index) => ({
    id: `stress-log-${index}`,
    timestamp: "23:59:59.999",
    severity: index % 5 === 0 ? "error" : index % 3 === 0 ? "warning" : "info",
    source: `stress-source-${"authority-validation-".repeat(4)}${index}`,
    message: `Long diagnostic message ${index}: ${longReason}. Authority=${longPolicy}. Receipt=${longHash}. Signature=${longSignature}. URL=${longUrl}. Multiline detail follows:\nline one has a very long hash ${longHash}\nline two has a long signature ${longSignature}`
  }));
}

function makeStressEvent(index: number): DecisionEvent {
  const refused = index % 2 === 0;
  return {
    id: `stress-${index}-${longHash}`,
    timestamp: "23:59:59.999",
    verdict: refused ? "REFUSE" : "ALLOW",
    action: `${refused ? "recursive_delete" : "read_status"} ${"customer-data/backups/production-database/".repeat(6)}${index}`,
    reason_code: refused ? longReason : `ALLOW_READ_ONLY_STATUS_WITH_LONG_REASON_CODE_${"SAFE_PATH_".repeat(10)}${index}`,
    explanation: `This explanation is intentionally long and multi-clause to prove text wrapping inside cards, tables, timelines, receipt inspectors, audit panels, and modals without overlapping adjacent UI. ${longUrl}`,
    risk_level: refused ? "CRITICAL" : "LOW",
    receipt_id: `receipt-${index}-${"0123456789abcdef".repeat(12)}`,
    policy: longPolicy,
    policy_hash: longHash,
    prevented_impact: `Protected backups, customer data, production database replicas, and export boundary. ${"Impact estimate segment ".repeat(12)}`,
    prevented_cost_usd: refused ? 9876543.21 : 0,
    signer_latency_ms: 987654321,
    queue_pressure: 99,
    replay_drift: 0,
    worker_saturation: 98,
    command_preview: `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${"Remove-Item -Recurse C:\\production\\customer-data\\backups\\".repeat(5)}"`,
    request_hash: longHash,
    decision_hash: longHash.split("").reverse().join(""),
    canonical_payload_hash: "canonical:" + "fedcba9876543210".repeat(12),
    signature_status: "VALID",
    replay_status: "VALID",
    policy_source: longUrl,
    signer_key_id: `receipt-key-${"long-key-id-".repeat(10)}`,
    receipt_chain_status: "VALID",
    raw_receipt: {
      schema_version: "ecs.receipt.v2",
      authority_name: `MNDe Stress Authority ${"Very Long Authority Name ".repeat(12)}`,
      authority_manifest_url: longUrl,
      receipt_id: `receipt-${index}-${"0123456789abcdef".repeat(12)}`,
      request_hash: longHash,
      decision_hash: longHash.split("").reverse().join(""),
      policy_name: longPolicy,
      policy_hash: longHash,
      signature: longSignature,
      reason_code: refused ? longReason : "OK_ALLOW",
      verification_report: {
        schema: "PASS",
        canonicalization: "PASS",
        request_hash: "PASS",
        decision_hash: "PASS",
        policy_hash: "PASS",
        signature: "PASS",
        replay_determinism: "PASS",
        large_nested_metadata: Array.from({ length: 12 }, (_, item) => ({
          index: item,
          hash: longHash,
          signature: longSignature,
          url: longUrl,
          message: "Large verification report line ".repeat(20)
        }))
      }
    }
  };
}
