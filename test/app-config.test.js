const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONFIG_FORMAT,
  createDefaultConfig,
  validateConfig,
  validateImport,
  createExport,
  mergeDeviceConfig,
  firmwarePayload
} = require("../app-config");
const { ALL_SLOTS, HOSTS } = require("../serial-protocol");

test("default configuration contains all host profiles and physical and encoder slots", () => {
  const config = createDefaultConfig();
  assert.equal(validateConfig(config).configurationVersion, 4);
  assert.deepEqual(Object.keys(config.profiles), [...HOSTS]);
  for (const profile of Object.values(config.profiles)) assert.deepEqual(Object.keys(profile), ALL_SLOTS);
  assert.equal(Object.keys(config.layout.positions).length, 9);
  assert.ok(config.screenDesign.pages[0].elements.length > 0);
});

test("export and import round-trip all application settings", () => {
  const config = createDefaultConfig();
  config.host = "OMARCHY";
  config.labels["1"] = "Browser";
  config.profiles.LINUX.CW = "VOL_UP";
  config.preferences.theme = "light";
  config.screenDesign.pages[0].elements[2].text = "Playing";
  config.screenDesign.pages.push({ id: "media-controls", name: "Media", elements: [] });
  const file = createExport(config, "2026-11-06T00:00:00.000Z");
  assert.equal(file.format, CONFIG_FORMAT);
  assert.equal(file.version, 4);
  assert.equal(validateImport(file).screenDesign.pages[0].elements[2].text, "Playing");
  assert.equal(validateImport(file).screenDesign.pages[1].name, "Media");
  assert.deepEqual(validateImport(file), config);
});

test("import rejects incompatible versions and invalid configuration values", () => {
  assert.throws(() => validateImport({ format: CONFIG_FORMAT, version: 7 }), /Unsupported settings file version/);
  const invalidHost = createExport(createDefaultConfig());
  invalidHost.host = "OTHER";
  assert.throws(() => validateImport(invalidHost), /Unsupported host profile/);
  const invalidLabel = createExport(createDefaultConfig());
  invalidLabel.labels["1"] = "line\nfeed";
  assert.throws(() => validateImport(invalidLabel), /Invalid label/);
});

test("version 1 exports migrate to version 4 with the firmware-compatible default screen design", () => {
  const current = createExport(createDefaultConfig());
  current.version = 1;
  delete current.screenDesign;
  current.preferences = { theme: "dark", gridGap: 12, startView: "dashboard" };
  const migrated = validateImport(current);
  assert.equal(migrated.configurationVersion, 4);
  assert.ok(migrated.screenDesign.pages[0].elements.some(element => element.binding === "HOST"));
  assert.equal(migrated.preferences.aiProvider, "gemini");
});

test("Phase 4 version 2 screen data migrates to one page and preserves physical SW9 macros", () => {
  const prior = createExport(createDefaultConfig());
  prior.version = 2;
  prior.screenDesign = { version: 1, elements: prior.screenDesign.pages[0].elements };
  prior.profiles.LINUX["9"] = "CTRL+ALT+9";
  prior.preferences = { theme: "dark", gridGap: 12, startView: "dashboard", aiProvider: "openai", aiModel: "gpt-4.1-mini" };
  const migrated = validateImport(prior);
  assert.equal(migrated.screenDesign.pages.length, 1);
  assert.equal(migrated.profiles.LINUX["9"], "CTRL+ALT+9");
  assert.equal(migrated.preferences.aiEnabled, true);
});

test("firmware config merge updates macros while preserving local UI settings", () => {
  const previous = createDefaultConfig();
  previous.layout.positions["1"].column = 2;
  previous.layout.positions["3"].column = 0;
  previous.preferences.theme = "light";
  const merged = mergeDeviceConfig({
    host: "LINUX",
    labels: { "1": "Term" },
    combos: { LINUX: { "1": "CTRL+ALT+T", CW: "VOL_UP" } }
  }, previous);
  assert.equal(merged.host, "LINUX");
  assert.equal(merged.labels["1"], "Term");
  assert.equal(merged.profiles.LINUX["1"], "CTRL+ALT+T");
  assert.equal(merged.profiles.LINUX.CW, "VOL_UP");
  assert.deepEqual(merged.layout, previous.layout);
  assert.equal(merged.preferences.theme, "light");
});

test("firmware payload keeps labels and all host assignments separate from layout", () => {
  const config = createDefaultConfig();
  config.profiles.MACOS.PRESS = "MUTE";
  const payload = firmwarePayload(config);
  assert.deepEqual(Object.keys(payload.combos), [...HOSTS]);
  assert.equal(payload.combos.MACOS.PRESS, "MUTE");
  assert.equal("layout" in payload, false);
});
