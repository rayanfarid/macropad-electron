const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("Event listener must be a function");
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("macropad", Object.freeze({
  getAppConfig: () => ipcRenderer.invoke("app:get-config"),
  saveAppConfig: config => ipcRenderer.invoke("app:save-config", config),
  getVersion: () => ipcRenderer.invoke("app:version"),
  listPorts: () => ipcRenderer.invoke("device:ports"),
  getDeviceInfo: () => ipcRenderer.invoke("device:info"),
  discover: () => ipcRenderer.invoke("device:discover"),
  getConfig: () => ipcRenderer.invoke("device:get-config"),
  getScreenDesign: () => ipcRenderer.invoke("device:get-screen-design"),
  getScreenIcons: () => ipcRenderer.invoke("screen:get-icons"),
  saveScreenDesign: design => ipcRenderer.invoke("device:save-screen-design", design),
  selectScreenPage: index => ipcRenderer.invoke("device:select-screen-page", index),
  sendGameCommand: payload => ipcRenderer.invoke("device:game-command", payload),
  saveDeviceConfig: config => ipcRenderer.invoke("device:save-config", config),
  resetDevice: () => ipcRenderer.invoke("device:reset-config"),
  disconnect: () => ipcRenderer.invoke("device:disconnect"),
  previewImport: () => ipcRenderer.invoke("settings:preview-import"),
  applyImport: config => ipcRenderer.invoke("settings:apply-import", config),
  exportSettings: () => ipcRenderer.invoke("settings:export"),
  restoreUiDefaults: () => ipcRenderer.invoke("settings:restore-ui-defaults"),
  exportScreenDesign: design => ipcRenderer.invoke("screen:export", design),
  previewScreenImport: () => ipcRenderer.invoke("screen:preview-import"),
  getAiCatalog: () => ipcRenderer.invoke("ai:catalog"),
  getAiStatus: providerId => ipcRenderer.invoke("ai:status", providerId),
  retrySecureStorage: providerId => ipcRenderer.invoke("ai:retry-secure-storage", providerId),
  setAiKey: (key, providerId) => ipcRenderer.invoke("ai:set-key", typeof key === "object" ? key : { key, providerId }),
  setAiEnabled: enabled => ipcRenderer.invoke("ai:set-enabled", enabled),
  testAiConnection: options => ipcRenderer.invoke("ai:test-connection", options),
  clearAiKey: providerId => ipcRenderer.invoke("ai:clear-key", typeof providerId === "object" ? providerId : { providerId }),
  generateScreenDesign: request => ipcRenderer.invoke("ai:generate-screen", request),
  onConnection: callback => subscribe("connection", callback),
  onDiscovered: callback => subscribe("discovered", callback),
  onSerialLine: callback => subscribe("serial-line", callback),
  onError: callback => subscribe("connection-error", callback),
  onSyncState: callback => subscribe("sync-state", callback),
  onWarning: callback => subscribe("app-warning", callback)
}));
