export interface SidecarLaunchResult {
  started: boolean;
  message: string;
  script_path?: string;
}

export type SidecarLaunchState = "idle" | "starting" | "started" | "unavailable" | "failed";
export type SidecarMode = "demo" | "live";
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type InvokeLike = <T>(command: string) => Promise<T>;

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

export async function startMndeLiveDemo(options: { fetchImpl?: FetchLike; isTauriRuntime?: () => boolean; invokeImpl?: InvokeLike } = {}): Promise<SidecarLaunchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!(options.isTauriRuntime ?? isTauriRuntime)()) {
    const devResult = await startLiveDemoFromDevServer(options.fetchImpl ?? fetch);
    return devResult ?? {
      started: false,
      message: "Start Live Demo is available in the Tauri desktop app. In browser preview, run npm run demo:live manually.",
    };
  }

  try {
    const invoke = options.invokeImpl ?? (await import("@tauri-apps/api/core")).invoke;
    return await invoke<SidecarLaunchResult>("start_live_demo");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Command start_live_demo not found") || message.includes("live demo launcher was not found")) {
      const devResult = await startLiveDemoFromDevServer(fetchImpl);
      if (devResult) return devResult;
      return {
        started: true,
        message: "Opening MNDe authority demo view.",
      };
    }
    return {
      started: false,
      message,
    };
  }
}

async function startLiveDemoFromDevServer(fetchImpl: FetchLike): Promise<SidecarLaunchResult | undefined> {
  try {
    const response = await fetchImpl("/__mnde/start-live-demo", { method: "POST" });
    const body = await response.json() as Partial<SidecarLaunchResult>;
    if (!response.ok && typeof body.message !== "string") return undefined;
    return {
      started: body.started === true,
      message: typeof body.message === "string" ? body.message : "MNDe live demo start requested.",
      script_path: typeof body.script_path === "string" ? body.script_path : undefined,
    };
  } catch {
    return undefined;
  }
}

export function shouldAutoStartSidecar(input: AutoStartSidecarInput): boolean {
  return input.isDesktop && input.mode === "live" && input.launchState === "idle";
}

export function shouldUseLiveModeOnDesktopStartup(input: DesktopStartupModeInput): boolean {
  return input.isDesktop && input.mode === "demo" && !input.alreadyPromoted;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
