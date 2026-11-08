const { EventEmitter } = require("node:events");
const { SerialPort: NativeSerialPort } = require("serialport");
const { parseGet, buildSaveCommands, buildShortcutPagesCommands, parseShortcutPages, buildGameCommand } = require("./serial-protocol");
const { buildScreenUploadCommands, buildScreenPagesUploadCommands, buildScreenEventsUploadCommands, parseScreenGet, parseScreenPagesGet, parseScreenEventsGet, validateScreenDesign } = require("./screen-design");

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
      try {
        const macroLines = await this.requestLines("MACROS GET", line => line === "MACROS END" || /^ERR\b/.test(line), GET_TIMEOUT_MS);
        const pages = parseShortcutPages(macroLines);
        if (pages.supported) config.shortcutPages = pages.pages;
        config.shortcutPagesSupported = pages.supported;
      } catch { config.shortcutPagesSupported = false; }
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

  async getScreenDesignLocked() {
    const pageLines = await this.requestLines("SCREEN PAGES GET", line => line === "SCREEN END" || line.startsWith("ERR"), GET_TIMEOUT_MS);
    const pages = parseScreenPagesGet(pageLines);
    let base;
    if (pages.supported) base = pages;
    else {
      const legacyLines = await this.requestLines("SCREEN GET", line => line === "SCREEN END" || line.startsWith("ERR"), GET_TIMEOUT_MS);
      const legacy = parseScreenGet(legacyLines);
      base = legacy.supported ? { ...legacy, design: validateScreenDesign(legacy.design) } : { supported: false, multiPageSupported: false, design: null };
    }
    if (!base.supported || !base.design) return { ...base, eventsSupported: false };
    try {
      const eventLines = await this.requestLines("SCREEN EVENTS GET", line => line === "SCREEN EVENTS END" || line.startsWith("ERR"), GET_TIMEOUT_MS);
      const events = parseScreenEventsGet(eventLines);
      if (!events.supported) return { ...base, eventsSupported: false };
      const design = base.design;
      design.eventOptions = events.eventOptions;
      for (const [pageIndex, eventMap] of Object.entries(events.events || {})) {
        const page = design.pages[Number(pageIndex)];
        if (!page) continue;
        page.events = { ...(page.events || {}), ...eventMap };
      }
      return { ...base, eventsSupported: true };
    } catch {
      return { ...base, eventsSupported: false };
    }
  }

  getScreenDesign() {
    return this.withLock(async () => {
      this.setSync("reading", "Reading OLED screen design");
      try {
        const result = await this.getScreenDesignLocked();
        this.setSync("synchronized", result.supported ? "OLED design read from device" : "Firmware uses the built-in screen");
        return result;
      } catch (error) {
        this.setSync("failed", error.message);
        throw error;
      }
    });
  }

  async sendScreenCommand(command) {
    const lines = await this.requestLines(command, line => /^OK SCREEN\b|^ERR\b/.test(line), GET_TIMEOUT_MS);
    const response = lines.find(line => /^OK SCREEN\b|^ERR\b/.test(line));
    if (!response || response.startsWith("ERR")) throw new Error(response || `Firmware rejected ${command}`);
    return response;
  }

  saveScreenDesign(input) {
    return this.withLock(async () => {
      const design = validateScreenDesign(input);
      const pageCommands = design.pages.length === 1 ? buildScreenUploadCommands(design) : buildScreenPagesUploadCommands(design);
      const eventCommands = buildScreenEventsUploadCommands(design);
      const commands = [...pageCommands, ...eventCommands];
      const defaultEventOptions = { duration: "1500", trigger: "PRESS" };
      const hasEventData = design.pages.some(page => page.events && Object.keys(page.events).length)
        || (design.eventOptions && (design.eventOptions.duration !== defaultEventOptions.duration || design.eventOptions.trigger !== defaultEventOptions.trigger));
      this.setSync("saving", "Uploading OLED screen design");
      try {
        const capability = await this.getScreenDesignLocked();
        if (design.pages.length > 1 && !capability.multiPageSupported) throw new Error("This ESP32 firmware does not support multi-page OLED screens. Flash the updated firmware first.");
        if (hasEventData && !capability.eventsSupported) throw new Error("This ESP32 firmware does not support OLED event screens. Flash the updated firmware first.");
        for (const command of pageCommands) await this.sendScreenCommand(command);
        // Event screens are staged in a second session and only when the design
        // carries event data, so page-only uploads never disturb stored events.
        if (hasEventData) {
          for (const command of eventCommands) await this.sendScreenCommand(command);
        }
        const readback = await this.getScreenDesignLocked();
        if (design.pages.length > 1 && !readback.multiPageSupported) throw new Error("This ESP32 firmware does not support multi-page OLED screens. Flash the updated firmware first.");
        const cleanElement = ({ id, rotation, scale, threshold, dither, invert, crop, icon, source, rawImage, src, ...element }) => element;
        const cleanEvents = events => events && Object.keys(events).length
          ? Object.fromEntries(Object.entries(events).map(([eventId, event]) => [eventId, { elements: event.elements.map(cleanElement) }]))
          : undefined;
        const clean = value => JSON.stringify({
          pages: value.pages.map(page => ({ name: page.name, elements: page.elements.map(cleanElement), events: cleanEvents(page.events) })),
          eventOptions: value.eventOptions
        }, (key, child) => child && typeof child === "object" && !Array.isArray(child)
          ? Object.fromEntries(Object.entries(child).sort(([left], [right]) => left.localeCompare(right)))
          : child);
        const compareEvents = readback.eventsSupported === true && hasEventData;
        const expected = compareEvents
          ? { ...design, eventOptions: design.eventOptions || defaultEventOptions }
          : { ...design, pages: design.pages.map(page => ({ ...page, events: undefined })), eventOptions: undefined };
        const actual = compareEvents
          ? readback.design
          : { ...readback.design, pages: readback.design.pages.map(page => ({ ...page, events: undefined })), eventOptions: undefined };
        if (!readback.supported || clean(actual) !== clean(expected)) {
          throw new Error("Device screen design did not match the uploaded layout");
        }
        this.setSync("synchronized", "OLED screen design verified");
        return { sent: commands.length, design: readback.design, eventsSupported: readback.eventsSupported === true };
      } catch (error) {
        this.setSync("failed", error.message);
        throw error;
      }
    });
  }

  selectScreenPage(index) {
    if (!Number.isInteger(index) || index < 0 || index >= 8) return Promise.reject(new Error("OLED page index must be from 0 to 7"));
    return this.withLock(async () => {
      try { return await this.sendScreenCommand(`SCREEN PAGE SET ${index}`); }
      catch (error) {
        if (/unknown SCREEN command|unknown SCREEN PAGE command/i.test(error.message)) throw new Error("This ESP32 firmware does not support selecting OLED pages. Flash the updated firmware first.");
        throw error;
      }
    });
  }

  sendGameCommand(payload) {
    return this.withLock(async () => {
      const command = buildGameCommand(payload);
      const matchesResponse = line => /^OK GAME\b|^ERR\b/i.test(line) || (command === "GAME STATUS" && /^GAME STATE\b/i.test(line));
      const lines = await this.requestLines(command, matchesResponse, GET_TIMEOUT_MS);
      const response = lines.find(matchesResponse);
      if (!response || /^ERR\b/i.test(response)) throw new Error(response || `Firmware rejected ${command}`);
      return response;
    });
  }

  saveConfig(payload) {
    return this.withLock(async () => {
      const commands = buildSaveCommands(payload);
      const macroCommands = Array.isArray(payload.shortcutPages) && payload.shortcutPages.length > 1
        ? buildShortcutPagesCommands(payload.shortcutPages)
        : null;
      this.setSync("saving");
      try {
        if (macroCommands) {
          const capability = await this.requestLines("MACROS GET", line => line === "MACROS END" || /^ERR\b/.test(line), GET_TIMEOUT_MS);
          if (!parseShortcutPages(capability).supported) throw new Error("This ESP32 firmware does not support per-page shortcut profiles. Flash the updated firmware first.");
        }
        for (const command of commands) await this.writeLine(command);
        if (macroCommands) for (const command of macroCommands) await this.sendMacroCommand(command);
        await new Promise(resolve => setTimeout(resolve, 250));
        const lines = await this.requestLines("GET", line => line === "END", GET_TIMEOUT_MS);
        const config = parseGet(lines);
        if (payload.shortcutPages?.length) {
          const macroLines = await this.requestLines("MACROS GET", line => line === "MACROS END" || /^ERR\b/.test(line), GET_TIMEOUT_MS);
          const pageReadback = parseShortcutPages(macroLines);
          if (pageReadback.supported) config.shortcutPages = pageReadback.pages;
          else if (payload.shortcutPages.length > 1) throw new Error("Device did not retain the per-page shortcut configuration");
        }
        this.setSync("synchronized");
        return { sent: commands.length, config };
      } catch (error) {
        this.setSync("failed", error.message);
        throw error;
      }
    });
  }

  async sendMacroCommand(command) {
    const lines = await this.requestLines(command, line => /^OK MACROS\b|^ERR\b/.test(line), GET_TIMEOUT_MS);
    const response = lines.find(line => /^OK MACROS\b|^ERR\b/.test(line));
    if (!response || response.startsWith("ERR")) throw new Error(response || `Firmware rejected ${command}`);
    return response;
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
