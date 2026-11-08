const { HOSTS, ALL_SLOTS, BUTTON_SLOTS } = require("./serial-protocol");
const { createDefaultLayout, validateLayout } = require("./layout");
const { createDefaultScreenDesign, validateScreenDesign } = require("./screen-design");

const CONFIG_FORMAT = "macropad-desktop-settings";
const CONFIG_VERSION = 4;
const APP_VIEWS = new Set(["dashboard", "buttons", "encoder", "layout", "screen", "games", "settings"]);
const THEME_NAMES = new Set(["dark", "light"]);
const SUPPORTED_AI_PROVIDERS = new Set(["gemini", "openrouter", "openai"]);

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
    screenDesign: createDefaultScreenDesign(),
    shortcutPages: [{
      id: "screen-page-1", name: "Page 1",
      labels: Object.fromEntries(BUTTON_SLOTS.slice(0, 6).map(slot => [slot, labels[slot]])),
      profiles: Object.fromEntries([...HOSTS].map(host => [host, Object.fromEntries(BUTTON_SLOTS.slice(0, 6).map(slot => [slot, profiles[host][slot]]))]))
    }],
    preferences: { theme: "dark", gridGap: 12, startView: "dashboard", aiProvider: "gemini", aiModel: "gemini-2.5-flash-lite", aiEnabled: true }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Settings must be a JSON object");
  const allowedKeys = ["configurationVersion", "deviceWritePending", "host", "labels", "profiles", "layout", "screenDesign", "shortcutPages", "preferences"];
  if (Object.keys(input).some(key => !allowedKeys.includes(key))) throw new Error("Settings contain an unsupported field");
  if (![1, 2, 3, CONFIG_VERSION].includes(input.configurationVersion)) throw new Error(`Unsupported configuration version: ${input.configurationVersion}`);
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
  const screenDesign = input.configurationVersion === 1 || input.screenDesign === undefined
    ? createDefaultScreenDesign()
    : validateScreenDesign(input.screenDesign);
  const shortcutPages = validateShortcutPages(input.shortcutPages, screenDesign, labels, profiles);
  const preferences = input.preferences;
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) throw new Error("Application preferences are missing");
  if (!THEME_NAMES.has(preferences.theme)) throw new Error("Theme must be dark or light");
  if (!Number.isInteger(preferences.gridGap) || preferences.gridGap < 8 || preferences.gridGap > 24) throw new Error("Grid spacing must be between 8 and 24 pixels");
  if (!APP_VIEWS.has(preferences.startView)) throw new Error("Unknown startup view");
  const aiProvider = preferences.aiProvider ?? "gemini";
  const defaultModelForProvider = aiProvider === "openrouter" ? "openrouter/free" : "gemini-2.5-flash-lite";
  const aiModel = preferences.aiModel ?? defaultModelForProvider;
  const aiEnabled = preferences.aiEnabled ?? true;
  if (typeof aiEnabled !== "boolean") throw new Error("AI assistance preference is invalid");
  if (!SUPPORTED_AI_PROVIDERS.has(aiProvider)) throw new Error("Unsupported AI provider");
  if (typeof aiModel !== "string" || !/^[a-zA-Z0-9._:/-]{1,128}$/.test(aiModel)) throw new Error("AI model name is invalid");
  if (Object.keys(preferences).some(key => !["theme", "gridGap", "startView", "aiProvider", "aiModel", "aiEnabled"].includes(key))) throw new Error("Settings contain an unknown preference");

  return {
    configurationVersion: CONFIG_VERSION,
    deviceWritePending: input.deviceWritePending,
    host: input.host,
    labels,
    profiles,
    layout,
    screenDesign,
    shortcutPages,
    preferences: { ...preferences, aiProvider, aiModel, aiEnabled }
  };
}

function validateImport(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Import must be a JSON object");
  if (input.format !== CONFIG_FORMAT) throw new Error("This file is not a Macropad settings export");
  if (![1, 2, 3, CONFIG_VERSION].includes(input.version)) throw new Error(`Unsupported settings file version: ${input.version}`);
  return validateConfig({
    configurationVersion: input.version,
    deviceWritePending: input.deviceWritePending,
    host: input.host,
    labels: input.labels,
    profiles: input.profiles,
    layout: input.layout,
    screenDesign: input.screenDesign,
    shortcutPages: input.shortcutPages,
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
    screenDesign: valid.screenDesign,
    shortcutPages: valid.shortcutPages,
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
  if (next.shortcutPages[0]) {
    next.shortcutPages[0].labels = Object.fromEntries(BUTTON_SLOTS.slice(0, 6).map(slot => [slot, next.labels[slot]]));
    next.shortcutPages[0].profiles = Object.fromEntries([...HOSTS].map(host => [host, Object.fromEntries(BUTTON_SLOTS.slice(0, 6).map(slot => [slot, next.profiles[host][slot]]))]));
  }
  if (Array.isArray(deviceConfig?.shortcutPages) && deviceConfig.shortcutPages.length >= 1 && deviceConfig.shortcutPages.length <= 8) {
    next.shortcutPages = deviceConfig.shortcutPages.map(page => ({
      id: page.id, name: page.name,
      labels: { ...page.labels },
      profiles: Object.fromEntries([...HOSTS].map(host => [host, { ...page.profiles[host] }]))
    }));
  }
  return validateConfig(next);
}

function validateShortcutPages(input, screenDesign, legacyLabels, legacyProfiles) {
  const source = Array.isArray(input) ? input : [];
  if (Array.isArray(input) && (input.length < 1 || input.length > 8)) throw new Error("Shortcut configuration must contain 1–8 pages");
  const count = source.length || screenDesign.pages.length;
  const result = [];
  for (let index = 0; index < count; index++) {
    const oledPage = screenDesign.pages[index] || { id: `screen-page-${index + 1}`, name: `Page ${index + 1}` };
    const page = source[index];
    if (page !== undefined && (!page || typeof page !== "object" || Array.isArray(page))) throw new Error(`Shortcut page ${index + 1} is invalid`);
    if (page && Object.keys(page).some(key => !["id", "name", "labels", "profiles"].includes(key))) throw new Error(`Shortcut page ${index + 1} contains an unsupported property`);
    const labels = {};
    const profiles = {};
    for (const slot of BUTTON_SLOTS.slice(0, 6)) {
      const label = page?.labels?.[slot] ?? (index === 0 ? legacyLabels[slot] : legacyLabels[slot]);
      if (typeof label !== "string" || label.length > 8 || /[\r\n\0]/.test(label)) throw new Error(`Invalid shortcut page ${index + 1} label for SW${slot}`);
      labels[slot] = label;
    }
    if (page?.labels && Object.keys(page.labels).some(slot => !BUTTON_SLOTS.slice(0, 6).includes(slot))) throw new Error(`Shortcut page ${index + 1} has an unsupported button label`);
    for (const host of HOSTS) {
      const inputProfile = page?.profiles?.[host];
      profiles[host] = {};
      for (const slot of BUTTON_SLOTS.slice(0, 6)) {
        const action = inputProfile?.[slot] ?? legacyProfiles[host][slot];
        if (typeof action !== "string" || action.length > 64 || /[\r\n\0]/.test(action)) throw new Error(`Invalid shortcut page ${index + 1} action for ${host} SW${slot}`);
        profiles[host][slot] = action;
      }
      if (inputProfile && Object.keys(inputProfile).some(slot => !BUTTON_SLOTS.slice(0, 6).includes(slot))) throw new Error(`Shortcut page ${index + 1} contains an unsupported shortcut slot`);
    }
    if (page?.profiles && Object.keys(page.profiles).some(host => !HOSTS.has(host))) throw new Error(`Shortcut page ${index + 1} has an unsupported host profile`);
    const id = page?.id ?? oledPage.id;
    const name = page?.name ?? oledPage.name;
    if (typeof id !== "string" || !/^[a-z0-9-]{1,24}$/i.test(id)) throw new Error(`Shortcut page ${index + 1} has an invalid ID`);
    if (typeof name !== "string" || name.length < 1 || name.length > 20 || /[^\x20-\x7e]/.test(name)) throw new Error(`Shortcut page ${index + 1} name must be printable ASCII`);
    result.push({ id, name, labels, profiles });
  }
  return result;
}

function firmwarePayload(config) {
  const valid = validateConfig(config);
  return { host: valid.host, labels: valid.labels, combos: valid.profiles, shortcutPages: valid.shortcutPages };
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
  validateShortcutPages,
  summarizeConfig,
  clone
};
