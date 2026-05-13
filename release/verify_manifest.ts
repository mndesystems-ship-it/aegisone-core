import { verifyReleaseIntegrity } from "./integrity.ts";

export function verifyManifest(manifestPath?: string, packageRoot?: string) {
  return verifyReleaseIntegrity(manifestPath, packageRoot);
}
