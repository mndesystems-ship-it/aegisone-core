import { useEffect, useState } from "react";
import { loadSettings, saveSettings } from "../data/settings";
import type { AppSettings } from "../types";

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  return [settings, setSettings] as const;
}
