import { useEffect, useMemo, useRef, useState } from "react";
import { can, isSessionAllowedForMode, type AuthSession } from "./auth/model";
import { AccessPanel } from "./components/AccessPanel";
import { buildOperationalTimeline, deriveAuthorityScope, deriveTrustState, gateProtectedAction, type AuthorityScopeState, type TrustState } from "./authority/trust";
import { BottomHealthStrip } from "./components/BottomHealthStrip";
import { activatePolicy, generateAuditBundle, getCurrentPolicy, replayRecent } from "./api/sidecarClient";
import { DecisionFeed } from "./components/DecisionFeed";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { LoginScreen } from "./components/LoginScreen";
import { LogsPanel } from "./components/LogsPanel";
import { ModeBanner } from "./components/ModeBanner";
import { OnboardingPanel } from "./components/OnboardingPanel";
import { ReceiptDetail } from "./components/ReceiptDetail";
import { ResourcePanel } from "./components/ResourcePanel";
import { RiskPanel } from "./components/RiskPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SetupGuide } from "./components/SetupGuide";
import { Sidebar, type AppView } from "./components/Sidebar";
import { StatusCards } from "./components/StatusCards";
import { SystemHealth } from "./components/SystemHealth";
import { HeaderAuthorityPanel, TrustVerdictPanel } from "./components/TrustVerdictPanel";
import { TrustEvidencePanel } from "./components/TrustEvidencePanel";
import { OperationalTimeline } from "./components/OperationalTimeline";
import { buildSetupModel } from "./onboarding/setupModel";
import { isTauriRuntime, shouldAutoStartSidecar, shouldUseLiveModeOnDesktopStartup, startMndeSidecar, type SidecarLaunchState } from "./desktop/sidecarControl";
import { useOperationalTelemetry } from "./hooks/useOperationalTelemetry";
import { useAuth } from "./hooks/useAuth";
import { useSettings } from "./hooks/useSettings";
import type { AppLog, AppSettings, DecisionEvent, TelemetryState } from "./types";

export default function App() {
  const [settings, setSettings] = useSettings();
  const { auth, login, logout, setSession } = useAuth();
  const { telemetry, logs, setLogs } = useOperationalTelemetry(settings);
  const [selectedReceipt, setSelectedReceipt] = useState<DecisionEvent | undefined>();
  const [detailReceipt, setDetailReceipt] = useState<DecisionEvent | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeView, setActiveView] = useState<AppView>("Decision Stream");
  const [replayResult, setReplayResult] = useState<Record<string, unknown> | undefined>();
  const [policyResult, setPolicyResult] = useState<Record<string, unknown> | undefined>();
  const [auditResult, setAuditResult] = useState<Record<string, unknown> | undefined>();
  const [policyPath, setPolicyPath] = useState("");
  const [sidecarLaunchState, setSidecarLaunchState] = useState<SidecarLaunchState>("idle");
  const [sidecarLaunchMessage, setSidecarLaunchMessage] = useState<string | undefined>();
  const [diagnosticRunId, setDiagnosticRunId] = useState(0);
  const promotedDesktopStartupRef = useRef(false);
  const authorityReady = isSessionAllowedForMode(auth.session, settings.mode);
  const authorityScope = useMemo(() => deriveAuthorityScope(auth.session), [auth.session]);
  const trustState = useMemo(() => deriveTrustState({ telemetry, session: auth.session, mode: settings.mode }), [telemetry, auth.session, settings.mode]);
  const timelineEvents = useMemo(() => buildOperationalTimeline(telemetry, auth.session, trustState), [telemetry, auth.session, trustState]);
  const setupModel = useMemo(() => buildSetupModel({ telemetry, trust: trustState, mode: settings.mode, sidecarLaunchState }), [telemetry, trustState, settings.mode, sidecarLaunchState, diagnosticRunId]);

  useEffect(() => {
    const isDesktop = isTauriRuntime();
    if (settings.mode === "live" && !authorityReady) return;
    if (shouldUseLiveModeOnDesktopStartup({ isDesktop, mode: settings.mode, alreadyPromoted: promotedDesktopStartupRef.current })) {
      promotedDesktopStartupRef.current = true;
      setSettings({ ...settings, mode: "live" });
      return;
    }
    if (!shouldAutoStartSidecar({ isDesktop, mode: settings.mode, launchState: sidecarLaunchState })) return;
    void handleStartSidecar("auto");
  }, [settings.mode, sidecarLaunchState, authorityReady]);

  if (settings.mode === "live" && !authorityReady) {
    return (
      <LoginScreen
        auth={auth}
        environment="LOCAL"
        mode={settings.mode}
        onLogin={(provider) => {
          void login(provider);
        }}
        version="0.5.0"
      />
    );
  }

  async function handleStartSidecar(source: "auto" | "manual" = "manual") {
    setSidecarLaunchState("starting");
    setSidecarLaunchMessage(source === "auto" ? "Starting local sidecar..." : "Requesting local sidecar start...");
    const result = await startMndeSidecar();

    if (result.started) {
      setSidecarLaunchState("started");
      setSidecarLaunchMessage(result.message);
      setSettings({ ...settings, mode: "live" });
      window.setTimeout(() => setSidecarLaunchMessage(undefined), 8000);
      return;
    }

    setSidecarLaunchState(result.message.includes("Tauri desktop app") ? "unavailable" : "failed");
    setSidecarLaunchMessage(result.message);
  }

  function handleReconnect() {
    setSidecarLaunchMessage("Reconnect requested. Polling sidecar evidence...");
    setSettings({ ...settings, enableAutoReconnect: true, mode: "live" });
    setDiagnosticRunId((value) => value + 1);
    window.setTimeout(() => setSidecarLaunchMessage(undefined), 5000);
  }

  function handleRerunDiagnostics() {
    setSidecarLaunchMessage("Diagnostics re-run requested.");
    setDiagnosticRunId((value) => value + 1);
    window.setTimeout(() => setSidecarLaunchMessage(undefined), 5000);
  }

  return (
    <div className="relative flex h-screen min-h-[760px] overflow-hidden bg-[#080b0f] text-ink">
      <Sidebar activeView={activeView} connection={telemetry.connectionState} liveConnectionState={telemetry.liveConnectionState} mode={settings.mode} onViewChange={setActiveView} state={telemetry.systemState} />

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col gap-3 p-3">
            <header className="flex shrink-0 items-center justify-between border border-line bg-panel px-4 py-3">
              <div>
                <div className="text-xs uppercase tracking-[0.16em] text-muted">{settings.mode === "demo" ? "Simulated Safety Layer" : "Live Safety Layer"}</div>
                <h1 className="mt-1 text-xl font-semibold text-ink">Execution Firewall</h1>
              </div>
              <div className="flex items-center gap-6 text-sm">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.14em] text-muted">Estimated Prevented Impact</div>
                  <div className="mt-1 font-mono text-danger">{telemetry.latestRefusal?.prevented_impact ?? "not reported"}</div>
                  <div className="mt-0.5 text-[11px] text-muted">policy/runtime evidence only</div>
                </div>
                <TrustVerdictPanel authority={authorityScope} trust={trustState} />
                <HeaderAuthorityPanel authority={authorityScope} displayName={auth.session?.display_name} />
                <button className="button px-3" onClick={logout} type="button">Logout</button>
                <div className={`border px-3 py-2 text-xs font-semibold ${settings.mode === "demo" ? "border-warn/35 bg-warn/10 text-warn" : telemetry.liveConnectionState === "CONNECTED" ? "border-safe/35 bg-safe/10 text-safe" : "border-danger/35 bg-danger/10 text-danger"}`}>
                  {settings.mode === "demo" ? "simulated protection" : telemetry.liveConnectionState === "CONNECTED" ? "MNDe sidecar connected" : "no live protection status"}
                </div>
              </div>
            </header>

            <ModeBanner
              onOpenSettings={() => setSettingsOpen(true)}
              onStartSidecar={handleStartSidecar}
              authorityReady={authorityReady}
              settings={settings}
              sidecarLaunchMessage={sidecarLaunchMessage}
              sidecarLaunchState={sidecarLaunchState}
              telemetry={telemetry}
            />

            <ActiveWorkspace
              activeView={activeView}
              logs={logs}
              onClearLogs={() => setLogs([])}
              onOpenReceipt={setDetailReceipt}
              onReplayRecent={async () => setReplayResult(await replayRecent(settings, 100))}
              onActivatePolicy={async () => setPolicyResult(await activatePolicy(settings, policyPath))}
              onRefreshPolicy={async () => setPolicyResult(await getCurrentPolicy(settings))}
              onGenerateAudit={async () => setAuditResult(await generateAuditBundle(settings))}
              onOpenAuditFolder={async () => {
                if (!auditResult?.bundle_path || !("__TAURI_INTERNALS__" in window)) return;
                const { invoke } = await import("@tauri-apps/api/core");
                await invoke("open_audit_bundle_folder", { path: String(auditResult.bundle_path) });
              }}
              onReceiptClick={(event) => { setSelectedReceipt(event); setDetailReceipt(event); }}
              onStartSidecar={handleStartSidecar}
              onReconnect={handleReconnect}
              onRerunDiagnostics={handleRerunDiagnostics}
              policyPath={policyPath}
              onPolicyPathChange={setPolicyPath}
              replayResult={replayResult}
              policyResult={policyResult}
              auditResult={auditResult}
              selectedReceipt={selectedReceipt}
              sidecarLaunchState={sidecarLaunchState}
              telemetry={telemetry}
              authSession={auth.session}
              onSessionChange={setSession}
              trustState={trustState}
              authorityScope={authorityScope}
              timelineEvents={timelineEvents}
              setupModel={setupModel}
              settings={settings}
              onSettingsChange={setSettings}
            />
          </section>

          <RiskPanel latestRefusal={telemetry.latestRefusal} onOpenReceipt={setDetailReceipt} selectedReceipt={selectedReceipt} />
        </div>

        <BottomHealthStrip health={telemetry.health} />
      </main>
      <ReceiptDetail onClose={() => setDetailReceipt(undefined)} receipt={detailReceipt} settings={settings} />
      <SettingsPanel onChange={setSettings} onClose={() => setSettingsOpen(false)} open={settingsOpen} settings={settings} />
    </div>
  );
}

interface ActiveWorkspaceProps {
  activeView: AppView;
  telemetry: TelemetryState;
  logs: AppLog[];
  sidecarLaunchState: SidecarLaunchState;
  selectedReceipt?: DecisionEvent;
  replayResult?: Record<string, unknown>;
  policyResult?: Record<string, unknown>;
  auditResult?: Record<string, unknown>;
  policyPath: string;
  onStartSidecar: () => void;
  onReconnect: () => void;
  onRerunDiagnostics: () => void;
  onReceiptClick: (event: DecisionEvent) => void;
  onOpenReceipt: (event: DecisionEvent) => void;
  onClearLogs: () => void;
  onReplayRecent: () => Promise<void>;
  onRefreshPolicy: () => Promise<void>;
  onActivatePolicy: () => Promise<void>;
  onGenerateAudit: () => Promise<void>;
  onOpenAuditFolder: () => Promise<void>;
  onPolicyPathChange: (value: string) => void;
  authSession?: AuthSession;
  onSessionChange: (session: AuthSession) => void;
  trustState: TrustState;
  authorityScope: AuthorityScopeState;
  timelineEvents: ReturnType<typeof buildOperationalTimeline>;
  setupModel: ReturnType<typeof buildSetupModel>;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

function ActiveWorkspace({ activeView, telemetry, logs, sidecarLaunchState, selectedReceipt, replayResult, policyResult, auditResult, policyPath, onStartSidecar, onReconnect, onRerunDiagnostics, onReceiptClick, onOpenReceipt, onClearLogs, onReplayRecent, onRefreshPolicy, onActivatePolicy, onGenerateAudit, onOpenAuditFolder, onPolicyPathChange, authSession, onSessionChange, trustState, authorityScope, timelineEvents, setupModel, settings, onSettingsChange }: ActiveWorkspaceProps) {
  const liveAuthority = telemetry.mode === "live";
  const policyGate = gateProtectedAction("policy_activation", trustState, authorityScope);
  const runtimeGate = gateProtectedAction("runtime_enablement", trustState, authorityScope);
  const replayGate = gateProtectedAction("replay_approval_override", trustState, authorityScope);
  const authorityGate = gateProtectedAction("authority_changes", trustState, authorityScope);
  const canActivatePolicy = liveAuthority && can(authSession, "activate_policy") && policyGate.allowed;
  const canReplay = liveAuthority && can(authSession, "replay_decisions") && replayGate.allowed;
  const canExportAudit = liveAuthority && can(authSession, "export_audit");

  if (activeView === "Setup") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <OnboardingPanel
          setup={setupModel}
          settings={settings}
          onSettingsChange={onSettingsChange}
          onStartSidecar={onStartSidecar}
          onReconnect={onReconnect}
          onReloadPolicy={onRefreshPolicy}
          onVerifyReplay={onReplayRecent}
          onRerunDiagnostics={onRerunDiagnostics}
          onOpenDemo={() => onSettingsChange({ ...settings, mode: "demo" })}
        />
        <DiagnosticsPanel
          setup={setupModel}
          telemetry={telemetry}
          trust={trustState}
          onStartSidecar={onStartSidecar}
          onReconnect={onReconnect}
          onReloadPolicy={onRefreshPolicy}
          onVerifyReplay={onReplayRecent}
          onRerunDiagnostics={onRerunDiagnostics}
        />
      </div>
    );
  }
  if (activeView === "Receipts") {
    return (
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_296px] gap-3">
        <DecisionFeed events={telemetry.events} onReceiptClick={onReceiptClick} />
        <section className="border border-line bg-panel p-4">
          <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Receipt Inspector</div>
          <h2 className="mt-2 text-lg font-semibold text-ink">{selectedReceipt ? selectedReceipt.receipt_id : "No receipt selected"}</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            {telemetry.events.length === 0 ? "This sidecar does not expose receipt history yet. New live decisions will appear here when the receipt endpoint is available." : "Select a receipt from the stream to inspect its hashes and verification state."}
          </p>
          {selectedReceipt ? (
            <button className="mt-4 h-9 w-full border border-signal/40 bg-signal/10 text-sm font-semibold text-signal transition hover:bg-signal/15 hover:text-ink" onClick={() => onOpenReceipt(selectedReceipt)}>
              Open Receipt Detail
            </button>
          ) : null}
        </section>
      </div>
    );
  }

  if (activeView === "Policies") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <SetupGuide onStartSidecar={onStartSidecar} sidecarLaunchState={sidecarLaunchState} startGate={runtimeGate} />
        <section className="border border-line bg-panel p-4">
          <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Policy Activation</div>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
            <input aria-label="Policy file path" className="input" value={policyPath} onChange={(event) => onPolicyPathChange(event.target.value)} />
            <button className="button px-3" onClick={onRefreshPolicy}>Refresh Current</button>
            <button className="button signal px-3 disabled:cursor-not-allowed disabled:opacity-45" disabled={!canActivatePolicy} onClick={onActivatePolicy}>Activate Policy</button>
          </div>
          {!canActivatePolicy ? <p className="mt-2 text-xs text-danger">Policy activation blocked: {policyGate.reason}</p> : null}
          <pre className="mt-3 max-h-32 overflow-auto border border-line bg-[#080b0f] p-3 text-xs text-muted">{JSON.stringify(policyResult ?? { status: "not checked", policy: telemetry.metrics.policyName, policy_hash: telemetry.metrics.policyHash }, null, 2)}</pre>
        </section>
        <TrustEvidencePanel trust={trustState} />
        <StatusCards metrics={telemetry.metrics} />
      </div>
    );
  }

  if (activeView === "Replay") {
    return (
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_296px] gap-3">
        <section className="border border-line bg-panel p-4">
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Replay Status</div>
            <button className="button signal px-3 disabled:cursor-not-allowed disabled:opacity-45" disabled={!canReplay} onClick={onReplayRecent}>Replay Last 100 Decisions</button>
          </div>
          {!canReplay ? <p className="mt-3 text-xs text-danger">Replay override blocked: {replayGate.reason}</p> : null}
          <div className="mt-4 grid grid-cols-2 gap-3">
            <StatusTile label="Status" value={String(replayResult?.status ?? "not run")} />
            <StatusTile label="Checked" value={String(replayResult?.checked ?? 0)} />
            <StatusTile label="Drift" value={String(replayResult?.drift ?? telemetry.metrics.replayDrift)} />
            <StatusTile label="Signature Failures" value={String(replayResult?.signature_failures ?? 0)} />
          </div>
          <pre className="mt-3 max-h-44 overflow-auto border border-line bg-[#080b0f] p-3 text-xs text-muted">{JSON.stringify(replayResult ?? { status: "not run" }, null, 2)}</pre>
        </section>
        <SystemHealth health={telemetry.health} />
      </div>
    );
  }

  if (activeView === "Runtime") {
    return (
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_296px] gap-3">
        <div className="flex min-h-0 flex-col gap-3">
          <StatusCards metrics={telemetry.metrics} />
          <LogsPanel logs={logs} onClear={onClearLogs} />
        </div>
        <div className="flex min-h-0 flex-col gap-3">
          <AuthorityContextPanel authSession={authSession} telemetry={telemetry} authority={authorityScope} trust={trustState} />
          <SystemHealth health={telemetry.health} />
          <TrustEvidencePanel trust={trustState} />
          <ResourcePanel resources={telemetry.resources} />
        </div>
      </div>
    );
  }

  if (activeView === "Audit") {
    return (
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_296px] gap-3">
        <div className="flex min-h-0 flex-col gap-3">
          <LogsPanel logs={logs} onClear={onClearLogs} />
          <OperationalTimeline events={timelineEvents} />
        </div>
        <section className="border border-line bg-panel p-4">
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Audit Summary</div>
            <div className="flex gap-2">
              <button className="button px-3" disabled={!auditResult?.bundle_path || !canExportAudit} onClick={onOpenAuditFolder}>Open Folder</button>
              <button className="button signal px-3 disabled:cursor-not-allowed disabled:opacity-45" disabled={!canExportAudit} onClick={onGenerateAudit}>Generate Audit Bundle</button>
            </div>
          </div>
          {!canExportAudit ? <p className="mt-3 text-xs text-danger">Audit export requires AUDITOR or ADMIN authority.</p> : null}
          <div className="mt-4 space-y-3 text-sm text-muted">
            <p>Connection: <span className="font-mono text-ink">{telemetry.liveConnectionState}</span></p>
            <p>Policy: <span className="font-mono text-ink">{telemetry.metrics.policyName}</span></p>
            <p>Latest refusal: <span className="font-mono text-ink">{telemetry.latestRefusal?.reason_code ?? "none reported"}</span></p>
          </div>
          <pre className="mt-4 max-h-56 overflow-auto border border-line bg-[#080b0f] p-3 text-xs text-muted">{JSON.stringify(auditResult ?? { status: "not run" }, null, 2)}</pre>
        </section>
      </div>
    );
  }

  if (activeView === "Access") {
    return <AccessPanel session={authSession} onSessionChange={onSessionChange} authorityGate={authorityGate} />;
  }

  return (
    <>
      <SetupGuide onStartSidecar={onStartSidecar} sidecarLaunchState={sidecarLaunchState} startGate={runtimeGate} />
      <StatusCards metrics={telemetry.metrics} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_296px] gap-3">
        <DecisionFeed events={telemetry.events} onReceiptClick={onReceiptClick} />
        <div className="flex min-h-0 flex-col gap-3">
          <TrustEvidencePanel trust={trustState} />
          <SystemHealth health={telemetry.health} />
          <ResourcePanel resources={telemetry.resources} />
          <OperationalTimeline events={timelineEvents} />
        </div>
      </div>
    </>
  );
}

function StatusTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0 border border-line bg-[#0d1116] p-3">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className="mt-2 break-words font-mono text-sm font-semibold text-signal">{value}</div>
    </div>
  );
}

function AuthorityContextPanel({ authSession, telemetry, authority, trust }: { authSession?: AuthSession; telemetry: TelemetryState; authority: AuthorityScopeState; trust: TrustState }) {
  return (
    <section className="border border-line bg-panel p-4">
      <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Current Authority Context</div>
      <div className="mt-3 space-y-2 text-xs text-muted">
        <ContextLine label="User" value={authSession?.display_name ?? "unauthenticated"} />
        <ContextLine label="Scope" value={authority.currentScope} />
        <ContextLine label="All Scopes" value={authority.scopes.join(", ")} />
        <ContextLine label="Source" value={authority.source} />
        <ContextLine label="Assurance" value={`${authority.assurance} / MFA ${authority.mfa}`} />
        <ContextLine label="Session" value={`${authority.sessionFreshness} / ${authority.tokenExpiryMs === undefined ? "token expiry not reported" : `${Math.round(authority.tokenExpiryMs / 1000)}s TTL`}`} />
        <ContextLine label="Tenant" value={authSession?.tenant_id ?? "none"} />
        <ContextLine label="Policy" value={`${telemetry.metrics.policyName} / ${telemetry.metrics.policyHash}`} />
        <ContextLine label="Trust" value={`${trust.verdict}: ${trust.causes[0] ?? trust.staleProofs[0] ?? "no blocking cause"}`} />
        <ContextLine label="Environment" value="LOCAL" />
      </div>
    </section>
  );
}

function ContextLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="uppercase tracking-[0.12em]">{label}</span>
      <span className="min-w-0 break-all text-right font-mono text-ink">{value}</span>
    </div>
  );
}
