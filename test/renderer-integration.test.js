const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src/index.html"), "utf8");
const renderer = fs.readFileSync(path.join(root, "src/renderer.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("primary navigation routes to real application sections", () => {
  const routes = [...html.matchAll(/class="nav-item(?: active)?" data-view="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(routes, ["dashboard", "buttons", "screen", "encoder", "games", "layout", "settings"]);
  for (const route of routes) assert.match(html, new RegExp(`id="view-${route}"`));
  assert.match(renderer, /games:\s*\["FIRMWARE LIBRARY",\s*"Games"\]/);
});

test("OLED studio exposes page, event, layout and device workflows", () => {
  for (const id of [
    "screenPageSelect", "screenEventSelect", "screenEventDuration", "screenEventTrigger",
    "screenEventDuplicateTarget", "screenDuplicateEventButton", "screenCanvas",
    "screenZoomSelect", "screenGridToggle", "screenGuidesToggle", "screenUndoButton",
    "screenRedoButton", "screenImportButton", "screenExportButton", "screenSaveButton",
    "screenUploadButton", "screenReadButton"
    , "screenAddRectButton", "screenAddFillRectButton", "screenAddCircleButton", "screenAddFillCircleButton",
    "screenAddLineButton", "screenImageImportButton", "screenImageFile", "screenCopyButton", "screenPasteButton",
    "screenLayerUpButton", "screenLayerDownButton", "screenElementsList", "screenWidth", "screenHeight", "screenVisibility"
  ]) assert.match(html, new RegExp(`id="${id}"`), `${id} should be present`);
  for (const handler of ["renderScreenPages", "renderScreenEvents", "addScreenIcon", "updateScreenCanvasScale"])
    assert.match(renderer, new RegExp(`function ${handler}\\b`), `${handler} should be implemented`);
  assert.match(renderer, /screenDuplicateEventButton/);
  assert.match(renderer, /screenUploadButton/);
  for (const handler of ["screenAddRectButton", "screenImageImportButton", "screenCopyButton", "screenPasteButton", "screenLayerUpButton", "screenLayerDownButton"])
    assert.ok(renderer.includes(`$("${handler}")`) || renderer.includes(`"${handler}"`), `${handler} should have a working handler`);
});

test("firmware reserves SW7-SW9 in multi-page mode and preserves bounded/wrapping navigation", () => {
  const firmware = fs.readFileSync(path.join(root, "firmware/keys_shorcuts/keys_shorcuts.ino"), "utf8");
  assert.match(firmware, /key == 7 && currentScreenPage > 0\) currentScreenPage--/);
  assert.match(firmware, /key == 8\) \{[\s\S]*?enterGameMenu\(\);[\s\S]*?Serial\.println\("NAV GAMES"\)/);
  assert.match(firmware, /key == 9\) currentScreenPage = \(currentScreenPage \+ 1\) % screenPages\.count/);
  assert.match(firmware, /const bool pageNav = screenCustom && screenPages\.count > 1 && key >= 7/);
  assert.match(firmware, /\(now - lastChange\[r\]\[c\]\) >= DEBOUNCE_MS/);
});

test("ESP32 game runtime intercepts encoder and owns game rendering while active", () => {
  const firmware = fs.readFileSync(path.join(root, "firmware/keys_shorcuts/keys_shorcuts.ino"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "src/renderer.js"), "utf8");
  assert.match(firmware, /if \(gameScreen != GAME_OFF\) \{ routeGameInput\(GAME_SELECT\); return; \}/);
  assert.match(firmware, /if \(gameScreen != GAME_OFF\)[\s\S]*?routeGameInput\(d > 0 \? GAME_RIGHT : GAME_LEFT\);[\s\S]*?return;/);
  assert.match(firmware, /void updateSnakeGame\(\)/);
  assert.match(firmware, /tttPlaySwitch\(tttBoard, key, &tttNextPlayer, &tttResult\)/);
  assert.doesNotMatch(firmware, /playTicTacToeComputer|findTicTacToeLineMove/);
  assert.match(firmware, /void drawGamesScreen\(\)/);
  assert.match(firmware, /GAME START MENU\|SNAKE\|TTT\|PONG\|2048/);
  assert.match(renderer, /sendGameCommand\(payload\)/);
  assert.doesNotMatch(renderer, /requestAnimationFrame|setInterval\(/);
});

test("firmware OLED event state uses non-blocking timeout and replaces active temporary screens", () => {
  const firmware = fs.readFileSync(path.join(root, "firmware/keys_shorcuts/keys_shorcuts.ino"), "utf8");
  assert.match(firmware, /activeScreenEvent = \(int8_t\)ev/);
  assert.match(firmware, /screenEventUntil = \(duration == EVENT_DURATION_STICKY \|\| duration == EVENT_DURATION_HOLD\)[\s\S]*?millis\(\) \+ duration/);
  assert.match(firmware, /millis\(\) - screenEventUntil/);
  assert.match(firmware, /void pollScreenEvents\(\)/);
  assert.match(firmware, /priority = ev >= EV_SW1 && ev <= EV_SW9 \? 3[\s\S]*ev == EV_ENCP \? 2[\s\S]*EV_ENCW \|\| ev == EV_ENCCW \? 1/);
  assert.doesNotMatch(firmware, /delay\(\s*(?:500|1000|1500|2000|3000)\s*\)/);
});

test("firmware screen persistence checks the actual serialized header length", () => {
  const firmware = fs.readFileSync(path.join(root, "firmware/keys_shorcuts/keys_shorcuts.ino"), "utf8");
  assert.match(firmware, /SCREEN_FILE_HEADER_SIZE = 14/);
  assert.match(firmware, /written == SCREEN_FILE_HEADER_SIZE \+ sizeof\(screenPages\) \+ sizeof\(screenEvents\)/);
  assert.match(firmware, /file\.size\(\) < SCREEN_FILE_HEADER_SIZE \+ sizeof\(ScreenPageStore\) \+ sizeof\(ScreenEventStore\)/);
});

test("screen boot loading reuses static draft stores instead of allocating screen stores on loopTask stack", () => {
  const firmware = fs.readFileSync(path.join(root, "firmware/keys_shorcuts/keys_shorcuts.ino"), "utf8");
  const loader = firmware.slice(firmware.indexOf("bool loadScreensFile()"), firmware.indexOf("void loadScreenDesign()"));
  assert.match(loader, /ScreenPageStore& pages = screenPagesDraft/);
  assert.match(loader, /ScreenEventStore& events = screenEventsDraft/);
  assert.doesNotMatch(loader, /ScreenPageStore\s+pages\s*;/);
  assert.doesNotMatch(loader, /ScreenEventStore\s+events\s*;/);
});

test("firmware does not auto-format SPIFFS during boot", () => {
  const firmware = fs.readFileSync(path.join(root, "firmware/keys_shorcuts/keys_shorcuts.ino"), "utf8");
  assert.match(firmware, /SPIFFS\.begin\(false\)/);
  assert.doesNotMatch(firmware, /SPIFFS\.begin\(true\)/);
});

test("renderer IDs are unique and package includes OLED renderer dependencies", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
  assert.ok(packageJson.build.files.includes("icon-library.js"));
  assert.ok(packageJson.build.files.includes("image-converter.js"));
  assert.ok(packageJson.build.files.includes("image-decoder.js"));
});
