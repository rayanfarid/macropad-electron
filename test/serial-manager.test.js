const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { SerialManager } = require("../serial-manager");
const { createDefaultConfig, firmwarePayload } = require("../app-config");
const { createDefaultScreenDesign, createDefaultScreenPage, screenItemCommand, parseScreenGet } = require("../screen-design");

const fixture = [
  "HOST OMARCHY",
  "LABEL 1 Browser",
  "LABEL CW Volume",
  "SET 1 OMARCHY GUI+B",
  "SET 4 WINDOWS CTRL+Z",
  "SET CW OMARCHY VOL_UP",
  "SET CCW OMARCHY VOL_DOWN",
  "SET PRESS OMARCHY MUTE",
  "END"
].join("\r\n") + "\r\n";

function makePortClass() {
  const ports = [];
  const commands = [];

  class FakePort extends EventEmitter {
    static list() { return Promise.resolve(ports.map(port => ({ ...port }))); }

    constructor(options) {
      super();
      this.path = options.path;
      this.isOpen = false;
      this.closed = false;
      FakePort.instances.push(this);
    }

    open(callback) {
      this.isOpen = true;
      setImmediate(() => callback(null));
    }

    write(data, callback) {
      const command = data.trim();
      commands.push({ path: this.path, command });
      callback(null);
      if (this.path === "/dev/ttyACM1" && command === "HELLO") {
        setTimeout(() => this.emit("data", Buffer.from("OK MACROPAD 2\r\n")), 1);
      }
      if (this.path === "/dev/ttyACM1" && command === "GET") {
        setTimeout(() => this.emit("data", Buffer.from(fixture)), 1);
      }
      if (this.path === "/dev/ttyACM1" && command === "MACROS GET") {
        setTimeout(() => this.emit("data", Buffer.from("ERR unknown MACROS command\r\n")), 1);
      }
    }

    drain(callback) { callback(null); }

    close(callback) {
      this.isOpen = false;
      this.closed = true;
      setImmediate(() => {
        this.emit("close");
        callback(null);
      });
    }
  }

  FakePort.instances = [];
  return { FakePort, ports, commands };
}

test("serial discovery accepts HELLO without END and closes unrelated ports", async () => {
  const { FakePort, ports } = makePortClass();
  ports.push(
    { path: "/dev/ttyACM0", vendorId: "1a86" },
    { path: "/dev/ttyACM1", vendorId: "303a" }
  );
  const manager = new SerialManager({ SerialPort: FakePort, settleAfterOpenMs: 0, responseTimeoutMs: 20 });
  const found = await manager.discover();
  assert.equal(found.path, "/dev/ttyACM1");
  assert.equal(found.response, "OK MACROPAD 2");
  assert.equal(FakePort.instances[0].closed, true);
  assert.equal(manager.activePath, "/dev/ttyACM1");
  await manager.disconnect();
});

test("GET parsing and ordered save commands use the existing protocol", async () => {
  const { FakePort, ports, commands } = makePortClass();
  ports.push({ path: "/dev/ttyACM1", vendorId: "303a" });
  const manager = new SerialManager({ SerialPort: FakePort, settleAfterOpenMs: 0, responseTimeoutMs: 100 });
  await manager.discover();
  const config = await manager.getConfig();
  assert.equal(config.host, "OMARCHY");
  assert.equal(config.labels["1"], "Browser");
  assert.equal(config.combos.OMARCHY.CW, "VOL_UP");

  const payload = firmwarePayload(createDefaultConfig());
  payload.host = "OMARCHY";
  payload.labels["1"] = "Browser";
  payload.combos.OMARCHY.CW = "VOL_UP";
  const result = await manager.saveConfig(payload);
  assert.equal(result.config.host, "OMARCHY");
  assert.ok(commands.some(item => item.command === "HOST OMARCHY"));
  assert.ok(commands.some(item => item.command === "LABEL 1 Browser"));
  assert.ok(commands.some(item => item.command === "SET CW OMARCHY VOL_UP"));
  assert.ok(commands.some(item => item.command === "SAVE"));
  assert.ok(commands.some(item => item.command === "GET"));
  assert.equal(commands.at(-2).command, "GET");
  assert.equal(commands.at(-1).command, "MACROS GET");
  await manager.disconnect();
});

test("serial errors reject pending reads and leave the device disconnected", async () => {
  const { FakePort, ports } = makePortClass();
  ports.push({ path: "/dev/ttyACM0", vendorId: "1a86" });
  const manager = new SerialManager({ SerialPort: FakePort, settleAfterOpenMs: 0, responseTimeoutMs: 10 });
  assert.equal(await manager.discover(), null);
  assert.equal(manager.activePort, null);
  await assert.rejects(manager.getConfig(), /Not connected/);
});

test("RESET is a distinct explicit command and is followed by a GET readback in the fake port", async () => {
  const { FakePort, ports, commands } = makePortClass();
  ports.push({ path: "/dev/ttyACM1", vendorId: "303a" });
  const manager = new SerialManager({ SerialPort: FakePort, settleAfterOpenMs: 0, responseTimeoutMs: 100 });
  await manager.discover();
  const config = await manager.resetConfig();
  assert.ok(commands.some(item => item.command === "RESET"));
  assert.ok(commands.some(item => item.command === "GET"));
  assert.equal(commands.at(-1).command, "MACROS GET");
  assert.equal(config.host, "OMARCHY");
  await manager.disconnect();
});

test("OLED screen upload uses acknowledged staging commands and verifies readback without SAVE or RESET", async () => {
  const ports = [{ path: "/dev/ttyACM1", vendorId: "303a" }];
  const commands = [];
  let active = createDefaultScreenDesign();
  let draft = [];
  class ScreenPort extends EventEmitter {
    static list() { return Promise.resolve(ports); }
    constructor(options) { super(); this.path = options.path; this.isOpen = false; }
    open(callback) { this.isOpen = true; setImmediate(() => callback(null)); }
    write(data, callback) {
      const command = data.trim(); commands.push(command); callback(null);
      let response = "";
      if (command === "HELLO") response = "OK MACROPAD 2\r\n";
      else if (command === "SCREEN PAGES GET") response = "ERR unknown SCREEN command\r\n";
      else if (command === "SCREEN EVENTS GET") response = "ERR unknown SCREEN command\r\n";
      else if (command === "SCREEN GET") {
        response = active.pages[0].elements.map((element, index) => screenItemCommand(element, index)).join("\r\n");
        response += `${response ? "\r\n" : ""}SCREEN END\r\n`;
      } else if (command === "SCREEN BEGIN") { draft = []; response = "OK SCREEN BEGIN\r\n"; }
      else if (command === "SCREEN CLEAR") { draft = []; response = "OK SCREEN CLEAR\r\n"; }
      else if (command.startsWith("SCREEN ITEM ")) { draft.push(command); response = "OK SCREEN ITEM\r\n"; }
      else if (command === "SCREEN VALIDATE") response = "OK SCREEN VALID\r\n";
      else if (command === "SCREEN COMMIT") {
        active = parseScreenGet(draft).design;
        response = "OK SCREEN COMMITTED\r\n";
      }
      if (response) setImmediate(() => this.emit("data", Buffer.from(response)));
    }
    drain(callback) { callback(null); }
    close(callback) { this.isOpen = false; setImmediate(() => { this.emit("close"); callback(null); }); }
  }
  const manager = new SerialManager({ SerialPort: ScreenPort, settleAfterOpenMs: 0, responseTimeoutMs: 60 });
  await manager.discover();
  const local = createDefaultScreenDesign();
  local.pages[0].elements[1].text = "Now playing";
  local.pages[0].elements[1].x = 14;
  const result = await manager.saveScreenDesign(local);
  assert.equal(result.design.pages[0].elements[1].text, "Now playing");
  assert.ok(commands.includes("SCREEN BEGIN"));
  assert.ok(commands.includes("SCREEN VALIDATE"));
  assert.ok(commands.includes("SCREEN COMMIT"));
  assert.ok(commands.includes("SCREEN GET"));
  assert.equal(commands.includes("SAVE"), false);
  assert.equal(commands.includes("RESET"), false);
  await manager.disconnect();
});

test("OLED page selection is validated and uses the firmware SCREEN PAGE SET command", async () => {
  const manager = new SerialManager({ SerialPort: {} });
  const sent = [];
  manager.sendScreenCommand = async command => { sent.push(command); return "OK SCREEN PAGE SELECTED"; };
  assert.equal(await manager.selectScreenPage(2), "OK SCREEN PAGE SELECTED");
  assert.deepEqual(sent, ["SCREEN PAGE SET 2"]);
  await assert.rejects(manager.selectScreenPage(8), /index must be from 0 to 7/);
});

test("game command sender uses the shared serial queue and firmware GAME protocol", async () => {
  const manager = new SerialManager({ SerialPort: {} });
  const sent = [];
  manager.requestLines = async (command, matches) => {
    sent.push(command);
    const response = command.startsWith("GAME START ") ? `OK ${command}` : "OK GAME EXIT";
    assert.equal(matches(response), true);
    return [response];
  };
  assert.equal(await manager.sendGameCommand({ action: "start", game: "snake" }), "OK GAME START SNAKE");
  assert.equal(await manager.sendGameCommand({ action: "exit" }), "OK GAME EXIT");
  assert.equal(await manager.sendGameCommand({ action: "start", game: "pong" }), "OK GAME START PONG");
  assert.deepEqual(sent, ["GAME START SNAKE", "GAME EXIT", "GAME START PONG"]);
  await assert.rejects(manager.sendGameCommand({ action: "start", game: "unknown" }), /Unsupported/);
});

test("multi-page OLED upload uses SCREEN PAGES commands and rejects unsupported firmware", async () => {
  const ports = [{ path: "/dev/ttyACM2", vendorId: "303a" }];
  const commands = [];
  let active = createDefaultScreenDesign();
  let draft = null;
  const hex = text => Buffer.from(text, "ascii").toString("hex");
  const dumpPages = design => {
    const lines = [`SCREEN PAGES ${design.pages.length}`, `SCREEN CURRENT 0`];
    design.pages.forEach((page, pageIndex) => {
      lines.push(`SCREEN PAGE ${pageIndex} ${hex(page.name)}`);
      page.elements.forEach((element, elementIndex) => lines.push(screenItemCommand(element, elementIndex)));
      lines.push("SCREEN PAGE END");
    });
    lines.push("SCREEN END");
    return `${lines.join("\r\n")}\r\n`;
  };
  class MultiPagePort extends EventEmitter {
    static list() { return Promise.resolve(ports); }
    constructor(options) { super(); this.path = options.path; this.isOpen = false; }
    open(callback) { this.isOpen = true; setImmediate(() => callback(null)); }
    write(data, callback) {
      const command = data.trim(); commands.push(command); callback(null);
      let response = "";
      if (command === "HELLO") response = "OK MACROPAD 2\r\n";
      else if (command === "SCREEN PAGES GET") response = dumpPages(active);
      else if (command === "SCREEN EVENTS GET") response = "ERR unknown SCREEN command\r\n";
      else if (command === "SCREEN PAGES BEGIN") { draft = JSON.parse(JSON.stringify(active)); response = "OK SCREEN PAGES BEGIN\r\n"; }
      else if (command === "SCREEN PAGES CLEAR") { draft = { version: 2, pages: [] }; response = "OK SCREEN PAGES CLEAR\r\n"; }
      else if (command.startsWith("SCREEN PAGE ADD ")) {
        const match = command.match(/^SCREEN PAGE ADD (\d+) ([0-9a-f]+)$/i);
        const index = Number(match[1]);
        const name = Buffer.from(match[2], "hex").toString("ascii");
        draft.pages[index] = { id: `page-${index + 1}`, name, elements: [] };
        response = "OK SCREEN PAGE ADDED\r\n";
      } else if (command.startsWith("SCREEN PAGE ITEM ")) {
        const match = command.match(/^SCREEN PAGE ITEM (\d+) (.+)$/);
        const pageIndex = Number(match[1]);
        const item = parseScreenGet([`SCREEN ITEM ${match[2]}`, "SCREEN END"]).design.pages[0].elements[0];
        draft.pages[pageIndex].elements.push(item);
        response = "OK SCREEN PAGE ITEM\r\n";
      } else if (command === "SCREEN PAGES VALIDATE") response = "OK SCREEN PAGES VALID\r\n";
      else if (command === "SCREEN PAGES COMMIT") { active = draft; response = "OK SCREEN PAGES COMMITTED\r\n"; }
      if (response) setImmediate(() => this.emit("data", Buffer.from(response)));
    }
    drain(callback) { callback(null); }
    close(callback) { this.isOpen = false; setImmediate(() => { this.emit("close"); callback(null); }); }
  }
  const manager = new SerialManager({ SerialPort: MultiPagePort, settleAfterOpenMs: 0, responseTimeoutMs: 60 });
  await manager.discover();
  const design = createDefaultScreenDesign();
  design.pages.push({
    id: "screen-page-2",
    name: "Page 2",
    elements: [{ id: "host-only", x: 4, y: 4, size: 1, mode: "NORMAL", alignment: "LEFT", binding: "HOST", text: "" }]
  });
  const result = await manager.saveScreenDesign(design);
  assert.equal(result.design.pages.length, 2);
  assert.equal(result.design.pages[1].name, "Page 2");
  assert.ok(commands.includes("SCREEN PAGES BEGIN"));
  assert.ok(commands.includes("SCREEN PAGES VALIDATE"));
  assert.ok(commands.includes("SCREEN PAGES COMMIT"));
  assert.equal(commands.includes("SAVE"), false);
  assert.equal(commands.includes("RESET"), false);
  await manager.disconnect();

  class LegacyPort extends EventEmitter {
    static list() { return Promise.resolve([{ path: "/dev/ttyACM3", vendorId: "303a" }]); }
    constructor(options) { super(); this.path = options.path; this.isOpen = false; }
    open(callback) { this.isOpen = true; setImmediate(() => callback(null)); }
    write(data, callback) {
      const command = data.trim(); callback(null);
      let response = "";
      if (command === "HELLO") response = "OK MACROPAD 2\r\n";
      else if (command === "SCREEN PAGES GET") response = "ERR unknown SCREEN command\r\n";
      else if (command === "SCREEN EVENTS GET") response = "ERR unknown SCREEN command\r\n";
      else if (command === "SCREEN GET") response = `${screenItemCommand(createDefaultScreenPage().elements[0], 0)}\r\nSCREEN END\r\n`;
      if (response) setImmediate(() => this.emit("data", Buffer.from(response)));
    }
    drain(callback) { callback(null); }
    close(callback) { this.isOpen = false; setImmediate(() => { this.emit("close"); callback(null); }); }
  }
  const legacy = new SerialManager({ SerialPort: LegacyPort, settleAfterOpenMs: 0, responseTimeoutMs: 60 });
  await legacy.discover();
  await assert.rejects(legacy.saveScreenDesign(design), /does not support multi-page OLED screens/);
  await legacy.disconnect();
});
