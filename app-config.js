const { HOSTS, ALL_SLOTS } = require("./serial-protocol");
const { createDefaultLayout, validateLayout } = require("./layout");

const CONFIG_FORMAT = "macropad-desktop-settings";
const CONFIG_VERSION = 1;
const APP_VIEWS = new Set(["dashboard", "buttons", "encoder", "layout", "settings"]);
const THEME_NAMES = new Set(["dark", "light"]);

function createDefaultConfig() {
  const labels = Object.fromEntries(ALL_SLOTS.map(slot => [slot, ""]));
  const profiles = Object.fromEntries([...HOSTS].map(host => [host, Object.fromEntries(ALL_SLOTS.map(slot => [slot, "NONE"]))]));
  return {
    configurationVersion: CONFIG_VERSION,
    deviceWritePending: false,
    host: "WINDOWS",
    labels,
    profiles,
    layout: createDefaultLayout(),
    preferences: { theme: "dark", gridGap: 12, startView: "dashboard" }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Settings must be a JSON object");
  const allowedKeys = ["configurationVersion", "deviceWritePending", "host", "labels", "profiles", "layout", "preferences"];
  if (Object.keys(input).some(key => !allowedKeys.includes(key))) throw new Error("Settings contain an unsupported field");
  if (input.configurationVersion !== CONFIG_VERSION) throw new Error(`Unsupported configuration version: ${input.configurationVersion}`);
  if (typeof input.deviceWritePending !== "boolean") throw new Error("Device synchronization state is invalid");
  if (!HOSTS.has(input.host)) throw new Error(`Unsupported host profile: ${input.host}`);

  const labels = {};
  if (!input.labels || typeof input.labels !== "object" || Array.isArray(input.labels)) throw new Error("Labels are missing");
  for (const slot of ALL_SLOTS) {
    const label = input.labels[slot];
    if (typeof label !== "string" || label.length > 8 || /[\r\n\0]/.test(label)) throw new Error(`Invalid label for slot ${slot}`);
    labels[slot] = label;
  }
  if (Object.keys(input.labels).some(slot => !ALL_SLOTS.includes(slot))) throw new Error("Settings contain an unknown label slot");

  if (!input.profiles || typeof input.profiles !== "object" || Array.isArray(input.profiles)) throw new Error("Host profiles are missing");
  const profiles = {};
  for (const host of HOSTS) {
    const profile = input.profiles[host];
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error(`Profile ${host} is missing`);
    profiles[host] = {};
    for (const slot of ALL_SLOTS) {
      const action = profile[slot];
      if (typeof action !== "string" || action.length > 64 || /[\r\n\0]/.test(action)) throw new Error(`Invalid shortcut for ${host} slot ${slot}`);
      profiles[host][slot] = action;
    }
    if (Object.keys(profile).some(slot => !ALL_SLOTS.includes(slot))) throw new Error(`Profile ${host} contains an unknown slot`);
  }
  if (Object.keys(input.profiles).some(host => !HOSTS.has(host))) throw new Error("Settings contain an unknown host profile");

  const layout = validateLayout(input.layout);
  const preferences = input.preferences;
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) throw new Error("Application preferences are missing");
  if (!THEME_NAMES.has(preferences.theme)) throw new Error("Theme must be dark or light");
  if (!Number.isInteger(preferences.gridGap) || preferences.gridGap < 8 || preferences.gridGap > 24) throw new Error("Grid spacing must be between 8 and 24 pixels");
  if (!APP_VIEWS.has(preferences.startView)) throw new Error("Unknown startup view");
  if (Object.keys(preferences).some(key => !["theme", "gridGap", "startView"].includes(key))) throw new Error("Settings contain an unknown preference");

  return {
    configurationVersion: CONFIG_VERSION,
    deviceWritePending: input.deviceWritePending,
    host: input.host,
    labels,
    profiles,
    layout,
    preferences: { ...preferences }
  };
}

function validateImport(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Import must be a JSON object");
  if (input.format !== CONFIG_FORMAT) throw new Error("This file is not a Macropad settings export");
  if (input.version !== CONFIG_VERSION) throw new Error(`Unsupported settings file version: ${input.version}`);
  return validateConfig({
    configurationVersion: input.version,
    deviceWritePending: input.deviceWritePending,
    host: input.host,
    labels: input.labels,
    profiles: input.profiles,
    layout: input.layout,
    preferences: input.preferences
  });
}

function createExport(config, exportedAt = new Date().toISOString()) {
  const valid = validateConfig(config);
  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt,
    deviceWritePending: valid.deviceWritePending,
    host: valid.host,
    labels: valid.labels,
    profiles: valid.profiles,
    layout: valid.layout,
    preferences: valid.preferences
  };
}

function mergeDeviceConfig(deviceConfig, previousConfig = createDefaultConfig()) {
  const previous = validateConfig(previousConfig);
  const next = clone(previous);
  if (deviceConfig && HOSTS.has(deviceConfig.host)) next.host = deviceConfig.host;
  next.deviceWritePending = false;
  next.labels = Object.fromEntries(ALL_SLOTS.map(slot => [slot, String(deviceConfig?.labels?.[slot] ?? "").slice(0, 8)]));
  next.profiles = Object.fromEntries([...HOSTS].map(host => [host,
    Object.fromEntries(ALL_SLOTS.map(slot => [slot, String(deviceConfig?.combos?.[host]?.[slot] ?? "NONE")]))
  ]));
  return validateConfig(next);
}

function firmwarePayload(config) {
  const valid = validateConfig(config);
  return { host: valid.host, labels: valid.labels, combos: valid.profiles };
}

function summarizeConfig(config) {
  const valid = validateConfig(config);
  return {
    host: valid.host,
    buttonCount: ALL_SLOTS.slice(0, 9).length,
    encoderCount: ALL_SLOTS.length - 9,
    profiles: [...HOSTS],
    layoutButtons: Object.keys(valid.layout.positions).length
  };
}

module.exports = {
  CONFIG_FORMAT,
  CONFIG_VERSION,
  createDefaultConfig,
  validateConfig,
  validateImport,
  createExport,
  mergeDeviceConfig,
  firmwarePayload,
  summarizeConfig,
  clone
};
