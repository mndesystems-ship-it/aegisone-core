import { readFileSync } from "fs";
import { PROVENANCE_PATH } from "./paths.ts";

export type ReleaseProvenance = {
  schema_version: string;
  release_version: string;
  release_tag: string | null;
  git_commit_hash: string | null;
  build_timestamp_utc: string;
  build_command?: string;
  target_platform: string;
  target_arch: string;
  builder_identity?: {
    user: string | null;
    host: string | null;
  };
  toolchain: {
    node_version: string;
    rust_version: string;
    cargo_version: string;
  };
  artifacts: Record<string, string>;
  provenance_status: "complete" | "partial" | "incomplete";
  provenance_notes: string[];
};

export function readProvenance(): ReleaseProvenance {
  return JSON.parse(readFileSync(PROVENANCE_PATH, "utf8")) as ReleaseProvenance;
}

export function formatProvenanceForDisplay(provenance: ReleaseProvenance): string {
  return JSON.stringify(provenance, null, 2);
}
