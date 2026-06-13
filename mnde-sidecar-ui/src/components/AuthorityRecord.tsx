import type { AuthSession } from "../auth/model";
import type { AuthorityScopeState, TrustState } from "../authority/trust";
import type { DecisionEvent, HealthItem, TelemetryState, Verdict, VerificationState } from "../types";

type Tone = "neutral" | "allow" | "refuse" | "review";
type ProtectionVerdict = "PROTECTED" | "DEGRADED" | "NOT PROTECTED";

interface AuthorityHeroProps {
  telemetry: TelemetryState;
  trust: TrustState;
  authority: AuthorityScopeState;
  session?: AuthSession;
}

interface RecentDecisionsRecordProps {
  events: DecisionEvent[];
  onReceiptClick: (event: DecisionEvent) => void;
}

export function AuthorityHero({ telemetry, trust, authority, session }: AuthorityHeroProps) {
  const latest = telemetry.events[0];
  const verdict = protectionVerdict(telemetry, trust);
  const tone = protectionTone(verdict);
  const policy = policyLabel(telemetry.metrics.policyName);
  const authorityLine = formatAuthority(session, authority);
  const trustStatus = trustStatusLabel(trust);
  const lastDecision = latest ? displayDecision(latest.verdict) : "None";

  return (
    <section className={`authority-panel authority-hero p-5 ${heroBorderClass(tone)}`}>
      <div className="grid-safe grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
        <div className="min-w-0">
          <div className="authority-eyebrow">Current Authority State</div>
          <div className={`safe-text mt-3 text-5xl font-semibold leading-none tracking-normal md:text-6xl ${toneClass(tone)}`}>{verdict}</div>
          <p className="safe-text mt-4 max-w-3xl text-base leading-relaxed text-muted">{heroSubtext(verdict, policy)}</p>
        </div>
        <div className="grid-safe grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <AuthorityField label="Authority" value={authorityLine} />
          <AuthorityField label="Trust Status" value={trustStatus} tone={trustStatusTone(trustStatus)} />
          <AuthorityField label="Active Policy" value={policy} mono tone={policy === "No verified policy" ? "review" : "neutral"} />
          <AuthorityField label="Last Decision" value={lastDecision} tone={decisionTone(latest?.verdict)} />
        </div>
      </div>
    </section>
  );
}

export function AuthorityMetricStrip({ telemetry }: { telemetry: TelemetryState }) {
  const decisionsToday = telemetry.events.length;
  const refusedToday = telemetry.events.filter((event) => event.verdict === "REFUSE").length;
  const receiptsVerified = telemetry.events.filter((event) => event.signature_status === "VALID").length;
  const drift = telemetry.metrics.replayDrift;

  return (
    <section className="grid-safe grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="Decisions Today" value={String(decisionsToday)} />
      <MetricCard label="Refused Today" value={String(refusedToday)} tone={refusedToday > 0 ? "refuse" : "neutral"} />
      <MetricCard label="Receipts Verified" value={String(receiptsVerified)} tone={receiptsVerified > 0 ? "allow" : "review"} />
      <MetricCard label="Policy Drift" value={String(drift)} tone={drift > 0 ? "review" : "allow"} />
    </section>
  );
}

export function GuardrailsRecord() {
  const guardrails = [
    "Production Protection",
    "Data Export Controls",
    "Billing Protection",
    "Destructive Action Protection"
  ];
  return (
    <section className="authority-panel p-4">
      <div className="authority-eyebrow">Guardrails</div>
      <div className="mt-3 space-y-2">
        {guardrails.map((item) => (
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border border-line bg-[#0b0d10] px-3 py-2" key={item}>
            <span className="h-2 w-2 bg-safe" />
            <span className="safe-text text-sm text-ink">{item}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ReceiptIntegrityRecord({ telemetry, latest }: { telemetry: TelemetryState; latest?: DecisionEvent }) {
  return (
    <section className="authority-panel p-4">
      <div className="authority-eyebrow">Receipt Integrity</div>
      <div className="mt-3 space-y-3">
        <AuthorityField label="Proof Status" value={latest?.signature_status ?? telemetry.integrity?.receiptSignatureValidity ?? "NOT_REPORTED"} tone={verificationTone(latest?.signature_status ?? telemetry.integrity?.receiptSignatureValidity)} />
        <AuthorityField label="Replay Status" value={latest?.replay_status ?? telemetry.integrity?.replayReproducibilityState ?? "NOT_REPORTED"} tone={verificationTone(latest?.replay_status ?? telemetry.integrity?.replayReproducibilityState)} />
        <AuthorityField label="Verification Result" value={telemetry.integrity?.receiptChainContinuity ?? latest?.receipt_chain_status ?? "NOT_REPORTED"} tone={verificationTone(telemetry.integrity?.receiptChainContinuity ?? latest?.receipt_chain_status)} />
        <AuthorityField label="Tamper Check" value={telemetry.integrity?.receiptSignatureValidity === "INVALID" ? "DETECTED" : "NO DRIFT REPORTED"} tone={telemetry.integrity?.receiptSignatureValidity === "INVALID" ? "refuse" : "neutral"} />
      </div>
    </section>
  );
}

export function RecentDecisionsRecord({ events, onReceiptClick }: RecentDecisionsRecordProps) {
  const visibleEvents = events.slice(0, 8);
  return (
    <section className="authority-panel flex min-h-[260px] flex-col">
      <header className="grid-safe grid shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-line px-4 py-3">
        <div>
          <div className="authority-eyebrow">Recent Decisions</div>
          <p className="safe-text mt-1 text-xs text-muted">Chronological execution authority record</p>
        </div>
        <div className="safe-mono font-mono text-xs text-muted">{events.length} records</div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {visibleEvents.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted">No execution decisions have been recorded.</div>
        ) : (
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[128px_104px_minmax(220px,1fr)_minmax(160px,0.55fr)_116px] gap-4 border-b border-line bg-[#0b0d10] px-4 py-2 text-[10px] uppercase tracking-[0.12em] text-muted">
              <div>Timestamp</div>
              <div>Decision</div>
              <div>Action</div>
              <div>Policy</div>
              <div>Proof</div>
            </div>
            {visibleEvents.map((event) => (
              <button className="grid w-full grid-cols-[128px_104px_minmax(220px,1fr)_minmax(160px,0.55fr)_116px] items-start gap-4 border-b border-line/80 px-4 py-3 text-left transition hover:bg-[#12161b]" key={event.id} onClick={() => onReceiptClick(event)} type="button">
                <span className="safe-mono font-mono text-xs text-muted">{event.timestamp}</span>
                <span className={`decision-pill decision-pill-${decisionTone(event.verdict)}`}>{displayDecision(event.verdict)}</span>
                <span className="min-w-0">
                  <span className="safe-text block text-sm font-semibold text-ink">{event.action}</span>
                  <span className="safe-mono mt-1 block font-mono text-[11px] text-muted">{event.reason_code}</span>
                </span>
                <span className="safe-mono font-mono text-xs text-muted">{event.policy || event.policy_hash}</span>
                <span className={toneClass(verificationTone(event.signature_status))}>{proofLabel(event.signature_status)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function CompactInfrastructureRow({ health }: { health: HealthItem[] }) {
  const items = ["API", "Parser (MCJ-1)", "Signer", "Storage", "Policy Engine"] as const;
  return (
    <section className="authority-panel grid-safe grid grid-cols-1 gap-2 px-4 py-3 md:grid-cols-5">
      {items.map((name) => {
        const item = health.find((entry) => entry.name === name);
        return (
          <div className="min-w-0 border-r border-line pr-3 last:border-r-0" key={name}>
            <div className="authority-label">{name === "Policy Engine" ? "Runtime" : name}</div>
            <div className={`safe-text mt-1 text-sm font-semibold ${healthToneClass(item?.state)}`}>{item?.state ?? "Failed"}</div>
          </div>
        );
      })}
    </section>
  );
}

function AuthorityField({ label, value, tone = "neutral", mono = false }: { label: string; value: string; tone?: Tone; mono?: boolean }) {
  return (
    <div className="min-w-0 space-y-1.5 border border-line bg-[#0b0d10] px-3 py-2">
      <div className="authority-label">{label}</div>
      <div className={`${mono ? "safe-mono font-mono" : "safe-text"} text-sm font-semibold ${toneClass(tone)}`}>{value}</div>
    </div>
  );
}

function MetricCard({ label, value, tone = "neutral" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="authority-panel min-w-0 p-4">
      <div className="authority-label">{label}</div>
      <div className={`safe-mono mt-2 font-mono text-2xl font-semibold ${toneClass(tone)}`}>{value}</div>
    </div>
  );
}

function protectionVerdict(telemetry: TelemetryState, trust: TrustState): ProtectionVerdict {
  if ((telemetry.liveConnectionState === "CONNECTED" || telemetry.liveConnectionState === "DEMO_MODE") && trust.verdict === "TRUSTED") return "PROTECTED";
  if (telemetry.liveConnectionState === "CONNECTED" || telemetry.liveConnectionState === "DEMO_MODE") return "DEGRADED";
  return "NOT PROTECTED";
}

function protectionTone(verdict: ProtectionVerdict): Tone {
  if (verdict === "PROTECTED") return "allow";
  if (verdict === "DEGRADED") return "review";
  return "refuse";
}

function heroSubtext(verdict: ProtectionVerdict, policy: string): string {
  if (verdict === "PROTECTED") return `MNDe is actively enforcing ${policy} before execution.`;
  if (verdict === "DEGRADED") return "MNDe has a setup or verification gap. Integrated actions remain controlled while proof state is restored.";
  return "MNDe is not currently protecting execution. Decisions are unavailable and authority is fail closed.";
}

function formatAuthority(session: AuthSession | undefined, authority: AuthorityScopeState): string {
  const name = session?.display_name?.trim() || "No signed-in authority";
  const role = authority.currentScope || session?.role || "UNASSIGNED";
  const provider = providerLabel(session?.provider || authority.source);
  return `${name}, ${role}, ${provider}`;
}

function providerLabel(value: string): string {
  if (value === "microsoft_entra") return "Microsoft Entra";
  if (value === "okta") return "Okta";
  if (value === "demo") return "Demo Authority";
  return value.replace(/_/g, " ");
}

function policyLabel(value: string): string {
  if (!value || value === "unavailable" || value === "unknown") return "No verified policy";
  return value;
}

function trustStatusLabel(trust: TrustState): "Trusted" | "Unverified" | "Failed" {
  if (trust.verdict === "TRUSTED") return "Trusted";
  if (trust.verdict === "FAIL_CLOSED" || trust.verdict === "POLICY_INVALID" || trust.verdict === "REPLAY_UNSAFE" || trust.verdict === "DISCONNECTED") return "Failed";
  return "Unverified";
}

function trustStatusTone(value: "Trusted" | "Unverified" | "Failed"): Tone {
  if (value === "Trusted") return "allow";
  if (value === "Failed") return "refuse";
  return "review";
}

function displayDecision(verdict?: Verdict): string {
  if (!verdict) return "None";
  if (verdict === "POLICY WARN") return "Review";
  return verdict.charAt(0) + verdict.slice(1).toLowerCase();
}

function decisionTone(verdict?: Verdict): Tone {
  if (verdict === "ALLOW" || verdict === "REPLAY") return "allow";
  if (verdict === "REFUSE") return "refuse";
  if (verdict === "POLICY WARN") return "review";
  return "neutral";
}

function verificationTone(value?: VerificationState): Tone {
  if (value === "VALID") return "allow";
  if (value === "INVALID" || value === "DRIFT" || value === "SIGNATURE_FAIL") return "refuse";
  if (value === "PENDING" || value === "UNKNOWN" || value === "NOT_REPORTED" || value === "UNAVAILABLE") return "review";
  return "neutral";
}

function proofLabel(value: VerificationState): string {
  if (value === "VALID") return "Verified";
  if (value === "INVALID" || value === "SIGNATURE_FAIL") return "Failed";
  if (value === "DRIFT") return "Drift";
  return "Not Reported";
}

function toneClass(tone: Tone): string {
  if (tone === "allow") return "text-safe";
  if (tone === "refuse") return "text-danger";
  if (tone === "review") return "text-warn";
  return "text-ink";
}

function heroBorderClass(tone: Tone): string {
  if (tone === "allow") return "border-safe/40 bg-safe/5";
  if (tone === "refuse") return "border-danger/40 bg-danger/5";
  if (tone === "review") return "border-warn/40 bg-warn/5";
  return "";
}

function healthToneClass(value?: string): string {
  if (value === "Healthy") return "text-safe";
  if (value === "Warning") return "text-warn";
  return "text-danger";
}
