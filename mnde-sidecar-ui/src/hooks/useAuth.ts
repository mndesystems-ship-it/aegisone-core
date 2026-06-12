import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthProvider, AuthSession, AuthState } from "../auth/model";
import { bootstrapAuth, loginWithProvider, logoutAuth } from "../auth/session";

export function useAuth({ requireFreshLogin = false }: { requireFreshLogin?: boolean } = {}) {
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });
  const clearedStartupSession = useRef(false);
  const freshLoginKey = "mnde.auth.fresh-login-cleared";

  const refresh = useCallback(async () => {
    setAuth(await bootstrapAuth());
  }, []);

  useEffect(() => {
    async function bootstrap() {
      const alreadyCleared = window.sessionStorage.getItem(freshLoginKey) === "true";
      if (requireFreshLogin && !clearedStartupSession.current && !alreadyCleared) {
        clearedStartupSession.current = true;
        window.sessionStorage.setItem(freshLoginKey, "true");
        await logoutAuth();
      }
      await refresh();
    }

    void bootstrap();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh, requireFreshLogin]);

  const login = useCallback(async (provider: AuthProvider) => {
    setAuth({ kind: "loading" });
    setAuth(await loginWithProvider(provider));
  }, []);

  const logout = useCallback(async () => {
    await logoutAuth();
    setAuth({ kind: "unauthenticated", reason: "logged out" });
  }, []);

  const setSession = useCallback((session: AuthSession) => {
    setAuth({ kind: "authenticated", session });
  }, []);

  return { auth, login, logout, refresh, setSession };
}
