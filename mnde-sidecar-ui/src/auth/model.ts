export type AuthProvider = "microsoft_entra" | "okta";
export type AuthRole = "ADMIN" | "OPERATOR" | "AUDITOR" | "VIEWER";
export type AuthCapability =
  | "activate_policy"
  | "manage_runtime"
  | "export_audit"
  | "manage_integrations"
  | "manage_users"
  | "view_runtime"
  | "replay_decisions"
  | "inspect_receipts"
  | "verify_receipts"
  | "view_dashboard";

export interface AuthSession {
  user_id: string;
  display_name: string;
  email: string;
  tenant_id: string;
  provider: AuthProvider;
  role: AuthRole;
  login_time: string;
  session_expiry: string;
}

export type AuthStateKind = "loading" | "authenticated" | "unauthenticated" | "expired" | "auth_lost";

export interface AuthState {
  kind: AuthStateKind;
  session?: AuthSession;
  reason?: string;
  providerReadiness?: Partial<Record<Extract<AuthProvider, "microsoft_entra" | "okta">, { configured: boolean; errors: string[] }>>;
}

const roleCapabilities: Record<AuthRole, AuthCapability[]> = {
  ADMIN: [
    "activate_policy",
    "manage_runtime",
    "export_audit",
    "manage_integrations",
    "manage_users",
    "view_runtime",
    "replay_decisions",
    "inspect_receipts",
    "verify_receipts",
    "view_dashboard"
  ],
  OPERATOR: ["view_runtime", "replay_decisions", "inspect_receipts", "verify_receipts", "view_dashboard"],
  AUDITOR: ["inspect_receipts", "verify_receipts", "replay_decisions", "export_audit", "view_dashboard"],
  VIEWER: ["view_dashboard"]
};

export function isExpired(session: AuthSession, now = Date.now()): boolean {
  const expires = parseSessionTime(session.session_expiry);
  return !Number.isFinite(expires) || expires <= now;
}

function parseSessionTime(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return Date.parse(value);
}

export function validateSession(input: unknown, now = Date.now()): AuthState {
  if (!input || typeof input !== "object") return { kind: "unauthenticated", reason: "missing session" };
  const session = input as Partial<AuthSession>;
  const required: Array<keyof AuthSession> = ["user_id", "display_name", "email", "tenant_id", "provider", "role", "login_time", "session_expiry"];
  const missing = required.filter((key) => typeof session[key] !== "string" || !String(session[key]).trim());
  if (missing.length > 0) return { kind: "unauthenticated", reason: `missing claims: ${missing.join(", ")}` };
  if (!["microsoft_entra", "okta"].includes(session.provider as string)) return { kind: "unauthenticated", reason: "invalid provider" };
  if (!["ADMIN", "OPERATOR", "AUDITOR", "VIEWER"].includes(session.role as string)) return { kind: "unauthenticated", reason: "invalid role" };
  if (isExpired(session as AuthSession, now)) return { kind: "expired", session: session as AuthSession, reason: "session expired" };
  return { kind: "authenticated", session: session as AuthSession };
}

export function can(session: AuthSession | undefined, capability: AuthCapability): boolean {
  if (!session || isExpired(session)) return false;
  return roleCapabilities[session.role]?.includes(capability) ?? false;
}

export function liveModeRequiresAuth(mode: "demo" | "live"): boolean {
  return mode === "live";
}

export function isEnterpriseProvider(provider: AuthProvider): boolean {
  return provider === "microsoft_entra" || provider === "okta";
}

export function isSessionAllowedForMode(session: AuthSession | undefined, mode: "demo" | "live"): boolean {
  if (!session || isExpired(session)) return false;
  if (mode === "demo") return false;
  return isEnterpriseProvider(session.provider);
}
