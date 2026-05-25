import { useCallback, useEffect, useState } from "react";
import type { AuthProvider, AuthSession, AuthState } from "../auth/model";
import { bootstrapAuth, loginWithProvider, logoutAuth } from "../auth/session";

export function useAuth() {
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });

  const refresh = useCallback(async () => {
    setAuth(await bootstrapAuth());
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

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
