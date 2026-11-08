const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { SerialManager } = require("./serial-manager");
const {
  CONFIG_FORMAT,
  CONFIG_VERSION,
  createDefaultConfig,
  validateConfig,
  validateImport,
  createExport,
  mergeDeviceConfig,
  firmwarePayload
} = require("./app-config");
const { loadConfig, saveConfig } = require("./config-store");
const { assertTrustedIpcSender, isAllowedDevelopmentUrl } = require("./ipc-security");
const { validateScreenDesign } = require("./screen-design");
const { getAllBuiltinIcons } = require("./icon-library");
const { SCREEN_AI_INSTRUCTIONS, parseAiDesignResponse } = require("./ai-design");
const {
  getCatalog,
  getProvider,
  resolveProviderSelection,
  testProviderConnection,
  generateScreenDesignWithProvider,
  DEFAULT_AI_PROVIDER,
  DEFAULT_AI_MODEL
} = require("./ai-provider");
const { configureLinuxPasswordStore, secureCredentialStorageStatus: inspectCredentialStorage } = require("./secure-storage");

// Must run before app ready. On Hyprland/Omarchy, Chromium "detect" selects insecure
// basic_text even when gnome-keyring Secret Service is already running and unlocked.
configureLinuxPasswordStore(app);

const MAX_IMPORT_BYTES = 1024 * 1024;
const serial = new SerialManager();
let mainWindow = null;
let settingsFile = null;
let appConfig = createDefaultConfig();
let finishingQuit = false;

function secureCredentialStorageStatus() {
  return inspectCredentialStorage(safeStorage, process.platform);
}

function getAiKeyFilePath(providerId = DEFAULT_AI_PROVIDER) {
  const safeId = String(providerId).toLowerCase().replace(/[^a-z0-9_-]/g, "") || "gemini";
  return path.join(app.getPath("userData"), `ai-key-${safeId}.enc`);
}

async function isKeyConfiguredForProvider(providerId) {
  const credentialStorage = secureCredentialStorageStatus();
  if (!credentialStorage.available) return false;
  const filePath = getAiKeyFilePath(providerId);
  try {
    await fs.access(filePath);
    const encrypted = await fs.readFile(filePath);
    const decrypted = safeStorage.decryptString(encrypted);
    return Boolean(decrypted && decrypted.trim());
  } catch {
    return false;
  }
}

async function readAiKey(providerId) {
  const credentialStorage = secureCredentialStorageStatus();
  if (!credentialStorage.available) {
    throw new Error("Secure credential storage is unavailable. Unlock your keyring and try again.");
  }
  const filePath = getAiKeyFilePath(providerId);
  try {
    await fs.access(filePath);
    const encrypted = await fs.readFile(filePath);
    const key = safeStorage.decryptString(encrypted);
    if (!key || !key.trim()) throw new Error("Key is empty");
    return key.trim();
  } catch {
    const provider = getProvider(providerId);
    throw new Error(`Configure an API key for ${provider.label} in Settings → AI Assistance before generating.`);
  }
}

async function aiStatusPayload(requestedProvider) {
  const credentialStorage = secureCredentialStorageStatus();
  const catalog = getCatalog();
  const currentProviderId = requestedProvider || appConfig.preferences.aiProvider || DEFAULT_AI_PROVIDER;
  const { provider, model: currentModelId } = resolveProviderSelection(currentProviderId, appConfig.preferences.aiModel);

  const providerStatuses = {};
  for (const p of catalog.providers) {
    providerStatuses[p.id] = {
      keyConfigured: await isKeyConfiguredForProvider(p.id)
    };
  }

  const keyConfigured = Boolean(providerStatuses[currentProviderId]?.keyConfigured);

  return {
    provider: currentProviderId,
    providerLabel: provider.label,
    model: currentModelId,
    keyConfigured,
    providers: providerStatuses,
    catalog,
    secureStorageAvailable: credentialStorage.available,
    backend: credentialStorage.backend,
    backendLabel: credentialStorage.label,
    diagnosis: credentialStorage.diagnosis,
    help: credentialStorage.help,
    aiEnabled: Boolean(appConfig.preferences.aiEnabled),
    freeOnly: true
  };
}

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}

function assertTrustedRenderer(event) {
  assertTrustedIpcSender(event, {
    expectedWebContents: mainWindow?.webContents,
    isPackaged: app.isPackaged,
    appDirectory: __dirname,
    developmentUrl: process.env.MACROPAD_DEV_URL
  });
}

async function persistConfig(config) {
  appConfig = await saveConfig(settingsFile, config);
  return appConfig;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 700,
    backgroundColor: "#0d1118",
    title: "Macropad Studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  const developmentUrl = !app.isPackaged && process.env.MACROPAD_DEV_URL;
  if (developmentUrl) mainWindow.loadURL(developmentUrl);
  else mainWindow.loadFile(path.join(__dirname, "src", "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = url.startsWith("file://") || (!app.isPackaged && isAllowedDevelopmentUrl(url, process.env.MACROPAD_DEV_URL));
    if (!allowed) event.preventDefault();
  });
}

serial.on("connection", data => send("connection", data));
serial.on("discovered", data => send("discovered", data));
serial.on("line", line => send("serial-line", line));
serial.on("connection-error", error => send("connection-error", error));
serial.on("sync", data => send("sync-state", data));

ipcMain.handle("app:get-config", event => {
  assertTrustedRenderer(event);
  return appConfig;
});

ipcMain.handle("app:save-config", async (event, value) => {
  assertTrustedRenderer(event);
  return persistConfig(validateConfig(value));
});

ipcMain.handle("device:ports", event => {
  assertTrustedRenderer(event);
  return serial.listPorts();
});

ipcMain.handle("device:info", async event => {
  assertTrustedRenderer(event);
  return { ...serial.getConnectionInfo(), ports: await serial.listPorts() };
});

ipcMain.handle("device:discover", event => {
  assertTrustedRenderer(event);
  return serial.discover();
});

ipcMain.handle("device:get-config", async event => {
  assertTrustedRenderer(event);
  return serial.getConfig();
});

ipcMain.handle("device:get-screen-design", async event => {
  assertTrustedRenderer(event);
  return serial.getScreenDesign();
});

ipcMain.handle("screen:get-icons", event => {
  assertTrustedRenderer(event);
  return getAllBuiltinIcons();
});

ipcMain.handle("device:save-screen-design", async (event, value) => {
  assertTrustedRenderer(event);
  const design = validateScreenDesign(value);
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "Upload OLED design",
    message: `Upload ${design.pages.length} OLED page${design.pages.length === 1 ? "" : "s"} to the ESP32?`,
    detail: `${design.pages.length > 1 ? "Physical SW9 becomes Next OLED Page and wraps to page 1 on-device. Existing macro assignments remain stored. " : "With one page, SW9 retains its existing macro assignment. "}This updates OLED storage only; it does not change shortcuts, run SAVE, or reset the Macropad.`,
    buttons: ["Cancel", "Upload screen design"], defaultId: 0, cancelId: 0, noLink: true
  });
  if (confirmation.response !== 1) return { cancelled: true };
  return { cancelled: false, ...(await serial.saveScreenDesign(design)) };
});

ipcMain.handle("device:select-screen-page", async (event, value) => {
  assertTrustedRenderer(event);
  if (!Number.isInteger(value) || value < 0 || value >= 8) throw new Error("OLED page index must be from 0 to 7");
  return serial.selectScreenPage(value);
});

ipcMain.handle("device:game-command", (event, payload) => {
  assertTrustedRenderer(event);
  return serial.sendGameCommand(payload);
});

ipcMain.handle("device:save-config", async (event, value) => {
  assertTrustedRenderer(event);
  const validated = validateConfig(value);
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "Save to Macropad",
    message: "Write these settings to the connected ESP32?",
    detail: "This updates the device configuration and saves it to firmware storage. Local layout preferences are not sent to the device.",
    buttons: ["Cancel", "Write settings"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (confirmation.response !== 1) return { cancelled: true };
  const result = await serial.saveConfig(firmwarePayload(validated));
  appConfig = await persistConfig(mergeDeviceConfig(result.config, validated));
  return { cancelled: false, sent: result.sent, deviceConfig: result.config, appConfig };
});

ipcMain.handle("device:reset-config", async event => {
  assertTrustedRenderer(event);
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "Reset Macropad shortcuts?",
    message: "Reset the ESP32 shortcuts and labels to firmware defaults?",
    detail: "This changes the device. It does not reset the application's theme or visual layout.",
    buttons: ["Cancel", "Reset device"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (confirmation.response !== 1) return { cancelled: true };
  const deviceConfig = await serial.resetConfig();
  appConfig = await persistConfig(mergeDeviceConfig(deviceConfig, appConfig));
  return { cancelled: false, deviceConfig, appConfig };
});

ipcMain.handle("device:disconnect", event => {
  assertTrustedRenderer(event);
  return serial.disconnect();
});

ipcMain.handle("settings:export", async event => {
  assertTrustedRenderer(event);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export Macropad settings",
    defaultPath: "macropad-settings.json",
    filters: [{ name: "Macropad settings", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  const document = createExport(appConfig);
  await fs.writeFile(result.filePath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { cancelled: false, fileName: path.basename(result.filePath) };
});

ipcMain.handle("settings:preview-import", async event => {
  assertTrustedRenderer(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Preview Macropad settings import",
    properties: ["openFile"],
    filters: [{ name: "Macropad settings", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  const filePath = result.filePaths[0];
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_IMPORT_BYTES) throw new Error("Settings files must be smaller than 1 MB");
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read settings JSON: ${error.message}`);
  }
  const config = validateImport(parsed);
  return {
    cancelled: false,
    fileName: path.basename(filePath),
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    config,
    preview: {
      host: config.host,
      profiles: Object.keys(config.profiles),
      labeledSlots: Object.values(config.labels).filter(Boolean).length,
      layoutSlots: Object.keys(config.layout.positions).length,
      theme: config.preferences.theme
    }
  };
});

ipcMain.handle("settings:apply-import", async (event, value) => {
  assertTrustedRenderer(event);
  const imported = validateConfig({ ...value, deviceWritePending: true });
  return persistConfig(imported);
});

ipcMain.handle("settings:restore-ui-defaults", async event => {
  assertTrustedRenderer(event);
  const defaults = createDefaultConfig();
  return persistConfig({
    ...appConfig,
    layout: defaults.layout,
    screenDesign: defaults.screenDesign,
    preferences: defaults.preferences
  });
});

ipcMain.handle("screen:export", async (event, value) => {
  assertTrustedRenderer(event);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export OLED screen design", defaultPath: "macropad-screen.json",
    filters: [{ name: "Macropad screen design", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  const design = validateScreenDesign(value);
  await fs.writeFile(result.filePath, `${JSON.stringify({ format: "macropad-screen-design", ...design }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { cancelled: false, fileName: path.basename(result.filePath) };
});

ipcMain.handle("screen:preview-import", async event => {
  assertTrustedRenderer(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import OLED screen design", properties: ["openFile"],
    filters: [{ name: "Macropad screen design", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  const filePath = result.filePaths[0];
  const stat = await fs.stat(filePath);
  if (stat.size > 64 * 1024) throw new Error("Screen design files must be smaller than 64 KB");
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) { throw new Error(`Could not read screen design JSON: ${error.message}`); }
  if (!parsed || parsed.format !== "macropad-screen-design") throw new Error("This is not a Macropad screen design file");
  const design = parsed.version === 1
    ? validateScreenDesign({ version: 1, elements: parsed.elements })
    : validateScreenDesign({ version: parsed.version, pages: parsed.pages, eventOptions: parsed.eventOptions });
  return { cancelled: false, fileName: path.basename(filePath), design };
});

ipcMain.handle("ai:catalog", event => {
  assertTrustedRenderer(event);
  return getCatalog();
});

ipcMain.handle("ai:status", async (event, requestedProvider) => {
  assertTrustedRenderer(event);
  return aiStatusPayload(requestedProvider);
});

ipcMain.handle("ai:retry-secure-storage", async (event, requestedProvider) => {
  assertTrustedRenderer(event);
  return aiStatusPayload(requestedProvider);
});

ipcMain.handle("ai:set-key", async (event, payload) => {
  assertTrustedRenderer(event);
  const rawKey = typeof payload === "string" ? payload : payload?.key;
  const providerId = (typeof payload === "object" && payload?.providerId) || appConfig.preferences.aiProvider || DEFAULT_AI_PROVIDER;
  if (typeof rawKey !== "string") throw new Error("API key must be text");
  const key = rawKey.trim();
  if (!key) throw new Error("Enter an API key first.");
  const provider = getProvider(providerId);
  provider.assertApiKeyShape(key);

  const storage = secureCredentialStorageStatus();
  if (!storage.available) throw new Error("Secure credential storage is unavailable. API keys are not saved as plaintext.");

  const filePath = getAiKeyFilePath(providerId);
  await fs.writeFile(filePath, safeStorage.encryptString(key), { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  return { keyConfigured: true, providerId };
});

ipcMain.handle("ai:set-enabled", async (event, value) => {
  assertTrustedRenderer(event);
  if (typeof value !== "boolean") throw new Error("AI assistance setting must be enabled or disabled");
  appConfig.preferences.aiEnabled = value;
  await persistConfig(appConfig);
  return { enabled: value };
});

ipcMain.handle("ai:test-connection", async (event, options = {}) => {
  assertTrustedRenderer(event);
  const providerId = options?.providerId || appConfig.preferences.aiProvider || DEFAULT_AI_PROVIDER;
  const model = options?.model || appConfig.preferences.aiModel;
  const apiKey = options?.apiKey ? options.apiKey.trim() : await readAiKey(providerId);
  return testProviderConnection({ providerId, model, apiKey });
});

ipcMain.handle("ai:clear-key", async (event, payload) => {
  assertTrustedRenderer(event);
  const providerId = (typeof payload === "string" ? payload : payload?.providerId) || appConfig.preferences.aiProvider || DEFAULT_AI_PROVIDER;
  const filePath = getAiKeyFilePath(providerId);
  await fs.rm(filePath, { force: true });
  return { keyConfigured: false, providerId };
});

ipcMain.handle("ai:generate-screen", async (event, request) => {
  assertTrustedRenderer(event);
  if (!request || typeof request.prompt !== "string" || request.prompt.trim().length < 2 || request.prompt.length > 3000) {
    throw new Error("Describe the screen design in 2–3000 characters");
  }
  const current = validateScreenDesign(request.currentDesign);
  if (!appConfig.preferences.aiEnabled) {
    throw new Error("AI Assistance is disabled. Enable it in Settings → AI Assistance.");
  }
  const providerId = request?.providerId || appConfig.preferences.aiProvider || DEFAULT_AI_PROVIDER;
  const model = request?.model || appConfig.preferences.aiModel;
  const apiKey = await readAiKey(providerId);
  return generateScreenDesignWithProvider({
    providerId,
    model,
    apiKey,
    prompt: request.prompt,
    currentDesign: current,
    parseResponse: parseAiDesignResponse
  });
});

ipcMain.handle("app:version", event => {
  assertTrustedRenderer(event);
  return app.getVersion();
});

app.whenReady().then(async () => {
  settingsFile = path.join(app.getPath("userData"), "macropad-settings.json");
  const loaded = await loadConfig(settingsFile);
  appConfig = loaded.config;
  createWindow();
  mainWindow.webContents.once("did-finish-load", () => {
    if (loaded.warning) send("app-warning", loaded.warning);
    serial.discover().catch(error => send("connection-error", { message: error.message }));
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", event => {
  if (finishingQuit) return;
  event.preventDefault();
  serial.disconnect().catch(() => {}).finally(() => {
    finishingQuit = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
