import type { AuthorityScopeState, TrustState } from "../authority/trust";

const trustTone: Record<TrustState["verdict"], string> = {
  TRUSTED: "border-safe/40 bg-safe/10 text-safe",
  DEGRADED: "border-warn/40 bg-warn/10 text-warn",
  PARTIAL_AUTHORITY: "border-warn/40 bg-warn/10 text-warn",
  UNVERIFIED: "border-warn/40 bg-warn/10 text-warn",
  FAIL_CLOSED: "border-danger/40 bg-danger/10 text-danger",
  SIGNER_DEGRADED: "border-danger/40 bg-danger/10 text-danger",
  REPLAY_UNSAFE: "border-danger/40 bg-danger/10 text-danger",
  POLICY_INVALID: "border-danger/40 bg-danger/10 text-danger",
  DISCONNECTED: "border-danger/40 bg-danger/10 text-danger"
};

export function TrustVerdictPanel({ trust, authority }: { trust: TrustState; authority: AuthorityScopeState }) {
  return (
    <section className={`min-w-[270px] border px-3 py-2 ${trustTone[trust.verdict]}`}>
      <div className="text-[11px] uppercase tracking-[0.14em] opacity-80">Composite Trust State</div>
      <div className="mt-1 font-mono text-lg font-semibold">{trust.verdict}</div>
      <div className="mt-1 min-w-0 truncate text-xs text-ink">
        {trust.causes[0] ?? trust.staleProofs[0] ?? `${authority.currentScope} authority`}
      </div>
    </section>
  );
}

export function HeaderAuthorityPanel({ authority, displayName }: { authority: AuthorityScopeState; displayName?: string }) {
  return (
    <section className="min-w-[230px] border border-line bg-[#0b0f13] px-3 py-2 text-xs">
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted">Effective Authority</div>
      <div className="mt-1 truncate font-semibold text-ink">{displayName ?? "Unauthenticated"}</div>
      <div className="mt-0.5 font-mono text-muted">{authority.currentScope} / {authority.source}</div>
      <div className="mt-1 font-mono text-[11px] text-muted">{authority.assurance} / MFA {authority.mfa}</div>
    </section>
  );
}
