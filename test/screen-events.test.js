const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  SCREEN_EVENT_IDS, SCREEN_EVENT_PROTOCOL, createDefaultScreenDesign,
  validateScreenDesign, buildScreenEventsUploadCommands,
  parseScreenEventsGet, screenEventItemCommand
} = require("../screen-design");
const { SerialManager } = require("../serial-manager");
const { screenItemCommand, parseScreenGet } = require("../screen-design");

const textElement = (id, text, extra = {}) => ({
  id, x: 4, y: 4, size: 1, mode: "NORMAL", alignment: "LEFT", binding: "STATIC", text, ...extra
});

test("event ids cover idle, SW1-SW9, and encoder events", () => {
  assert.equal(SCREEN_EVENT_IDS.length, 13);
  assert.deepEqual(SCREEN_EVENT_IDS.slice(0, 3), ["idle", "sw1Press", "sw2Press"]);
  assert.ok(SCREEN_EVENT_IDS.includes("sw9Press"));
  assert.ok(SCREEN_EVENT_IDS.includes("encoderCW"));
  assert.ok(SCREEN_EVENT_IDS.includes("encoderCCW"));
  assert.ok(SCREEN_EVENT_IDS.includes("encoderPress"));
  assert.equal(SCREEN_EVENT_PROTOCOL.sw1Press, "SW1");
  assert.equal(SCREEN_EVENT_PROTOCOL.encoderCW, "ENCW");
});

test("old designs without events still validate and gain no event data", () => {
  const design = validateScreenDesign({ version: 2, pages: [{ id: "p1", name: "Page 1", elements: [textElement("a", "Hi")] }] });
  assert.equal(design.pages.length, 1);
  assert.equal(design.pages[0].events, undefined);
  assert.equal(design.eventOptions, undefined);
});

test("version 1 legacy layout migrates to a single idle-capable page", () => {
  const design = validateScreenDesign({ version: 1, elements: [textElement("a", "Legacy")] });
  assert.equal(design.pages.length, 1);
  assert.equal(design.pages[0].elements[0].text, "Legacy");
});

test("independent event layouts validate per page and per event", () => {
  const design = validateScreenDesign({
    version: 2,
    pages: [{
      id: "p1", name: "Page 1",
      elements: [textElement("main", "Idle screen")],
      events: {
        idle: { elements: [textElement("ei", "Custom idle")] },
        sw1Press: { elements: [textElement("s1", "PASTE"), textElement("s1b", "GUI+V", { y: 20 })] },
        encoderCW: { elements: [textElement("cw", "VOLUME+")] },
        encoderCCW: { elements: [textElement("ccw", "VOLUME-")] },
        encoderPress: { elements: [textElement("ep", "MUTE")] }
      }
    }, {
      id: "p2", name: "Page 2",
      elements: [textElement("m2", "Second")],
      events: { sw2Press: { elements: [textElement("s2", "COPY")] } }
    }],
    eventOptions: { duration: "STICKY", trigger: "RELEASE" }
  });
  assert.equal(design.pages[0].events.sw1Press.elements.length, 2);
  assert.equal(design.pages[1].events.sw2Press.elements[0].text, "COPY");
  assert.deepEqual(design.eventOptions, { duration: "STICKY", trigger: "RELEASE" });
});

test("invalid event layouts are rejected", () => {
  const base = { version: 2, pages: [{ id: "p1", name: "P", elements: [textElement("a", "x")], events: {} }] };
  assert.throws(() => validateScreenDesign({ ...base, pages: [{ ...base.pages[0], events: { bogus: { elements: [] } } }] }), /unknown OLED event/);
  assert.throws(() => validateScreenDesign({ ...base, pages: [{ ...base.pages[0], events: { sw1Press: { elements: [textElement("a", "x".repeat(30))] } } }] }), /21 printable/);
  assert.throws(() => validateScreenDesign({ ...base, eventOptions: { duration: "999", trigger: "PRESS" } }), /event duration/);
  assert.throws(() => validateScreenDesign({ ...base, eventOptions: { duration: "1500", trigger: "MAYBE" } }), /event trigger/);
  assert.throws(() => validateScreenDesign({ ...base, pages: [{ ...base.pages[0], events: { sw1Press: { elements: [], extra: 1 } } }] }), /unsupported property/);
});

test("event upload commands stage settings and per-page event items", () => {
  const design = validateScreenDesign({
    version: 2,
    eventOptions: { duration: "HOLD", trigger: "RELEASE" },
    pages: [{
      id: "p1", name: "P", elements: [],
      events: { idle: { elements: [textElement("i", "IDLE")] }, sw3Press: { elements: [textElement("s", "CUT")] } }
    }]
  });
  const commands = buildScreenEventsUploadCommands(design);
  assert.equal(commands[0], "SCREEN EVENTS BEGIN");
  assert.equal(commands[1], "SCREEN EVENTS CLEAR");
  assert.ok(commands.includes("SCREEN EVENTS SETTINGS HOLD RELEASE"));
  assert.ok(commands.includes("SCREEN EVENT SELECT 0 IDLE"));
  assert.ok(commands.includes("SCREEN EVENT SELECT 0 SW3"));
  assert.ok(commands.some(c => c.startsWith("SCREEN EVENT ITEM ")));
  assert.equal(commands.at(-2), "SCREEN EVENTS VALIDATE");
  assert.equal(commands.at(-1), "SCREEN EVENTS COMMIT");
});

test("screen event item command encodes text and bitmap forms", () => {
  assert.equal(screenEventItemCommand(textElement("a", "Hi"), 2), "SCREEN EVENT ITEM 2 4 4 1 NORMAL STATIC LEFT 4869");
  const bitmap = { id: "b", type: "image", x: 0, y: 0, width: 8, height: 8, mode: "NORMAL", binding: "BITMAP", bitmap: "ff".repeat(8) };
  assert.match(screenEventItemCommand(bitmap, 0), /^SCREEN EVENT ITEM 0 0 0 8 NORMAL BITMAP 8 ff+$/);
});

const eventsDump = [
  "SCREEN EVENTS 2000 PRESS",
  "SCREEN EVENT 0 IDLE 1",
  "SCREEN ITEM 0 4 4 1 NORMAL STATIC LEFT 4f4b",
  "SCREEN EVENT END",
  "SCREEN EVENT 0 ENCW 1",
  "SCREEN ITEM 0 4 4 2 INVERSE STATIC CENTER 2b",
  "SCREEN EVENT END",
  "SCREEN EVENTS END"
].join("\r\n");

test("parseScreenEventsGet round trips options and per-page events", () => {
  const parsed = parseScreenEventsGet(eventsDump.split("\r\n"));
  assert.equal(parsed.supported, true);
  assert.deepEqual(parsed.eventOptions, { duration: "2000", trigger: "PRESS" });
  assert.equal(parsed.events["0"].idle.elements[0].text, "OK");
  assert.equal(parsed.events["0"].encoderCW.elements[0].text, "+");
  assert.equal(parsed.events["0"].encoderCW.elements[0].size, 2);
});

test("parseScreenEventsGet reports unsupported firmware on ERR", () => {
  const parsed = parseScreenEventsGet(["ERR unknown SCREEN command"]);
  assert.equal(parsed.supported, false);
});

// Minimal fake device that supports both page and event screen sessions.
function makeEventPort() {
  const commands = [];
  let pages = { version: 2, pages: [{ id: "screen-page-1", name: "Page 1", elements: createDefaultScreenDesign().pages[0].elements }] };
  let events = { eventOptions: { duration: "1500", trigger: "PRESS" }, pages: {} };
  const hex = text => Buffer.from(text, "ascii").toString("hex");
  const dumpPages = design => {
    const lines = [`SCREEN PAGES ${design.pages.length}`, "SCREEN CURRENT 0"];
    design.pages.forEach((page, i) => {
      lines.push(`SCREEN PAGE ${i} ${hex(page.name)}`);
      page.elements.forEach((el, j) => lines.push(screenItemCommand(el, j)));
      lines.push("SCREEN PAGE END");
    });
    lines.push("SCREEN END");
    return lines.join("\r\n") + "\r\n";
  };
  let legacyDraft = [];
  const dumpEvents = store => {
    const lines = [`SCREEN EVENTS ${store.eventOptions.duration} ${store.eventOptions.trigger}`];
    Object.entries(store.pages).forEach(([p, pageEvents]) => {
      for (const [token, ev] of Object.entries(pageEvents)) {
        lines.push(`SCREEN EVENT ${p} ${token} ${ev.elements.length}`);
        ev.elements.forEach((el, i) => lines.push(screenItemCommand(el, i)));
        lines.push("SCREEN EVENT END");
      }
    });
    lines.push("SCREEN EVENTS END");
    return lines.join("\r\n") + "\r\n";
  };
  class Port extends EventEmitter {
    static list() { return Promise.resolve([{ path: "/dev/ttyACM9", vendorId: "303a" }]); }
    constructor(options) { super(); this.path = options.path; this.isOpen = false; }
    open(cb) { this.isOpen = true; setImmediate(() => cb(null)); }
    write(data, cb) {
      const command = data.trim(); commands.push(command); cb(null);
      let response = "";
      if (command === "HELLO") response = "OK MACROPAD 2\r\n";
      else if (command === "SCREEN BEGIN") { legacyDraft = []; response = "OK SCREEN BEGIN\r\n"; }
      else if (command === "SCREEN CLEAR") { legacyDraft = []; response = "OK SCREEN CLEAR\r\n"; }
      else if (command.startsWith("SCREEN ITEM ")) { legacyDraft.push(command.slice("SCREEN ITEM ".length)); response = "OK SCREEN ITEM\r\n"; }
      else if (command === "SCREEN VALIDATE") response = "OK SCREEN VALID\r\n";
      else if (command === "SCREEN COMMIT") {
        pages = { version: 2, pages: [{ id: "screen-page-1", name: "Page 1", elements: parseScreenGet(legacyDraft.map(l => `SCREEN ITEM ${l}`)).design.pages[0].elements }] };
        response = "OK SCREEN COMMITTED\r\n";
      }
      else if (command === "SCREEN PAGES GET") response = dumpPages(pages);
      else if (command === "SCREEN PAGES BEGIN") { pages = { version: 2, pages: [] }; response = "OK SCREEN PAGES BEGIN\r\n"; }
      else if (command === "SCREEN PAGES CLEAR") { pages.pages = []; response = "OK SCREEN PAGES CLEAR\r\n"; }
      else if (command.startsWith("SCREEN PAGE ADD ")) {
        const m = command.match(/^SCREEN PAGE ADD (\d+) ([0-9a-f]+)$/i);
        pages.pages[Number(m[1])] = { id: `p${m[1]}`, name: Buffer.from(m[2], "hex").toString("ascii"), elements: [] };
        response = "OK SCREEN PAGE ADDED\r\n";
      } else if (command.startsWith("SCREEN PAGE ITEM ")) {
        const m = command.match(/^SCREEN PAGE ITEM (\d+) (.+)$/);
        const item = parseScreenGet([`SCREEN ITEM ${m[2]}`, "SCREEN END"]).design.pages[0].elements[0];
        response = "OK SCREEN PAGE ITEM\r\n";
      } else if (command === "SCREEN PAGES VALIDATE") response = "OK SCREEN PAGES VALID\r\n";
      else if (command === "SCREEN PAGES COMMIT") response = "OK SCREEN PAGES COMMITTED\r\n";
      else if (command === "SCREEN EVENTS GET") response = dumpEvents(events);
      else if (command === "SCREEN EVENTS BEGIN") { events = { eventOptions: { duration: "1500", trigger: "PRESS" }, pages: {} }; response = "OK SCREEN EVENTS BEGIN\r\n"; }
      else if (command === "SCREEN EVENTS CLEAR") { events.pages = {}; response = "OK SCREEN EVENTS CLEAR\r\n"; }
      else if (command.startsWith("SCREEN EVENTS SETTINGS ")) {
        const [, , , d, t] = command.split(" ");
        events.eventOptions = { duration: d, trigger: t };
        response = "OK SCREEN EVENTS SETTINGS\r\n";
      } else if (command.startsWith("SCREEN EVENT SELECT ")) {
        const [, , , p, ev] = command.split(" ");
        events.pages[p] = events.pages[p] || {};
        events.pages[p][ev] = { elements: [] };
        response = "OK SCREEN EVENT SELECTED\r\n";
      } else if (command.startsWith("SCREEN EVENT ITEM ")) {
        const args = command.slice("SCREEN EVENT ITEM ".length);
        const item = parseScreenGet([`SCREEN ITEM ${args}`, "SCREEN END"]).design.pages[0].elements[0];
        const lastPage = Object.keys(events.pages).at(-1);
        const lastEvent = Object.keys(events.pages[lastPage]).at(-1);
        events.pages[lastPage][lastEvent].elements.push(item);
        response = "OK SCREEN EVENT ITEM\r\n";
      } else if (command === "SCREEN EVENTS VALIDATE") response = "OK SCREEN EVENTS VALID\r\n";
      else if (command === "SCREEN EVENTS COMMIT") response = "OK SCREEN EVENTS COMMITTED\r\n";
      if (response) setImmediate(() => this.emit("data", Buffer.from(response)));
    }
    drain(cb) { cb(null); }
    close(cb) { this.isOpen = false; setImmediate(() => { this.emit("close"); cb(null); }); }
  }
  return { Port, commands, getPages: () => pages, getEvents: () => events };
}

test("event screens upload, verify readback, and round trip through the device", async () => {
  const { Port, commands } = makeEventPort();
  // Seed the fake with a committed page design first.
  const seed = createDefaultScreenDesign();
  const manager0 = new SerialManager({ SerialPort: Port, settleAfterOpenMs: 0, responseTimeoutMs: 60 });
  // pages start null; emulate prior upload by writing directly is not possible,
  // so seed via a first save of a plain design.
  await manager0.discover();
  await manager0.saveScreenDesign(seed);
  await manager0.disconnect();

  const design = createDefaultScreenDesign();
  design.eventOptions = { duration: "1000", trigger: "RELEASE" };
  design.pages[0].events = {
    idle: { elements: [textElement("ei", "MACROPAD")] },
    sw1Press: { elements: [textElement("s1", "PASTE"), textElement("s1b", "GUI+V", { y: 20 })] },
    encoderCW: { elements: [textElement("cw", "VOL+")] },
    encoderCCW: { elements: [textElement("ccw", "VOL-")] },
    encoderPress: { elements: [textElement("ep", "MUTE")] }
  };
  const manager = new SerialManager({ SerialPort: Port, settleAfterOpenMs: 0, responseTimeoutMs: 60 });
  await manager.discover();
  const result = await manager.saveScreenDesign(design);
  assert.equal(result.eventsSupported, true);
  assert.ok(commands.includes("SCREEN EVENTS BEGIN"));
  assert.ok(commands.includes("SCREEN EVENTS SETTINGS 1000 RELEASE"));
  assert.ok(commands.includes("SCREEN EVENT SELECT 0 SW1"));
  assert.ok(commands.includes("SCREEN EVENTS COMMIT"));
  const readback = result.design;
  assert.equal(readback.eventOptions.duration, "1000");
  assert.equal(readback.pages[0].events.sw1Press.elements.length, 2);
  assert.equal(readback.pages[0].events.encoderPress.elements[0].text, "MUTE");
  await manager.disconnect();
});

test("designs without event data skip the event session entirely", async () => {
  const { Port, commands } = makeEventPort();
  const manager = new SerialManager({ SerialPort: Port, settleAfterOpenMs: 0, responseTimeoutMs: 60 });
  await manager.discover();
  const result = await manager.saveScreenDesign(createDefaultScreenDesign());
  assert.equal(result.eventsSupported, true);
  assert.equal(commands.includes("SCREEN EVENTS BEGIN"), false);
  assert.equal(commands.includes("SCREEN EVENTS COMMIT"), false);
  await manager.disconnect();
});
