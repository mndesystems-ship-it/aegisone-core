export interface SidecarLaunchResult {
  started: boolean;
  message: string;
  script_path?: string;
}

export type SidecarLaunchState = "idle" | "starting" | "started" | "unavailable" | "failed";
export type SidecarMode = "demo" | "live";

export interface AutoStartSidecarInput {
  isDesktop: boolean;
  mode: SidecarMode;
  launchState: SidecarLaunchState;
}

export interface DesktopStartupModeInput {
  isDesktop: boolean;
  mode: SidecarMode;
  alreadyPromoted: boolean;
}

export async function startMndeSidecar(): Promise<SidecarLaunchResult> {
  if (!isTauriRuntime()) {
    return {
      started: false,
      message: "Start Sidecar is available in the Tauri desktop app. In browser preview, start MNDe manually.",
    };
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<SidecarLaunchResult>("start_mnde_sidecar");
  } catch (error) {
    return {
      started: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function shouldAutoStartSidecar(input: AutoStartSidecarInput): boolean {
  return input.isDesktop && input.mode === "live" && input.launchState === "idle";
}

export function shouldUseLiveModeOnDesktopStartup(input: DesktopStartupModeInput): boolean {
  return input.isDesktop && input.mode === "demo" && !input.alreadyPromoted;
}

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
