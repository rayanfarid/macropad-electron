const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDefaultConfig } = require("../app-config");
const { loadConfig, saveConfig } = require("../config-store");

test("local settings persist macro data and visual layout without contacting firmware", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "macropad-settings-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.json");
  const config = createDefaultConfig();
  config.labels["4"] = "Mail";
  config.profiles.OMARCHY["4"] = "GUI+M";
  config.layout.positions["4"].row = 2;
  config.layout.positions["4"].column = 0;
  config.layout.positions["7"].row = 1;
  config.layout.positions["7"].column = 0;
  config.preferences.theme = "light";

  await saveConfig(file, config);
  const result = await loadConfig(file);
  assert.equal(result.warning, null);
  assert.deepEqual(result.config, config);
});

test("corrupt local settings return defaults with a useful warning", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "macropad-settings-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.json");
  await fs.writeFile(file, "{invalid json");
  const result = await loadConfig(file);
  assert.equal(result.config.configurationVersion, 1);
  assert.match(result.warning, /could not be loaded/i);
});
