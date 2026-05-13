import { verifyReleaseIntegrity } from "./integrity.js";
export function verifyManifest(manifestPath, packageRoot) {
    return verifyReleaseIntegrity(manifestPath, packageRoot);
}
