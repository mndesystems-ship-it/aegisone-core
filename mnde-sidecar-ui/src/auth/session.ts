import type { AuthProvider, AuthSession, AuthState } from "./model";
import { validateSession } from "./model";

interface ProviderReadiness {
  microsoft_entra: { configured: boolean; errors: string[] };
  okta: { configured: boolean; errors: string[] };
}

export async function bootstrapAuth(): Promise<AuthState> {
  if (!isTauriRuntime()) {
    return { kind: "unauthenticated", reason: "Enterprise login requires the Tauri desktop app." };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const [session, providerReadiness] = await Promise.all([
      invoke<AuthSession | null>("auth_bootstrap"),
      invoke<ProviderReadiness>("auth_config_status")
    ]);
    return { ...validateSession(session), providerReadiness };
  } catch (error) {
    return { kind: "auth_lost", reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function loginWithProvider(provider: AuthProvider): Promise<AuthState> {
  if (!isTauriRuntime()) return { kind: "unauthenticated", reason: "Enterprise login requires the Tauri desktop app." };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const session = await invoke<AuthSession>("begin_oidc_login", { provider });
    return validateSession(session);
  } catch (error) {
    return { kind: "unauthenticated", reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function logoutAuth(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("auth_logout");
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
