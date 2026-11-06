const fs = require("node:fs/promises");
const path = require("node:path");
const { createDefaultConfig, validateConfig } = require("./app-config");

async function loadConfig(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return { config: validateConfig(JSON.parse(raw)), warning: null };
  } catch (error) {
    if (error.code === "ENOENT") return { config: createDefaultConfig(), warning: null };
    return { config: createDefaultConfig(), warning: `Saved settings could not be loaded: ${error.message}` };
  }
}

async function saveConfig(filePath, config) {
  const valid = validateConfig(config);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  return valid;
}

module.exports = { loadConfig, saveConfig };
