const test = require("node:test");
const assert = require("node:assert/strict");
const { parseGet, buildSaveCommands, buildShortcutPagesCommands, parseShortcutPages, previousShortcutPageIndex, buildGameCommand } = require("../serial-protocol");

test("game commands are restricted to supported ESP32 runtime actions", () => {
  assert.equal(buildGameCommand({ action: "menu" }), "GAME START MENU");
  assert.equal(buildGameCommand({ action: "start", game: "snake" }), "GAME START SNAKE");
  assert.equal(buildGameCommand({ action: "start", game: "ttt" }), "GAME START TTT");
  assert.equal(buildGameCommand({ action: "exit" }), "GAME EXIT");
  assert.equal(buildGameCommand({ action: "status" }), "GAME STATUS");
  assert.throws(() => buildGameCommand({ action: "start", game: "dodge" }), /Unsupported/);
  assert.throws(() => buildGameCommand("GAME EXIT"), /invalid/);
});

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

test("shortcut pages serialize independently and previous-page navigation stops at page one", () => {
  const makePage = (id, name, action) => ({
    id, name,
    labels: Object.fromEntries(["1", "2", "3", "4", "5", "6"].map(slot => [slot, `Key ${slot}`])),
    profiles: Object.fromEntries(["WINDOWS", "LINUX", "MACOS", "OMARCHY"].map(host => [host, Object.fromEntries(["1", "2", "3", "4", "5", "6"].map(slot => [slot, "NONE"]))]))
  });
  const pages = [makePage("page-one", "Work"), makePage("page-two", "Media")];
  pages[0].profiles.WINDOWS["1"] = "CTRL+V";
  pages[1].profiles.WINDOWS["1"] = "CTRL+C";
  const commands = buildShortcutPagesCommands(pages);
  assert.ok(commands.includes("MACROS SET 0 1 WINDOWS CTRL+V"));
  assert.ok(commands.includes("MACROS SET 1 1 WINDOWS CTRL+C"));
  assert.equal(commands.at(-1), "MACROS COMMIT");
  const rows = ["MACROS PAGES 2"];
  pages.forEach((page, index) => {
    rows.push(`MACRO PAGE ${index} ${Buffer.from(page.id).toString("hex")} ${Buffer.from(page.name).toString("hex")}`);
    for (const slot of ["1", "2", "3", "4", "5", "6"]) {
      rows.push(`MACRO LABEL ${index} ${slot} ${Buffer.from(page.labels[slot]).toString("hex")}`);
      for (const host of ["WINDOWS", "LINUX", "MACOS", "OMARCHY"]) rows.push(`MACRO SET ${index} ${slot} ${host} ${page.profiles[host][slot]}`);
    }
  });
  assert.deepEqual(parseShortcutPages(rows).pages, pages);
  assert.equal(previousShortcutPageIndex(0, 3), 0);
  assert.equal(previousShortcutPageIndex(2, 3), 1);
  assert.throws(() => previousShortcutPageIndex(3, 3), /invalid/);
});
