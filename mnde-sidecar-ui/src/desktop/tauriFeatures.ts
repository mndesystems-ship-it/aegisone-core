export interface DesktopFeatureStatus {
  traySupport: "stubbed";
  minimizeToTray: "stubbed";
  nativeRefusalNotifications: "stubbed";
  receiptDeepLinks: "stubbed";
}

export const desktopFeatureStatus: DesktopFeatureStatus = {
  // Native tray APIs stay disabled until the desktop shell command lifecycle is finalized.
  traySupport: "stubbed",
  // Minimize-to-tray requires a user setting and explicit restore action before release.
  minimizeToTray: "stubbed",
  // Refusal event notifications require the native bridge to be explicitly enabled.
  nativeRefusalNotifications: "stubbed",
  // Receipt deep links require a registered mnde://receipt/<id> handler.
  receiptDeepLinks: "stubbed"
};
