const { app, BrowserWindow, dialog, ipcMain } = require("electron");
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

const MAX_IMPORT_BYTES = 1024 * 1024;
const serial = new SerialManager();
let mainWindow = null;
let settingsFile = null;
let appConfig = createDefaultConfig();
let finishingQuit = false;

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
    preferences: defaults.preferences
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
