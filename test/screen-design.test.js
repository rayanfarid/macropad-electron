const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SCREEN_WIDTH, SCREEN_HEIGHT, createDefaultScreenDesign, validateScreenDesign,
  buildScreenUploadCommands, parseScreenGet, buildScreenPagesUploadCommands,
  parseScreenPagesGet, nextScreenPageIndex
} = require("../screen-design");

test("default screen layout fits the actual monochrome OLED and uses supported dynamic bindings", () => {
  const design = validateScreenDesign(createDefaultScreenDesign());
  assert.equal(SCREEN_WIDTH, 128);
  assert.equal(SCREEN_HEIGHT, 64);
  assert.deepEqual(design.pages[0].elements.map(item => item.binding), ["KEYGRID", "HOST", "STATIC", "LAST", "ENCODER", "HID"]);
});

test("screen validation rejects unsupported capabilities, unsafe text, and out-of-bounds rendering", () => {
  const invalidFont = createDefaultScreenDesign();
  invalidFont.pages[0].elements[0].size = 3;
  assert.throws(() => validateScreenDesign(invalidFont), /Font size.*1 or 2/);
  const nonAscii = createDefaultScreenDesign();
  nonAscii.pages[0].elements[1].text = "Café";
  assert.throws(() => validateScreenDesign(nonAscii), /printable ASCII/);
  const overflow = createDefaultScreenDesign();
  overflow.pages[0].elements[1].x = 125;
  assert.throws(() => validateScreenDesign(overflow), /does not fit/);
});

test("screen upload is serialized as staged SCREEN commands and never emits macro SAVE or RESET", () => {
  const design = createDefaultScreenDesign();
  const commands = buildScreenUploadCommands(design);
  assert.equal(commands[0], "SCREEN BEGIN");
  assert.equal(commands[1], "SCREEN CLEAR");
  assert.ok(commands.some(command => command.startsWith("SCREEN ITEM 0 ")));
  assert.ok(commands.includes("SCREEN VALIDATE"));
  assert.equal(commands.at(-1), "SCREEN COMMIT");
  assert.equal(commands.some(command => command === "SAVE" || command === "RESET"), false);
  assert.ok(commands.every(command => command.length < 96));
});

test("screen GET serialization round trips all supported rendering properties", () => {
  const design = createDefaultScreenDesign();
  const commands = buildScreenUploadCommands(design).filter(command => command.startsWith("SCREEN ITEM "));
  const parsed = parseScreenGet([...commands, "SCREEN END"]);
  assert.equal(parsed.supported, true);
  assert.deepEqual(parsed.design.pages[0].elements.map(({ id, ...item }) => item), design.pages[0].elements.map(({ id, ...item }) => item));
  assert.deepEqual(parseScreenGet(["SCREEN LEGACY", "SCREEN END"]), { supported: false, design: null });
});

test("empty and malformed generated designs are rejected before editor or upload application", () => {
  assert.throws(() => validateScreenDesign({ version: 1, elements: [{ id: "x", x: 1, y: 1, size: 1, mode: "COLOR", alignment: "LEFT", binding: "STATIC", text: "X" }] }), /Unsupported rendering option/);
  assert.throws(() => validateScreenDesign({ version: 9, pages: [] }), /Unsupported screen design version/);
  assert.deepEqual(validateScreenDesign({ version: 1, elements: [] }).pages[0].elements, []);
});

test("multi-page upload validates bounds and wraps SW9 navigation without changing physical slots", () => {
  const { MAX_SCREEN_PAGES } = require("../screen-design");
  const design = createDefaultScreenDesign();
  design.pages.push({ id: "media", name: "Media", elements: [] });
  const commands = buildScreenPagesUploadCommands(design);
  assert.equal(commands[0], "SCREEN PAGES BEGIN");
  assert.ok(commands.includes("SCREEN PAGE ADD 1 4d65646961"));
  assert.equal(commands.at(-1), "SCREEN PAGES COMMIT");
  assert.equal(nextScreenPageIndex(1, 2), 0);
  assert.equal(MAX_SCREEN_PAGES, 8);
  assert.throws(() => nextScreenPageIndex(2, 2), /Current OLED page is invalid/);
});

test("multi-page device readback parses page names and each page's element rows", () => {
  const parsed = parseScreenPagesGet([
    "SCREEN PAGES 2", "SCREEN CURRENT 0", "SCREEN PAGE 0 4d61696e",
    "SCREEN ITEM 0 0 0 1 NORMAL STATIC LEFT 4869", "SCREEN PAGE END",
    "SCREEN PAGE 1 4d65646961", "SCREEN PAGE END", "SCREEN END"
  ]);
  assert.equal(parsed.supported, true);
  assert.equal(parsed.multiPageSupported, true);
  assert.equal(parsed.design.pages[0].name, "Main");
  assert.equal(parsed.design.pages[0].elements[0].text, "Hi");
  assert.equal(parsed.design.pages[1].name, "Media");
  assert.deepEqual(parsed.design.pages[1].elements, []);
});

test("shape elements and hidden image properties serialize for the hardware preview model", () => {
  const design = createDefaultScreenDesign();
  design.pages[0].elements = [
    { id: "frame", type: "shape", shape: "RECT", x: 1, y: 1, width: 30, height: 20, mode: "NORMAL" },
    { id: "stamp", type: "image", x: 40, y: 5, width: 8, height: 8, mode: "NORMAL", binding: "BITMAP", bitmap: "ff".repeat(8), visible: false, fit: "contain", threshold: 96, dither: "floydsteinberg" }
  ];
  const commands = buildScreenUploadCommands(design);
  assert.ok(commands.some(command => command.includes("RECT 20")));
  assert.ok(commands.some(command => command.includes("HIDDEN_NORMAL BITMAP")));
  assert.equal(validateScreenDesign(design).pages[0].elements[1].visible, false);
  assert.throws(() => validateScreenDesign({ ...design, pages: [{ ...design.pages[0], elements: [{ ...design.pages[0].elements[1], threshold: 300 }] }] }), /threshold/);
});
