const test = require("node:test");
const assert = require("node:assert/strict");
const { parseGet, buildSaveCommands } = require("../serial-protocol");

test("parseGet reads host, labels, and all supported host profiles, ignoring END", () => {
  const result = parseGet([
    "HOST OMARCHY",
    "LABEL 1 Browser",
    "LABEL CW Rotate",
    "SET 1 WINDOWS CTRL+SHIFT+M",
    "SET 9 LINUX SUPER+L",
    "SET PRESS MACOS NONE",
    "SET CCW OMARCHY ALT+LEFT",
    "END"
  ]);

  assert.deepEqual(result, {
    host: "OMARCHY",
    labels: { "1": "Browser", CW: "Rotate" },
    combos: {
      WINDOWS: { "1": "CTRL+SHIFT+M" },
      LINUX: { "9": "SUPER+L" },
      MACOS: { PRESS: "NONE" },
      OMARCHY: { CCW: "ALT+LEFT" }
    }
  });
});

test("parseGet tolerates missing and empty values", () => {
  assert.deepEqual(parseGet(["LABEL 2", "SET 3 LINUX", "END"]), {
    host: "WINDOWS",
    labels: { "2": "" },
    combos: { LINUX: { "3": "" } }
  });
});

test("save commands are ordered and include HOST, LABEL, SET, and SAVE", () => {
  assert.deepEqual(buildSaveCommands({
    host: "LINUX",
    labels: { "1": "Browser label", PRESS: "Enter" },
    combos: { WINDOWS: { "1": "ctrl+shift+m" }, OMARCHY: { CW: "alt+right" } }
  }), [
    "HOST LINUX",
    "LABEL 1 Browser",
    "LABEL PRESS Enter",
    "SET 1 WINDOWS CTRL+SHIFT+M",
    "SET CW OMARCHY ALT+RIGHT",
    "SAVE"
  ]);
});

test("save commands reject unsupported profiles, slots, and line injection", () => {
  assert.throws(() => buildSaveCommands({ host: "OTHER" }), /Unsupported host/);
  assert.throws(() => buildSaveCommands({ labels: { "10": "Bad" } }), /Unsupported label slot/);
  assert.throws(() => buildSaveCommands({ labels: { "1": "A\nSAVE" } }), /line break/);
  assert.throws(() => buildSaveCommands({ combos: { WINDOWS: { "1": "CTRL\nRESET" } } }), /line break/);
});
