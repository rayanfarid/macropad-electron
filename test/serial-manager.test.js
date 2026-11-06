const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { SerialManager } = require("../serial-manager");
const { createDefaultConfig, firmwarePayload } = require("../app-config");

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
  assert.equal(commands.at(-1).command, "GET");
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
  assert.equal(commands.at(-1).command, "GET");
  assert.equal(config.host, "OMARCHY");
  await manager.disconnect();
});
