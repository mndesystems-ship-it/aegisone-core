import type { AuthProvider, AuthState } from "../auth/model";

interface LoginScreenProps {
  auth: AuthState;
  environment: "LOCAL" | "STAGING" | "PRODUCTION";
  version: string;
  mode: "demo" | "live";
  onLogin: (provider: AuthProvider) => void;
}

export function LoginScreen({ auth, environment, version, mode, onLogin }: LoginScreenProps) {
  const live = mode === "live";
  const microsoftReady = auth.providerReadiness?.microsoft_entra?.configured ?? false;
  const oktaReady = auth.providerReadiness?.okta?.configured ?? false;
  const microsoftError = auth.providerReadiness?.microsoft_entra?.errors?.join("; ");
  const oktaError = auth.providerReadiness?.okta?.errors?.join("; ");
  return (
    <div className="grid h-screen min-h-[720px] place-items-center bg-[#080b0f] px-6 text-ink">
      <section className="w-full max-w-[460px] border border-line bg-panel p-6 shadow-2xl shadow-black/40">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center border border-signal/30 bg-[#10171d]">
            <svg aria-hidden="true" className="h-6 w-7" viewBox="0 0 56 36">
              <rect fill="#14a7df" height="4" opacity="0.72" width="22" x="4" y="16" />
              <rect fill="#eef2f6" height="16" opacity="0.78" width="7" x="30" y="10" />
              <rect fill="#eef2f6" height="16" opacity="0.78" width="7" x="42" y="10" />
              <rect fill="#eef2f6" height="4" opacity="0.72" width="7" x="49" y="16" />
            </svg>
          </div>
          <div>
            <div className="text-lg font-semibold">MNDe Execution Control</div>
            <div className="text-xs uppercase tracking-[0.16em] text-muted">Deterministic Execution Authority</div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 text-xs">
          <div className="border border-line bg-[#0b0f13] p-3">
            <div className="uppercase tracking-[0.14em] text-muted">Environment</div>
            <div className={`mt-2 font-mono font-semibold ${environment === "PRODUCTION" ? "text-danger" : environment === "STAGING" ? "text-warn" : "text-signal"}`}>{environment}</div>
          </div>
          <div className="border border-line bg-[#0b0f13] p-3">
            <div className="uppercase tracking-[0.14em] text-muted">Mode</div>
            <div className={`mt-2 font-mono font-semibold ${live ? "text-signal" : "text-warn"}`}>{live ? "LIVE AUTH REQUIRED" : "AUTH LOCKED"}</div>
          </div>
        </div>

        <div className="mt-5 space-y-2">
          <button className="button h-11 w-full px-4 text-left text-ink disabled:cursor-not-allowed disabled:opacity-45" disabled={!microsoftReady} onClick={() => onLogin("microsoft_entra")} type="button">
            Sign in with Microsoft
          </button>
          {!microsoftReady && microsoftError ? <div className="text-xs text-danger">Microsoft not configured: {microsoftError}</div> : null}
          <button className="button h-11 w-full px-4 text-left text-ink disabled:cursor-not-allowed disabled:opacity-45" disabled={!oktaReady} onClick={() => onLogin("okta")} type="button">
            Sign in with Okta
          </button>
          {!oktaReady && oktaError ? <div className="text-xs text-danger">Okta not configured: {oktaError}</div> : null}
        </div>

        <div className="mt-5 border border-danger/30 bg-danger/10 p-3 text-xs leading-relaxed text-muted">
          Live Mode requires enterprise identity. Authentication is refused until Microsoft Entra ID or Okta configuration validates.
        </div>

        {auth.reason ? <div className="mt-3 border border-line bg-[#0b0f13] p-3 text-xs text-danger">{auth.reason}</div> : null}

        <div className="mt-5 flex items-center justify-between border-t border-line pt-4 text-[11px] uppercase tracking-[0.14em] text-muted">
          <span>OIDC first</span>
          <span>Build {version}</span>
        </div>
      </section>
    </div>
  );
}
