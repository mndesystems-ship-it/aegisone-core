import { strict as assert } from "node:assert";
import { test } from "node:test";

import { deriveLiveConnectionState, normalizePrometheusMetrics, normalizeReceipts } from "../src/api/sidecarClient.ts";
import { can, isSessionAllowedForMode, validateSession } from "../src/auth/model.ts";
import { deriveAuthorityScope, deriveTrustState, gateProtectedAction } from "../src/authority/trust.ts";
import { makeDisconnectedLiveTelemetry, makeInitialTelemetry, advanceTelemetry } from "../src/data/telemetry.ts";
import { buildSetupModel, mapReadableReason, generateGuidedSettings } from "../src/onboarding/setupModel.ts";
import { defaultSettings, sanitizeSettings } from "../src/data/settings.ts";
import { shouldAutoStartSidecar, shouldUseLiveModeOnDesktopStartup, startMndeLiveDemo } from "../src/desktop/sidecarControl.ts";

test("demo telemetry declares demo mode and generates refusal impact", () => {
  const telemetry = makeInitialTelemetry();
  assert.equal(telemetry.mode, "demo");
  assert.equal(telemetry.liveConnectionState, "DEMO_MODE");
  assert.ok(telemetry.events.some((event) => event.verdict === "REFUSE"));
  assert.ok(telemetry.events.some((event) => event.prevented_impact.includes("protected") || event.prevented_impact.includes("$")));
});

test("demo telemetry advances without live sidecar claims", () => {
  const next = advanceTelemetry(makeInitialTelemetry(), 8);
  assert.equal(next.mode, "demo");
  assert.equal(next.metrics.sidecarConnectionState, "DEMO_MODE");
  assert.match(next.statusMessage, /simulated/i);
});

test("disconnected live telemetry does not inherit demo or stale protection claims", () => {
  const previous = makeInitialTelemetry();
  const disconnected = makeDisconnectedLiveTelemetry(previous, false);

  assert.equal(disconnected.mode, "live");
  assert.equal(disconnected.systemState, "DISCONNECTED");
  assert.equal(disconnected.liveConnectionState, "DISCONNECTED");
  assert.equal(disconnected.metrics.uptime, "unavailable");
  assert.equal(disconnected.metrics.policyName, "unavailable");
  assert.equal(disconnected.metrics.policyHash, "unavailable");
  assert.equal(disconnected.metrics.decisionsPerSecond, 0);
  assert.equal(disconnected.resources.decisionThroughput, 0);
  assert.deepEqual(disconnected.events, []);
  assert.equal(disconnected.latestRefusal, undefined);
});

test("live receipt parser preserves reported fields", () => {
  const [receipt] = normalizeReceipts({
    receipts: [
      {
        receipt_id: "r-1",
        timestamp: "2026-05-18T00:00:00.000Z",
        verdict: "REFUSE",
        action: "recursive delete outside approved path",
        reason_code: "REFUSE_PATH_PROTECTION",
        explanation: "blocked",
        risk_level: "HIGH",
        policy: "filesystem.protect",
        policy_hash: "ph",
        request_hash: "rh",
        decision_hash: "dh",
        canonical_payload_hash: "ch",
        impact_estimate: "412 files protected"
      }
    ]
  });

  assert.equal(receipt.verdict, "REFUSE");
  assert.equal(receipt.reason_code, "REFUSE_PATH_PROTECTION");
  assert.equal(receipt.prevented_impact, "412 files protected");
  assert.equal(receipt.request_hash, "rh");
});

test("prometheus metrics text is accepted as live metrics", () => {
  const metrics = normalizePrometheusMetrics(`# TYPE mnde_decisions_total counter
mnde_decisions_total 9
mnde_decisions_allowed_total 7
mnde_decisions_refused_total 2
`);

  assert.equal(metrics.decisionsPerSecond, 9);
  assert.equal(metrics.allows, 7);
  assert.equal(metrics.refuses, 2);
  assert.equal(metrics.sidecarConnectionState, "CONNECTED");
});

test("missing receipt history does not make a healthy sidecar degraded", () => {
  const state = deriveLiveConnectionState({
    healthOk: true,
    readyOk: true,
    metricsOk: true,
    receiptsOk: false,
    hasRefusal: false
  });

  assert.equal(state, "CONNECTED");
});

test("refusal history does not make a healthy production sidecar refusing", () => {
  const state = deriveLiveConnectionState({
    healthOk: true,
    readyOk: true,
    metricsOk: true,
    receiptsOk: true,
    hasRefusal: true
  });

  assert.equal(state, "CONNECTED");
});

test("settings are sanitized for supported ranges", () => {
  const settings = sanitizeSettings({
    ...defaultSettings,
    mode: "live",
    pollIntervalMs: 1,
    requestTimeoutMs: 999999,
    receiptLimit: 999,
    demoEventRateMs: 1
  });

  assert.equal(settings.mode, "live");
  assert.equal(settings.pollIntervalMs, 1000);
  assert.equal(settings.requestTimeoutMs, 10000);
  assert.equal(settings.receiptLimit, 200);
  assert.equal(settings.demoEventRateMs, 500);
});

test("fresh settings open in live mode so the desktop app can start the sidecar", () => {
  assert.equal(defaultSettings.mode, "live");
});

test("desktop startup promotes saved demo settings to live once", () => {
  assert.equal(shouldUseLiveModeOnDesktopStartup({ isDesktop: true, mode: "demo", alreadyPromoted: false }), true);
  assert.equal(shouldUseLiveModeOnDesktopStartup({ isDesktop: true, mode: "demo", alreadyPromoted: true }), false);
  assert.equal(shouldUseLiveModeOnDesktopStartup({ isDesktop: false, mode: "demo", alreadyPromoted: false }), false);
  assert.equal(shouldUseLiveModeOnDesktopStartup({ isDesktop: true, mode: "live", alreadyPromoted: false }), false);
});

test("desktop runtime auto-starts the sidecar for live mode", () => {
  assert.equal(shouldAutoStartSidecar({ isDesktop: true, mode: "live", launchState: "idle" }), true);
});

test("auto-start does not loop after a launch attempt", () => {
  assert.equal(shouldAutoStartSidecar({ isDesktop: true, mode: "live", launchState: "starting" }), false);
  assert.equal(shouldAutoStartSidecar({ isDesktop: true, mode: "live", launchState: "started" }), false);
  assert.equal(shouldAutoStartSidecar({ isDesktop: true, mode: "live", launchState: "failed" }), false);
});

test("browser preview and demo mode do not auto-start the sidecar", () => {
  assert.equal(shouldAutoStartSidecar({ isDesktop: false, mode: "live", launchState: "idle" }), false);
  assert.equal(shouldAutoStartSidecar({ isDesktop: true, mode: "demo", launchState: "idle" }), false);
});

test("desktop live demo falls back when native start command is unavailable", async () => {
  const result = await startMndeLiveDemo({
    isTauriRuntime: () => true,
    invokeImpl: async () => {
      throw new Error("Command start_live_demo not found");
    },
    fetchImpl: async () => {
      throw new Error("dev server route unavailable");
    }
  });

  assert.equal(result.started, true);
  assert.match(result.message, /demo/i);
});

test("desktop live demo falls back when legacy native launcher is missing", async () => {
  const result = await startMndeLiveDemo({
    isTauriRuntime: () => true,
    invokeImpl: async () => {
      throw new Error("MNDe live demo launcher was not found in the local workspace.");
    },
    fetchImpl: async () => {
      throw new Error("dev server route unavailable");
    }
  });

  assert.equal(result.started, true);
  assert.match(result.message, /demo/i);
});

test("live mode accepts only non-expired enterprise identity", () => {
  const session = {
    user_id: "u-1",
    display_name: "Alex Operator",
    email: "alex@mnde.invalid",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    provider: "microsoft_entra",
    role: "OPERATOR",
    login_time: "2026-05-18T00:00:00.000Z",
    session_expiry: "2099-05-18T02:00:00.000Z"
  };
  const state = validateSession(session, Date.parse("2026-05-18T01:00:00.000Z"));
  assert.equal(state.kind, "authenticated");
  assert.equal(isSessionAllowedForMode(state.session, "live"), true);
  assert.equal(validateSession({ ...session, provider: "github" }, Date.parse("2026-05-18T01:00:00.000Z")).kind, "unauthenticated");
  assert.equal(validateSession({ ...session, session_expiry: "2026-05-17T23:00:00.000Z" }, Date.parse("2026-05-18T01:00:00.000Z")).kind, "expired");
});

test("desktop session accepts Rust millisecond timestamp strings", () => {
  const session = {
    user_id: "user-1",
    display_name: "Andrew Green",
    email: "mndesystems@gmail.com",
    tenant_id: "71c8162e-fc56-45e3-8b3b-7f11eed19758",
    provider: "microsoft_entra",
    role: "VIEWER",
    login_time: "1779586173000",
    session_expiry: "4102444800000"
  };
  const state = validateSession(session, 1779587000000);
  assert.equal(state.kind, "authenticated");
  assert.equal(isSessionAllowedForMode(state.session, "live"), true);
});

test("rbac role downgrade removes privileged authority", () => {
  const base = {
    user_id: "u-1",
    display_name: "Alex Operator",
    email: "alex@mnde.invalid",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    provider: "okta",
    login_time: "2026-05-18T00:00:00.000Z",
    session_expiry: "2099-05-18T02:00:00.000Z"
  } as const;
  assert.equal(can({ ...base, role: "ADMIN" }, "activate_policy"), true);
  assert.equal(can({ ...base, role: "OPERATOR" }, "activate_policy"), false);
  assert.equal(can({ ...base, role: "AUDITOR" }, "export_audit"), true);
  assert.equal(can({ ...base, role: "VIEWER" }, "verify_receipts"), false);
});

test("trust state refuses live authority when sidecar is disconnected", () => {
  const session = {
    user_id: "admin-1",
    display_name: "Admin",
    email: "admin@mnde.invalid",
    tenant_id: "tenant-1",
    provider: "microsoft_entra",
    role: "ADMIN",
    login_time: "1779586173000",
    session_expiry: "4102444800000"
  } as const;
  const trust = deriveTrustState({
    telemetry: makeDisconnectedLiveTelemetry(makeInitialTelemetry(), false),
    session,
    mode: "live",
    now: 1779587000000
  });

  assert.equal(trust.verdict, "DISCONNECTED");
  assert.ok(trust.causes.includes("disconnected sidecar"));
  assert.equal(gateProtectedAction("policy_activation", trust, deriveAuthorityScope(session)).allowed, false);
});

test("trust state degrades stale live telemetry and blocks protected actions", () => {
  const telemetry = {
    ...makeInitialTelemetry(),
    mode: "live" as const,
    systemState: "ACTIVE" as const,
    liveConnectionState: "CONNECTED" as const,
    connectionState: "MNDe sidecar connected.",
    metrics: {
      ...makeInitialTelemetry().metrics,
      signerStatus: "Healthy" as const,
      replayDrift: 0,
      queuePressure: 12,
      workerSaturation: 14,
      sidecarConnectionState: "CONNECTED" as const
    },
    proof: {
      lastSidecarContactMs: 1779586000000,
      lastSignerHeartbeatMs: 1779586000000,
      lastPolicyVerificationMs: 1779586000000,
      lastReplayVerificationMs: 1779586000000,
      receiptPersistenceLagMs: 0,
      runtimeTelemetryAgeMs: 1000000
    }
  };
  const session = {
    user_id: "admin-1",
    display_name: "Admin",
    email: "admin@mnde.invalid",
    tenant_id: "tenant-1",
    provider: "microsoft_entra",
    role: "ADMIN",
    login_time: "1779586173000",
    session_expiry: "1779590073000"
  } as const;

  const trust = deriveTrustState({ telemetry, session, mode: "live", now: 1779587000000 });
  assert.equal(trust.verdict, "UNVERIFIED");
  assert.ok(trust.causes.some((cause) => cause.includes("stale sidecar contact")));
  assert.equal(gateProtectedAction("runtime_enablement", trust, deriveAuthorityScope(session)).allowed, false);
});

test("authority scope exposes effective enterprise scopes instead of raw role labels", () => {
  const base = {
    user_id: "u-1",
    display_name: "User",
    email: "user@mnde.invalid",
    tenant_id: "tenant-1",
    provider: "microsoft_entra",
    login_time: "1779586173000",
    session_expiry: "4102444800000"
  } as const;
  assert.equal(deriveAuthorityScope({ ...base, role: "ADMIN" }).currentScope, "ORG_ADMIN");
  assert.equal(deriveAuthorityScope({ ...base, role: "OPERATOR" }).scopes.includes("RUNTIME_CONTROL"), true);
  assert.equal(deriveAuthorityScope({ ...base, role: "VIEWER" }).currentScope, "READ_ONLY");
  assert.equal(deriveAuthorityScope(undefined).currentScope, "LOCAL_ONLY");
});

test("setup model marks operational ready only when sidecar evidence and trust are trusted", () => {
  const telemetry = {
    ...makeInitialTelemetry(),
    mode: "live" as const,
    systemState: "ACTIVE" as const,
    liveConnectionState: "CONNECTED" as const,
    connectionState: "MNDe sidecar connected.",
    metrics: {
      ...makeInitialTelemetry().metrics,
      policyName: "policy.v1",
      policyHash: "abc123",
      signerStatus: "Healthy" as const,
      replayDrift: 0,
      queuePressure: 0,
      workerSaturation: 0,
      sidecarConnectionState: "CONNECTED" as const
    },
    proof: {
      lastSidecarContactMs: 1779587000000,
      lastSignerHeartbeatMs: 1779587000000,
      lastPolicyVerificationMs: 1779587000000,
      lastReplayVerificationMs: 1779587000000,
      receiptPersistenceLagMs: 0,
      runtimeTelemetryAgeMs: 0,
      healthEndpointOk: true,
      readyEndpointOk: true,
      metricsEndpointOk: true,
      receiptsEndpointOk: true
    },
    integrity: {
      receiptSignatureValidity: "VALID" as const,
      replayReproducibilityState: "VALID" as const,
      receiptChainContinuity: "VALID" as const,
      signerLatencyPosture: "Healthy" as const
    }
  };
  const trust = { ...deriveTrustState({ telemetry, mode: "live", now: 1779587000000 }), verdict: "TRUSTED" as const, causes: [], staleProofs: [] };
  const setup = buildSetupModel({ telemetry, trust, mode: "live", sidecarLaunchState: "started" });

  assert.equal(setup.operationalReady, true);
  assert.equal(setup.steps.every((step) => step.state === "pass"), true);
});

test("setup model blocks readiness on signer replay policy or sidecar failure", () => {
  const disconnected = makeDisconnectedLiveTelemetry(makeInitialTelemetry(), false);
  const disconnectedTrust = deriveTrustState({ telemetry: disconnected, mode: "live", now: 1779587000000 });
  const disconnectedSetup = buildSetupModel({ telemetry: disconnected, trust: disconnectedTrust, mode: "live", sidecarLaunchState: "failed" });
  assert.equal(disconnectedSetup.operationalReady, false);
  assert.equal(disconnectedSetup.steps.find((step) => step.id === "detect_sidecar")?.state, "fail");

  const replayUnsafe = {
    ...makeInitialTelemetry(),
    mode: "live" as const,
    liveConnectionState: "CONNECTED" as const,
    metrics: { ...makeInitialTelemetry().metrics, signerStatus: "Healthy" as const, policyName: "policy.v1", policyHash: "abc", replayDrift: 2, sidecarConnectionState: "CONNECTED" as const }
  };
  const replaySetup = buildSetupModel({ telemetry: replayUnsafe, trust: deriveTrustState({ telemetry: replayUnsafe, mode: "live" }), mode: "live", sidecarLaunchState: "started" });
  assert.equal(replaySetup.operationalReady, false);
  assert.equal(replaySetup.steps.find((step) => step.id === "verify_replay")?.state, "fail");

  const policyMissing = {
    ...replayUnsafe,
    metrics: { ...replayUnsafe.metrics, replayDrift: 0, policyName: "unavailable", policyHash: "unavailable" }
  };
  const policySetup = buildSetupModel({ telemetry: policyMissing, trust: deriveTrustState({ telemetry: policyMissing, mode: "live" }), mode: "live", sidecarLaunchState: "started" });
  assert.equal(policySetup.operationalReady, false);
  assert.equal(policySetup.steps.find((step) => step.id === "verify_policy")?.state, "fail");
});

test("readable reason mapping keeps technical details available without raw-only errors", () => {
  const mapped = mapReadableReason("ERR_ORBIT_MULTIPLE_ACTIONS");
  assert.match(mapped.summary, /multiple execution actions/i);
  assert.equal(mapped.technicalCode, "ERR_ORBIT_MULTIPLE_ACTIONS");
});

test("guided settings generate local UI configuration without switching demo into live proof", () => {
  const settings = generateGuidedSettings("developer_workstation", "strict_enforcement");
  assert.equal(settings.mode, "live");
  assert.equal(settings.enableAutoReconnect, true);
  assert.ok(settings.receiptLimit >= 50);
});
