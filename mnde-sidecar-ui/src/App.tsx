import { useEffect, useMemo, useRef, useState } from "react";
import { can, isSessionAllowedForMode, type AuthSession } from "./auth/model";
import { AccessPanel } from "./components/AccessPanel";
import { AuthorityHero, AuthorityMetricStrip, CompactInfrastructureRow, GuardrailsRecord, ReceiptIntegrityRecord, RecentDecisionsRecord } from "./components/AuthorityRecord";
import { buildOperationalTimeline, deriveAuthorityScope, deriveTrustState, gateProtectedAction, type AuthorityScopeState, type TrustState } from "./authority/trust";
import { BottomHealthStrip } from "./components/BottomHealthStrip";
import { activatePolicy, generateAuditBundle, getCurrentPolicy, replayRecent } from "./api/sidecarClient";
import { DecisionFeed } from "./components/DecisionFeed";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { DemoWorkspace } from "./components/DemoWorkspace";
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
import { TrustEvidencePanel } from "./components/TrustEvidencePanel";
import { OperationalTimeline } from "./components/OperationalTimeline";
import { buildSetupModel } from "./onboarding/setupModel";
import { isTauriRuntime, shouldAutoStartSidecar, shouldUseLiveModeOnDesktopStartup, startMndeLiveDemo, startMndeSidecar, type SidecarLaunchState } from "./desktop/sidecarControl";
import { useOperationalTelemetry } from "./hooks/useOperationalTelemetry";
import { useAuth } from "./hooks/useAuth";
import { useSettings } from "./hooks/useSettings";
import { isLiveDemoRequested, type LiveDemoOverlay } from "./liveDemo/evidence";
import type { AppLog, AppSettings, DecisionEvent, TelemetryState } from "./types";

export default function App() {
  const [settings, setSettings] = useSettings();
  const [manualLiveDemo, setManualLiveDemo] = useState(false);
  const liveDemo = manualLiveDemo || isLiveDemoRequested();
  const { auth, login, logout, setSession } = useAuth();
  const { telemetry, logs, setLogs, liveDemoOverlay } = useOperationalTelemetry(settings, liveDemo);
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
  const [liveDemoLaunchState, setLiveDemoLaunchState] = useState<SidecarLaunchState>("idle");
  const [liveDemoLaunchMessage, setLiveDemoLaunchMessage] = useState<string | undefined>();
  const [diagnosticRunId, setDiagnosticRunId] = useState(0);
  const promotedDesktopStartupRef = useRef(false);
  const authorityReady = liveDemo || isSessionAllowedForMode(auth.session, settings.mode);
  const authorityScope = useMemo(() => liveDemo && liveDemoOverlay.authority ? liveDemoAuthorityScope(liveDemoOverlay) : deriveAuthorityScope(auth.session), [auth.session, liveDemo, liveDemoOverlay]);
  const trustState = useMemo(() => liveDemo && liveDemoOverlay.evidence ? liveDemoTrustState(liveDemoOverlay) : deriveTrustState({ telemetry, session: auth.session, mode: settings.mode }), [telemetry, auth.session, settings.mode, liveDemo, liveDemoOverlay]);
  const timelineEvents = useMemo(() => buildOperationalTimeline(telemetry, auth.session, trustState), [telemetry, auth.session, trustState]);
  const setupModel = useMemo(() => buildSetupModel({ telemetry, trust: trustState, mode: settings.mode, sidecarLaunchState }), [telemetry, trustState, settings.mode, sidecarLaunchState, diagnosticRunId]);

  useEffect(() => {
    const isDesktop = isTauriRuntime();
    if (liveDemo && settings.mode !== "live") {
      setSettings({ ...settings, mode: "live", enableAutoReconnect: true });
      return;
    }
    if (settings.mode === "live" && !authorityReady && !liveDemo) return;
    if (shouldUseLiveModeOnDesktopStartup({ isDesktop, mode: settings.mode, alreadyPromoted: promotedDesktopStartupRef.current })) {
      promotedDesktopStartupRef.current = true;
      setSettings({ ...settings, mode: "live" });
      return;
    }
    if (!shouldAutoStartSidecar({ isDesktop, mode: settings.mode, launchState: sidecarLaunchState })) return;
    void handleStartSidecar("auto");
  }, [settings.mode, sidecarLaunchState, authorityReady]);

  if (settings.mode === "live" && !authorityReady && !liveDemo) {
    return (
      <LoginScreen
        auth={auth}
        environment="LOCAL"
        mode={settings.mode}
        onLogin={(provider) => {
          void login(provider);
        }}
        onStartLiveDemo={handleStartLiveDemo}
        liveDemoLaunchState={liveDemoLaunchState}
        liveDemoLaunchMessage={liveDemoLaunchMessage}
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

  async function handleStartLiveDemo() {
    setLiveDemoLaunchState("starting");
    setLiveDemoLaunchMessage("Requesting live demo start...");
    const result = await startMndeLiveDemo();

    if (result.started) {
      setLiveDemoLaunchState("started");
      setLiveDemoLaunchMessage(result.message);
      setManualLiveDemo(true);
      setActiveView("Decision Stream");
      setSettings({ ...settings, mode: "live", enableAutoReconnect: true });
      return;
    }

    setLiveDemoLaunchState(result.message.includes("Tauri desktop app") ? "unavailable" : "failed");
    setLiveDemoLaunchMessage(result.message);
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
    <div className="relative flex h-screen min-h-0 overflow-hidden bg-[#090a0c] text-ink">
      <Sidebar
        activeView={activeView}
        connection={liveDemo ? "MNDe live demo attached to real runtime." : telemetry.connectionState}
        liveConnectionState={telemetry.liveConnectionState}
        mode={settings.mode}
        onViewChange={setActiveView}
        state={liveDemo && telemetry.liveConnectionState === "CONNECTED" ? "ACTIVE" : telemetry.systemState}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-3">
            {activeView === "Decision Stream" ? null : (
              <header className="grid-safe grid shrink-0 grid-cols-1 items-start gap-4 border border-line bg-panel px-4 py-3 2xl:grid-cols-[minmax(190px,1fr)_auto] 2xl:items-center">
                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-[0.16em] text-muted">{settings.mode === "demo" ? "Simulation Mode" : "Authority System"}</div>
                  <h1 className="mt-1 truncate text-xl font-semibold text-ink">{liveDemo ? "MNDe Authority Demonstration" : "Execution Authority"}</h1>
                </div>
                <div className="flex min-w-0 flex-wrap items-center justify-start gap-2 text-sm 2xl:justify-end">
                  <div className="safe-text min-w-0 border border-line bg-[#0b0f13] px-3 py-2 text-xs text-muted">
                    Authority: <span className="font-semibold text-ink">{liveDemo ? "Demo Authority" : auth.session?.display_name ?? "not signed in"}</span>
                  </div>
                  <div className={`safe-text border px-3 py-2 text-xs font-semibold ${settings.mode === "demo" ? "border-warn/35 bg-warn/10 text-warn" : telemetry.liveConnectionState === "CONNECTED" ? "border-safe/35 bg-safe/10 text-safe" : "border-danger/35 bg-danger/10 text-danger"}`}>
                    {liveDemo ? "demonstration attached" : settings.mode === "demo" ? "simulation mode" : telemetry.liveConnectionState === "CONNECTED" ? "protected" : "fail closed"}
                  </div>
                  {!liveDemo ? <button className="button px-3" onClick={logout} type="button">Logout</button> : null}
                  <button className="button px-3" onClick={() => setSettingsOpen(true)} type="button">Settings</button>
                </div>
              </header>
            )}

            {activeView === "Decision Stream" ? null : (
              <ModeBanner
                onOpenSettings={() => setSettingsOpen(true)}
                onStartSidecar={handleStartSidecar}
                onStartLiveDemo={handleStartLiveDemo}
                authorityReady={authorityReady}
                settings={settings}
                sidecarLaunchMessage={sidecarLaunchMessage}
                sidecarLaunchState={sidecarLaunchState}
                liveDemoLaunchState={liveDemoLaunchState}
                telemetry={telemetry}
              />
            )}

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
              liveDemo={liveDemo}
              liveDemoOverlay={liveDemoOverlay}
            />
          </section>

          {liveDemo || activeView === "Decision Stream" ? null : <RiskPanel latestRefusal={telemetry.latestRefusal} onOpenReceipt={setDetailReceipt} selectedReceipt={selectedReceipt} />}
        </div>

        {activeView === "Decision Stream" ? null : <BottomHealthStrip health={telemetry.health} />}
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
  liveDemo: boolean;
  liveDemoOverlay: LiveDemoOverlay;
}

function ActiveWorkspace({ activeView, telemetry, logs, sidecarLaunchState, selectedReceipt, replayResult, policyResult, auditResult, policyPath, onStartSidecar, onReconnect, onRerunDiagnostics, onReceiptClick, onOpenReceipt, onClearLogs, onReplayRecent, onRefreshPolicy, onActivatePolicy, onGenerateAudit, onOpenAuditFolder, onPolicyPathChange, authSession, onSessionChange, trustState, authorityScope, timelineEvents, setupModel, settings, onSettingsChange, liveDemo, liveDemoOverlay }: ActiveWorkspaceProps) {
  const liveAuthority = telemetry.mode === "live";
  const policyGate = gateProtectedAction("policy_activation", trustState, authorityScope);
  const runtimeGate = gateProtectedAction("runtime_enablement", trustState, authorityScope);
  const replayGate = gateProtectedAction("replay_approval_override", trustState, authorityScope);
  const authorityGate = gateProtectedAction("authority_changes", trustState, authorityScope);
  const canActivatePolicy = liveAuthority && can(authSession, "activate_policy") && policyGate.allowed;
  const canReplay = liveAuthority && can(authSession, "replay_decisions") && replayGate.allowed;
  const canExportAudit = liveAuthority && can(authSession, "export_audit");

  if (liveDemo && activeView === "Decision Stream") {
    return <LiveDemoWorkspace telemetry={telemetry} overlay={liveDemoOverlay} onReceiptClick={onReceiptClick} />;
  }

  if (activeView === "Demos") {
    return <DemoWorkspace />;
  }

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
      <div className="grid-safe grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_296px]">
        <DecisionFeed events={telemetry.events} onReceiptClick={onReceiptClick} />
        <section className="border border-line bg-panel p-4">
          <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Receipt Inspector</div>
          <h2 className="safe-mono mt-2 text-lg font-semibold text-ink">{selectedReceipt ? selectedReceipt.receipt_id : "No receipt selected"}</h2>
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
          <div className="grid-safe mt-3 grid grid-cols-1 gap-2 xl:grid-cols-[minmax(0,1fr)_auto_auto]">
            <input aria-label="Policy file path" className="input" value={policyPath} onChange={(event) => onPolicyPathChange(event.target.value)} />
            <button className="button px-3" onClick={onRefreshPolicy}>Refresh Current</button>
            <button className="button signal px-3 disabled:cursor-not-allowed disabled:opacity-45" disabled={!canActivatePolicy} onClick={onActivatePolicy}>Activate Policy</button>
          </div>
          {!canActivatePolicy ? <p className="safe-text mt-2 text-xs text-danger">Policy activation blocked: {policyGate.reason}</p> : null}
          <pre className="json-scroll mt-3 max-h-32 border border-line bg-[#080b0f] p-3 text-xs text-muted">{JSON.stringify(policyResult ?? { status: "not checked", policy: telemetry.metrics.policyName, policy_hash: telemetry.metrics.policyHash }, null, 2)}</pre>
        </section>
        <TrustEvidencePanel trust={trustState} />
        <StatusCards metrics={telemetry.metrics} />
      </div>
    );
  }

  if (activeView === "Replay") {
    return (
      <div className="grid-safe grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_296px]">
        <section className="border border-line bg-panel p-4">
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Replay Status</div>
            <button className="button signal px-3 disabled:cursor-not-allowed disabled:opacity-45" disabled={!canReplay} onClick={onReplayRecent}>Replay Last 100 Decisions</button>
          </div>
          {!canReplay ? <p className="safe-text mt-3 text-xs text-danger">Replay override blocked: {replayGate.reason}</p> : null}
          <div className="grid-safe mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StatusTile label="Status" value={String(replayResult?.status ?? "not run")} />
            <StatusTile label="Checked" value={String(replayResult?.checked ?? 0)} />
            <StatusTile label="Drift" value={String(replayResult?.drift ?? telemetry.metrics.replayDrift)} />
            <StatusTile label="Signature Failures" value={String(replayResult?.signature_failures ?? 0)} />
          </div>
          <pre className="json-scroll mt-3 max-h-44 border border-line bg-[#080b0f] p-3 text-xs text-muted">{JSON.stringify(replayResult ?? { status: "not run" }, null, 2)}</pre>
        </section>
        <SystemHealth health={telemetry.health} />
      </div>
    );
  }

  if (activeView === "Runtime") {
    return (
      <div className="grid-safe grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_296px]">
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
      <div className="grid-safe grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_296px]">
        <div className="flex min-h-0 flex-col gap-3">
          <LogsPanel logs={logs} onClear={onClearLogs} />
          <OperationalTimeline events={timelineEvents} />
        </div>
        <section className="border border-line bg-panel p-4">
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-[0.16em] text-signal">Audit Summary</div>
            <div className="flex min-w-0 flex-wrap gap-2">
              <button className="button px-3" disabled={!auditResult?.bundle_path || !canExportAudit} onClick={onOpenAuditFolder}>Open Folder</button>
              <button className="button signal px-3 disabled:cursor-not-allowed disabled:opacity-45" disabled={!canExportAudit} onClick={onGenerateAudit}>Generate Audit Bundle</button>
            </div>
          </div>
          {!canExportAudit ? <p className="safe-text mt-3 text-xs text-danger">Audit export requires AUDITOR or ADMIN authority.</p> : null}
          <div className="mt-4 space-y-3 text-sm text-muted">
            <p className="safe-text">Connection: <span className="safe-mono font-mono text-ink">{telemetry.liveConnectionState}</span></p>
            <p className="safe-text">Policy: <span className="safe-mono font-mono text-ink">{telemetry.metrics.policyName}</span></p>
            <p className="safe-text">Latest refusal: <span className="safe-mono font-mono text-ink">{telemetry.latestRefusal?.reason_code ?? "none reported"}</span></p>
          </div>
          <pre className="json-scroll mt-4 max-h-56 border border-line bg-[#080b0f] p-3 text-xs text-muted">{JSON.stringify(auditResult ?? { status: "not run" }, null, 2)}</pre>
        </section>
      </div>
    );
  }

  if (activeView === "Access") {
    return <AccessPanel session={authSession} onSessionChange={onSessionChange} authorityGate={authorityGate} />;
  }

  return (
    <AuthorityHome
      telemetry={telemetry}
      trustState={trustState}
      authorityScope={authorityScope}
      authSession={authSession}
      onReceiptClick={onReceiptClick}
    />
  );
}

function AuthorityHome({ telemetry, trustState, authorityScope, authSession, onReceiptClick }: { telemetry: TelemetryState; trustState: TrustState; authorityScope: AuthorityScopeState; authSession?: AuthSession; onReceiptClick: (event: DecisionEvent) => void }) {
  const latestDecision = telemetry.events[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <AuthorityHero telemetry={telemetry} trust={trustState} authority={authorityScope} session={authSession} />
      <AuthorityMetricStrip telemetry={telemetry} />
      <div className="grid-safe grid min-h-0 grid-cols-1 gap-3 2xl:grid-cols-[minmax(0,1fr)_360px]">
        <RecentDecisionsRecord events={telemetry.events} onReceiptClick={onReceiptClick} />
        <div className="grid-safe grid min-h-0 grid-cols-1 gap-3 lg:grid-cols-2 2xl:flex 2xl:flex-col">
          <GuardrailsRecord />
          <ReceiptIntegrityRecord telemetry={telemetry} latest={latestDecision} />
        </div>
      </div>
      <CompactInfrastructureRow health={telemetry.health} />
    </div>
  );
}

function LiveDemoWorkspace({ telemetry, overlay, onReceiptClick }: { telemetry: TelemetryState; overlay: LiveDemoOverlay; onReceiptClick: (event: DecisionEvent) => void }) {
  const final = overlay.final;
  const authority = overlay.authority;
  const chain = ["Request", "Preflight", "Orbit", "ARM", "RAM0NA", "ALLOW / REFUSE", "Receipt Signed", "Replay Verified"];
  const latest = telemetry.events[0];
  return (
    <div className="grid-safe grid min-h-0 flex-1 grid-cols-1 gap-3 2xl:grid-cols-[minmax(320px,0.95fr)_minmax(360px,1.1fr)_minmax(280px,0.8fr)] 2xl:grid-rows-[auto_minmax(0,1fr)_auto]">
      <LiveDemoStatusBar telemetry={telemetry} overlay={overlay} />
      <LiveEventFeed
        events={telemetry.events}
        onReceiptClick={onReceiptClick}
      />
      <section className="flex min-h-0 flex-col border border-line bg-panel p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.16em] text-signal">Authority Pipeline</div>
            <div className="safe-text mt-1 max-w-[320px] text-sm font-semibold text-ink">{latest?.action ?? "Waiting for live request"}</div>
          </div>
          <div className="border border-safe/30 bg-safe/10 px-2 py-1 font-mono text-xs text-safe">REAL RUNTIME</div>
        </div>
        <div className="mt-4 flex min-h-0 flex-1 flex-col justify-between gap-2">
          {chain.map((item, index) => (
            <div className={`grid-safe grid grid-cols-[32px_minmax(0,1fr)_minmax(96px,132px)] items-start gap-3 border px-3 py-2.5 transition ${index < Math.min(overlay.events.length + 2, chain.length) ? "border-signal/35 bg-signal/5" : "border-line bg-[#0d1116]"}`} key={item}>
              <div className={`flex h-7 w-7 items-center justify-center border text-sm font-semibold ${index < Math.min(overlay.events.length + 2, chain.length) ? "border-signal/45 text-signal" : "border-line text-muted"}`}>{index + 1}</div>
              <div className="min-w-0 text-base font-semibold text-ink">{item}</div>
              <div className={`safe-mono text-right font-mono text-xs ${timelineStateClass(overlay.events[index]?.verdict)}`}>{timelineStateLabel(overlay.events[index])}</div>
            </div>
          ))}
        </div>
      </section>
      <section className="min-h-0 overflow-auto border border-line bg-panel p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-[0.16em] text-signal">Authority Details</div>
          <div className="border border-safe/30 bg-safe/10 px-2 py-1 font-mono text-xs text-safe">{authority?.signature_verification ?? "PENDING"}</div>
        </div>
        <div className="mt-4 space-y-3 text-sm text-muted">
          <ContextLine label="Issuer" value={authority?.issuer ?? "waiting"} />
          <ContextLine label="Audience" value={authority?.audience ?? "waiting"} />
          <ContextLine label="Role" value={authority?.role ?? "waiting"} />
          <ContextLine label="Capabilities" value={authority?.capabilities.join(", ") ?? "waiting"} />
          <ContextLine label="Nonce" value={authority?.nonce ?? "waiting"} />
          <ContextLine label="Expiry" value={authority?.expires_at ?? "waiting"} />
          <ContextLine label="Replay" value={authority?.replay_state ?? overlay.replay?.status ?? "waiting"} />
          <ContextLine label="Signature" value={authority?.signature_verification ?? "waiting"} />
        </div>
      </section>
      <section className="grid-safe grid grid-cols-1 gap-3 border border-line bg-panel p-4 2xl:col-span-3 2xl:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          <div className="text-xs uppercase tracking-[0.16em] text-signal">Trust + Replay</div>
          <div className="grid-safe mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
            <StatusTile label="Replay" value={overlay.replay?.status ?? "waiting"} />
            <StatusTile label="Drift" value={overlay.replay?.drift ?? "waiting"} />
            <StatusTile label="Parity" value={overlay.replay?.deterministic_parity ? "PASS" : "waiting"} />
            <StatusTile label="Signature" value={overlay.replay?.signature_validation ?? "waiting"} />
            <StatusTile label="Receipt" value={overlay.replay?.receipt_verification ?? "waiting"} />
          </div>
        </div>
        <div className="border-l border-line pl-4">
          <div className="text-xs uppercase tracking-[0.16em] text-signal">Final Screen</div>
          <div className="mt-3 space-y-1.5 text-sm text-muted">
            <ContextLine label="Hostile Verification" value={final?.hostile_verification ?? "PENDING"} />
            <ContextLine label="Signature Validation" value={final?.signature_verification ?? "PENDING"} />
            <ContextLine label="RBAC Enforcement" value={final?.rbac_enforcement ?? "PENDING"} />
            <ContextLine label="Replay Protection" value={final?.replay_protection ?? "PENDING"} />
            <ContextLine label="Deterministic Replay" value={final?.deterministic_replay ?? "PENDING"} />
            <div className="mt-3 border border-signal/35 bg-signal/10 px-3 py-2.5 font-mono text-base font-semibold text-signal">FINAL VERDICT: {final?.verdict ?? "PENDING"}</div>
          </div>
        </div>
      </section>
    </div>
  );
}

function LiveDemoStatusBar({ telemetry, overlay }: { telemetry: TelemetryState; overlay: LiveDemoOverlay }) {
  const hostileTotal = 8;
  const hostileDone = telemetry.events.filter((event) => event.verdict === "REFUSE").length;
  return (
    <section className="grid-safe grid grid-cols-1 gap-2 border border-line bg-panel p-3 sm:grid-cols-2 xl:grid-cols-3 2xl:col-span-3 2xl:grid-cols-6">
      <StatusTile label="Sidecar" value={telemetry.liveConnectionState === "CONNECTED" ? "Healthy" : telemetry.liveConnectionState} />
      <StatusTile label="Signer" value={overlay.authority?.signature_verification ?? "waiting"} />
      <StatusTile label="Replay" value={overlay.replay?.status ?? overlay.authority?.replay_state ?? "ready"} />
      <StatusTile label="Protection" value="Live Enforced" />
      <StatusTile label="Hostile Progress" value={`${Math.min(hostileDone, hostileTotal)}/${hostileTotal}`} />
      <StatusTile label="Policy" value={telemetry.metrics.policyHash === "unavailable" ? "live-demo-policy" : telemetry.metrics.policyHash} />
    </section>
  );
}

function LiveEventFeed({ events, onReceiptClick }: { events: DecisionEvent[]; onReceiptClick: (event: DecisionEvent) => void }) {
  return (
    <section className="flex min-h-0 flex-col border border-line bg-panel shadow-operational">
      <header className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">Live Event Feed</h2>
            <p className="text-sm text-muted">Real endpoint requests and signed receipts</p>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted">
            <span className="h-2 w-2 rounded-full bg-safe" />
            real runtime
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {events.map((event) => (
          <LiveEventCard event={event} key={event.id} onReceiptClick={onReceiptClick} />
        ))}
      </div>
    </section>
  );
}

function LiveEventCard({ event, onReceiptClick }: { event: DecisionEvent; onReceiptClick: (event: DecisionEvent) => void }) {
  const state = event.verdict === "ALLOW" || event.verdict === "REPLAY" ? "border-safe/35 bg-safe/5" : "border-danger/45 bg-danger/10";
  const label = event.verdict === "REPLAY" ? "REPLAY" : event.verdict;
  return (
    <article className={`border p-3.5 ${state}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-xs text-muted">{event.timestamp}</div>
          <div className="safe-text mt-1 text-lg font-semibold text-ink">{event.action}</div>
          <div className="safe-mono mt-1 text-sm text-muted">{event.command_preview}</div>
        </div>
        <div className={`shrink-0 border px-2.5 py-1 font-mono text-sm font-semibold ${event.verdict === "REFUSE" ? "border-danger/45 text-danger" : "border-safe/45 text-safe"}`}>{label}</div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted">
        <ContextLine label="Reason" value={event.reason_code} />
        <ContextLine label="Authority" value={event.signature_status} />
        <ContextLine label="Request" value={shortHash(event.request_hash)} />
        <ContextLine label="Decision" value={shortHash(event.decision_hash)} />
      </div>
      <button className="safe-mono mt-3 w-full border border-signal/30 bg-signal/10 px-3 py-2 text-left font-mono text-xs font-semibold text-signal transition hover:bg-signal/15" onClick={() => onReceiptClick(event)} type="button">
        receipt {shortHash(event.receipt_id)}
      </button>
    </article>
  );
}

function StatusTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0 border border-line bg-[#0d1116] p-3">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className="safe-mono mt-2 font-mono text-base font-semibold text-signal">{value}</div>
    </div>
  );
}

function shortHash(value: string): string {
  if (!value || value === "not reported") return value || "not reported";
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

function timelineStateLabel(event?: DecisionEvent): string {
  if (!event) return "waiting";
  if (event.verdict === "ALLOW") return "ALLOW";
  if (event.verdict === "REFUSE") return event.reason_code;
  if (event.verdict === "REPLAY") return "REPLAY PASS";
  return event.verdict;
}

function timelineStateClass(verdict?: DecisionEvent["verdict"]): string {
  if (verdict === "ALLOW" || verdict === "REPLAY") return "text-signal";
  if (verdict === "REFUSE") return "text-danger";
  return "text-muted";
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
    <div className="grid-safe grid grid-cols-[minmax(96px,0.42fr)_minmax(0,1fr)] items-start gap-3">
      <span className="safe-text uppercase tracking-[0.12em]">{label}</span>
      <span className="min-w-0 break-all text-right font-mono text-ink">{value}</span>
    </div>
  );
}

function liveDemoAuthorityScope(overlay: LiveDemoOverlay): AuthorityScopeState {
  const expiry = overlay.authority?.expires_at ? Date.parse(overlay.authority.expires_at) : undefined;
  return {
    currentScope: "ORG_ADMIN",
    scopes: ["ORG_ADMIN", "POLICY_ADMIN", "RUNTIME_CONTROL", "OPERATOR", "AUDITOR", "READ_ONLY"],
    source: "live-demo signed assertion",
    assurance: "ENTERPRISE_OIDC",
    mfa: "NOT_REPORTED",
    sessionFreshness: "FRESH",
    tokenExpiryMs: expiry && Number.isFinite(expiry) ? Math.max(0, expiry - Date.now()) : undefined
  };
}

function liveDemoTrustState(overlay: LiveDemoOverlay): TrustState {
  const verdict = overlay.final?.verdict === "PASS" ? "TRUSTED" : overlay.final?.verdict === "FAIL" ? "FAIL_CLOSED" : "UNVERIFIED";
  const runningCause = overlay.evidence?.status === "running" ? "hostile verification running" : "live demo evidence pending";
  return {
    verdict,
    causes: verdict === "TRUSTED" ? [] : [runningCause],
    staleProofs: [],
    freshness: [
      { label: "live demo evidence", value: overlay.evidence?.status ?? "pending", state: "fresh" },
      { label: "auth assertion", value: overlay.authority?.signature_verification === "VALID" ? "signed" : "pending", state: overlay.authority ? "fresh" : "missing" },
      { label: "replay verification", value: overlay.replay?.status ?? "pending", state: overlay.replay ? "fresh" : "missing" }
    ],
    integrity: [
      { label: "signature verification", value: overlay.replay?.signature_validation ?? overlay.authority?.signature_verification ?? "PENDING", state: overlay.authority?.signature_verification === "VALID" ? "valid" : "unverified" },
      { label: "receipt verification", value: overlay.replay?.receipt_verification ?? "PENDING", state: overlay.replay?.receipt_verification === "VALID" ? "valid" : "unverified" },
      { label: "deterministic replay", value: overlay.replay?.deterministic_parity ? "VALID" : "PENDING", state: overlay.replay?.deterministic_parity ? "valid" : "unverified" }
    ]
  };
}
