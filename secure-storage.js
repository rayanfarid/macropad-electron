const INSECURE_LINUX_BACKENDS = new Set(["basic_text", "unknown"]);

const BACKEND_LABELS = {
  gnome_libsecret: "Electron safeStorage / gnome-libsecret (Secret Service)",
  kwallet6: "Electron safeStorage / KWallet 6",
  kwallet5: "Electron safeStorage / KWallet 5",
  kwallet: "Electron safeStorage / KWallet",
  basic_text: "Electron safeStorage / basic_text (insecure plaintext fallback)",
  unknown: "Electron safeStorage / unknown backend",
  unavailable: "unavailable",
  darwin: "Electron safeStorage / macOS Keychain",
  win32: "Electron safeStorage / Windows DPAPI"
};

function configureLinuxPasswordStore(app, platform = process.platform) {
  if (platform !== "linux" || !app?.commandLine?.appendSwitch) return { applied: false, reason: "not-linux" };
  // Chromium's default "detect" often falls back to insecure basic_text on
  // non-GNOME sessions (Hyprland/Omarchy). Secret Service via gnome-libsecret
  // works with the standard gnome-keyring daemon Omarchy already runs.
  app.commandLine.appendSwitch("password-store", "gnome-libsecret");
  return { applied: true, backendPreference: "gnome-libsecret" };
}

function describeCredentialBackend(backend) {
  return BACKEND_LABELS[backend] || `Electron safeStorage / ${backend || "unavailable"}`;
}

function secureCredentialStorageStatus(safeStorage, platform = process.platform) {
  try {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function") {
      return {
        available: false,
        backend: "unavailable",
        label: describeCredentialBackend("unavailable"),
        diagnosis: "Electron safeStorage API is unavailable in this process.",
        help: "Restart Macropad Studio. If this continues, reinstall the application."
      };
    }
    const encryptionAvailable = Boolean(safeStorage.isEncryptionAvailable());
    let backend = "unavailable";
    if (typeof safeStorage.getSelectedStorageBackend === "function") {
      backend = safeStorage.getSelectedStorageBackend() || "unknown";
    } else if (encryptionAvailable) {
      backend = platform;
    }
    if (platform === "linux" && INSECURE_LINUX_BACKENDS.has(backend)) {
      return {
        available: false,
        backend,
        label: describeCredentialBackend(backend),
        diagnosis: "Secure credential storage is unavailable on this Linux system. Electron selected an insecure plaintext backend instead of Secret Service.",
        help: "Install/enable a Secret Service-compatible keyring such as gnome-keyring, unlock it, then click Retry or restart Macropad Studio."
      };
    }
    if (!encryptionAvailable) {
      return {
        available: false,
        backend,
        label: describeCredentialBackend(backend),
        diagnosis: "Secure credential storage is unavailable.",
        help: platform === "linux"
          ? "Install/enable a Secret Service-compatible keyring such as gnome-keyring, unlock it, then click Retry or restart Macropad Studio."
          : "Unlock your system credential store, then click Retry or restart Macropad Studio."
      };
    }
    return {
      available: true,
      backend,
      label: describeCredentialBackend(backend),
      diagnosis: "Secure storage available.",
      help: ""
    };
  } catch (error) {
    return {
      available: false,
      backend: "unavailable",
      label: describeCredentialBackend("unavailable"),
      diagnosis: "Secure credential storage could not be initialized.",
      help: error && error.message ? error.message : "Restart Macropad Studio and try again."
    };
  }
}

module.exports = {
  configureLinuxPasswordStore,
  describeCredentialBackend,
  secureCredentialStorageStatus,
  INSECURE_LINUX_BACKENDS
};
