const { EventEmitter } = require("node:events");
const { SerialPort: NativeSerialPort } = require("serialport");
const { parseGet, buildSaveCommands } = require("./serial-protocol");

const HELLO_TIMEOUT_MS = 1800;
const GET_TIMEOUT_MS = 5000;

class SerialManager extends EventEmitter {
  constructor({ SerialPort = NativeSerialPort, settleAfterOpenMs = 250, responseTimeoutMs = HELLO_TIMEOUT_MS } = {}) {
    super();
    this.SerialPort = SerialPort;
    this.settleAfterOpenMs = settleAfterOpenMs;
    this.responseTimeoutMs = responseTimeoutMs;
    this.activePort = null;
    this.activePath = null;
    this.activeInfo = null;
    this.rxBuffer = "";
    this.responseWaiter = null;
    this.queueTail = Promise.resolve();
    this.discoveryTask = null;
  }

  setSync(state, detail = "") {
    this.emit("sync", { state, detail, timestamp: new Date().toISOString() });
  }

  listPorts() {
    return this.SerialPort.list();
  }

  withLock(task) {
    const result = this.queueTail.then(task, task);
    this.queueTail = result.catch(() => {});
    return result;
  }

  clearResponseWaiter(error) {
    if (!this.responseWaiter) return;
    const waiter = this.responseWaiter;
    this.responseWaiter = null;
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
  }

  handleData(data) {
    this.rxBuffer += data.toString("utf8");
    const lines = this.rxBuffer.split(/\r?\n/);
    this.rxBuffer = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      this.emit("line", line);
      const waiter = this.responseWaiter;
      if (!waiter) continue;
      waiter.lines.push(line);
      if (waiter.matches(line)) {
        this.responseWaiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(waiter.lines);
      }
    }
  }

  open(info) {
    return new Promise((resolve, reject) => {
      const port = new this.SerialPort({ path: info.path, baudRate: 115200, autoOpen: false });
      port.on("data", data => this.handleData(data));
      port.on("error", error => {
        this.emit("connection-error", { path: info.path, message: error.message });
        this.clearResponseWaiter(error);
        if (this.activePort === port) this.setSync("failed", error.message);
      });
      port.on("close", () => {
        if (this.activePort !== port) return;
        this.activePort = null;
        this.activePath = null;
        this.activeInfo = null;
        this.rxBuffer = "";
        this.clearResponseWaiter(new Error("Serial device disconnected"));
        this.emit("connection", { connected: false });
        this.setSync("disconnected");
      });
      port.open(error => {
        if (error) {
          reject(error);
          return;
        }
        this.activePort = port;
        this.activePath = info.path;
        this.activeInfo = info;
        this.rxBuffer = "";
        this.emit("connection", { connected: true, path: info.path, info });
        resolve();
      });
    });
  }

  writeLine(line) {
    return new Promise((resolve, reject) => {
      const port = this.activePort;
      if (!port || !port.isOpen) {
        reject(new Error("Not connected to a serial device"));
        return;
      }
      port.write(`${line}\n`, error => {
        if (error) {
          reject(error);
          return;
        }
        port.drain(drainError => drainError ? reject(drainError) : resolve());
      });
    });
  }

  async requestLines(line, matches, timeoutMs) {
    if (this.responseWaiter) throw new Error("A serial response is already pending");
    const response = new Promise((resolve, reject) => {
      const waiter = { lines: [], matches, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        if (this.responseWaiter !== waiter) return;
        this.responseWaiter = null;
        reject(new Error(`Timed out waiting for a response to ${line}`));
      }, timeoutMs);
      this.responseWaiter = waiter;
    });
    try {
      await this.writeLine(line);
    } catch (error) {
      this.clearResponseWaiter(error);
    }
    return response;
  }

  candidatePorts(ports) {
    return ports
      .filter(info => info.path && (/^\/dev\/tty(ACM|USB)/.test(info.path) || info.vendorId))
      .sort((a, b) => {
        const score = info => (/^\/dev\/tty(ACM|USB)/.test(info.path) ? 2 : 0) + (info.vendorId ? 1 : 0);
        return score(b) - score(a);
      });
  }

  discoverLocked() {
    return this._discoverLocked();
  }

  async _discoverLocked() {
    this.setSync("disconnected", "Searching for Macropad");
    const ports = this.candidatePorts(await this.listPorts());
    for (const info of ports) {
      await this.closeActive();
      try {
        await this.open(info);
        await new Promise(resolve => setTimeout(resolve, this.settleAfterOpenMs));
        const lines = await this.requestLines("HELLO", line => line === "OK MACROPAD 2", this.responseTimeoutMs);
        const found = { path: info.path, info, response: lines.find(line => line === "OK MACROPAD 2") };
        this.emit("discovered", found);
        return found;
      } catch (error) {
        this.emit("connection-error", { path: info.path, message: error.message });
        await this.closeActive();
      }
    }
    await this.closeActive();
    this.emit("discovered", null);
    return null;
  }

  discover() {
    if (this.discoveryTask) return this.discoveryTask;
    this.discoveryTask = this.withLock(() => this.discoverLocked()).finally(() => {
      this.discoveryTask = null;
    });
    return this.discoveryTask;
  }

  async closePort(port) {
    if (!port || !port.isOpen) return;
    await new Promise(resolve => port.close(() => resolve()));
  }

  async closeActive() {
    const port = this.activePort;
    this.activePort = null;
    this.activePath = null;
    this.activeInfo = null;
    this.rxBuffer = "";
    this.clearResponseWaiter(new Error("Serial connection closed"));
    await this.closePort(port);
    this.emit("connection", { connected: false });
  }

  async getConfigLocked() {
    this.setSync("reading");
    try {
      const lines = await this.requestLines("GET", line => line === "END", GET_TIMEOUT_MS);
      const config = parseGet(lines);
      this.setSync("synchronized");
      return config;
    } catch (error) {
      this.setSync("failed", error.message);
      throw error;
    }
  }

  getConfig() {
    return this.withLock(() => this.getConfigLocked());
  }

  saveConfig(payload) {
    return this.withLock(async () => {
      const commands = buildSaveCommands(payload);
      this.setSync("saving");
      try {
        for (const command of commands) await this.writeLine(command);
        await new Promise(resolve => setTimeout(resolve, 250));
        const lines = await this.requestLines("GET", line => line === "END", GET_TIMEOUT_MS);
        const config = parseGet(lines);
        this.setSync("synchronized");
        return { sent: commands.length, config };
      } catch (error) {
        this.setSync("failed", error.message);
        throw error;
      }
    });
  }

  resetConfig() {
    return this.withLock(async () => {
      this.setSync("saving", "Resetting device configuration");
      try {
        await this.writeLine("RESET");
        await new Promise(resolve => setTimeout(resolve, 300));
        return await this.getConfigLocked();
      } catch (error) {
        this.setSync("failed", error.message);
        throw error;
      }
    });
  }

  disconnect() {
    return this.withLock(async () => {
      await this.closeActive();
      this.setSync("disconnected");
      return true;
    });
  }

  getConnectionInfo() {
    return this.activePort ? { connected: true, path: this.activePath, ...this.activeInfo } : { connected: false };
  }
}

module.exports = { SerialManager, HELLO_TIMEOUT_MS, GET_TIMEOUT_MS };
