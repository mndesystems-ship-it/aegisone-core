import type { AuthRole, AuthSession } from "./model";

export interface RbacAssignment {
  user_id?: string;
  email?: string;
  display_name: string;
  role: AuthRole;
  assigned_by: string;
  assigned_at: string;
}

export interface RbacStatus {
  bootstrapped: boolean;
  can_bootstrap: boolean;
  assignments: RbacAssignment[];
}

export interface RbacAssignmentInput {
  user_id?: string;
  email?: string;
  display_name: string;
  role: AuthRole;
}

export async function getRbacStatus(): Promise<RbacStatus> {
  if (!isTauriRuntime()) return { bootstrapped: false, can_bootstrap: false, assignments: [] };
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<RbacStatus>("rbac_status");
}

export async function bootstrapAdmin(): Promise<AuthSession> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<AuthSession>("rbac_bootstrap_admin");
}

export async function upsertRbacAssignment(input: RbacAssignmentInput): Promise<RbacStatus> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<RbacStatus>("rbac_upsert_assignment", { input });
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
