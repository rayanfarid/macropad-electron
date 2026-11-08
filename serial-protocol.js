const HOSTS = new Set(["WINDOWS", "LINUX", "MACOS", "OMARCHY"]);
const BUTTON_SLOTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const ENCODER_SLOTS = ["CW", "CCW", "PRESS"];
const ALL_SLOTS = [...BUTTON_SLOTS, ...ENCODER_SLOTS];
const SLOTS = new Set(ALL_SLOTS);

function parseGet(lines) {
  const result = { host: "WINDOWS", labels: {}, combos: {} };

  for (const rawLine of lines) {
    const line = String(rawLine).trim();
    if (!line || line === "END") continue;

    let match = line.match(/^HOST\s+(\S+)$/i);
    if (match) {
      result.host = match[1].toUpperCase();
      continue;
    }

    match = line.match(/^LABEL\s+(\S+)(?:\s+(.*))?$/i);
    if (match) {
      result.labels[match[1].toUpperCase()] = (match[2] || "").trim();
      continue;
    }

    match = line.match(/^SET\s+(\S+)\s+(\S+)(?:\s+(.*))?$/i);
    if (match) {
      const slot = match[1].toUpperCase();
      const host = match[2].toUpperCase();
      if (!result.combos[host]) result.combos[host] = {};
      result.combos[host][slot] = (match[3] || "").trim();
    }
  }

  return result;
}

function rejectLineBreak(value, description) {
  if (/[\r\n]/.test(value)) throw new Error(`${description} cannot contain a line break`);
}

function encodeMacroText(value) {
  const text = String(value ?? "");
  if (!/^[\x20-\x7e]{0,20}$/.test(text)) throw new Error("Page names and button labels must be printable ASCII");
  return text ? Buffer.from(text, "ascii").toString("hex") : "-";
}

function decodeMacroText(value) {
  if (value === "-") return "";
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error("Firmware returned invalid page text");
  const text = Buffer.from(value, "hex").toString("ascii");
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error("Firmware returned unsupported page text");
  return text;
}

function buildShortcutPagesCommands(pages) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 8) throw new Error("Shortcut configuration must contain 1–8 pages");
  const commands = ["MACROS BEGIN", "MACROS CLEAR"];
  pages.forEach((page, pageIndex) => {
    if (!page || typeof page.id !== "string" || !/^[a-z0-9-]{1,24}$/i.test(page.id)) throw new Error(`Invalid shortcut page ${pageIndex + 1} id`);
    if (typeof page.name !== "string" || page.name.length < 1 || page.name.length > 20) throw new Error(`Invalid shortcut page ${pageIndex + 1} name`);
    commands.push(`MACROS PAGE ${pageIndex} ${encodeMacroText(page.id)} ${encodeMacroText(page.name)}`);
    for (const slot of BUTTON_SLOTS.slice(0, 6)) {
      commands.push(`MACROS LABEL ${pageIndex} ${slot} ${encodeMacroText(page.labels?.[slot])}`);
      for (const host of HOSTS) {
        const combo = String(page.profiles?.[host]?.[slot] ?? "NONE").trim().toUpperCase() || "NONE";
        rejectLineBreak(combo, `Shortcut for page ${pageIndex + 1} SW${slot}`);
        if (combo.length > 23 || !/^[A-Z0-9_+.-]+$/.test(combo)) throw new Error(`Invalid shortcut for page ${pageIndex + 1} SW${slot}`);
        commands.push(`MACROS SET ${pageIndex} ${slot} ${host} ${combo}`);
      }
    }
  });
  commands.push("MACROS VALIDATE", "MACROS COMMIT");
  return commands;
}

function parseShortcutPages(lines) {
  if (lines.some(raw => /^ERR\b/i.test(String(raw).trim()))) return { supported: false, pages: null };
  const normalized = lines.map(raw => String(raw).trim());
  const header = normalized.map(line => line.match(/^MACROS PAGES (\d+)$/)).find(Boolean);
  if (!header) return { supported: false, pages: null };
  const count = Number(header[1]);
  if (count < 1 || count > 8) throw new Error("Device returned an invalid shortcut page count");
  const pages = Array.from({ length: count }, () => ({ id: "", name: "", labels: {}, profiles: Object.fromEntries([...HOSTS].map(host => [host, {}])) }));
  for (const line of normalized) {
    let match = line.match(/^MACRO PAGE (\d+) ([0-9a-f-]+) ([0-9a-f-]+)$/i);
    if (match) {
      const index = Number(match[1]);
      if (!pages[index]) throw new Error("Device returned an invalid shortcut page index");
      pages[index].id = decodeMacroText(match[2]); pages[index].name = decodeMacroText(match[3]);
      continue;
    }
    match = line.match(/^MACRO LABEL (\d+) ([1-6]) ([0-9a-f-]+)$/i);
    if (match) {
      const page = pages[Number(match[1])];
      if (!page) throw new Error("Device returned an invalid shortcut label page");
      page.labels[match[2]] = decodeMacroText(match[3]);
      continue;
    }
    match = line.match(/^MACRO SET (\d+) ([1-6]) (WINDOWS|LINUX|MACOS|OMARCHY) (\S+)$/i);
    if (match) {
      const page = pages[Number(match[1])];
      if (!page) throw new Error("Device returned an invalid shortcut assignment page");
      page.profiles[match[3].toUpperCase()][match[2]] = match[4].toUpperCase();
    }
  }
  if (pages.some(page => !page.id || !page.name || BUTTON_SLOTS.slice(0, 6).some(slot => !(slot in page.labels)) || [...HOSTS].some(host => BUTTON_SLOTS.slice(0, 6).some(slot => !(slot in page.profiles[host]))))) {
    throw new Error("Device returned incomplete shortcut page data");
  }
  return { supported: true, pages };
}

function previousShortcutPageIndex(currentPage, pageCount) {
  if (!Number.isInteger(currentPage) || !Number.isInteger(pageCount) || pageCount < 1 || pageCount > 8 || currentPage < 0 || currentPage >= pageCount) throw new Error("Current shortcut page is invalid");
  return Math.max(0, currentPage - 1);
}

function buildSaveCommands(payload = {}) {
  const commands = [];
  const host = String(payload.host || "").trim().toUpperCase();
  if (host) {
    if (!HOSTS.has(host)) throw new Error(`Unsupported host profile: ${host}`);
    commands.push(`HOST ${host}`);
  }

  for (const [rawSlot, rawLabel] of Object.entries(payload.labels || {})) {
    const slot = rawSlot.toUpperCase();
    if (!SLOTS.has(slot)) throw new Error(`Unsupported label slot: ${rawSlot}`);
    const label = String(rawLabel ?? "").trim().slice(0, 8).trimEnd();
    rejectLineBreak(label, `Label for ${slot}`);
    commands.push(`LABEL ${slot}${label ? ` ${label}` : ""}`);
  }

  for (const [rawHost, slots] of Object.entries(payload.combos || {})) {
    const os = rawHost.toUpperCase();
    if (!HOSTS.has(os)) throw new Error(`Unsupported host profile: ${rawHost}`);
    for (const [rawSlot, rawCombo] of Object.entries(slots || {})) {
      const slot = rawSlot.toUpperCase();
      if (!SLOTS.has(slot)) throw new Error(`Unsupported shortcut slot: ${rawSlot}`);
      const combo = String(rawCombo ?? "").trim().toUpperCase() || "NONE";
      rejectLineBreak(combo, `Shortcut for ${slot}`);
      commands.push(`SET ${slot} ${os} ${combo}`);
    }
  }

  commands.push("SAVE");
  return commands;
}

function buildGameCommand(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Game command is invalid");
  if (payload.action === "menu") return "GAME START MENU";
  if (payload.action === "exit") return "GAME EXIT";
  if (payload.action === "status") return "GAME STATUS";
  if (payload.action === "start" && typeof payload.game === "string") {
    const games = {
      snake: "SNAKE", ttt: "TTT", pong: "PONG", "2048": "2048",
      minesweeper: "MINESWEEPER", memory: "MEMORY", simon: "SIMON",
      lightsout: "LIGHTS_OUT", whack: "WHACK"
    };
    if (games[payload.game]) return `GAME START ${games[payload.game]}`;
  }
  throw new Error("Unsupported game command");
}

module.exports = { HOSTS, BUTTON_SLOTS, ENCODER_SLOTS, ALL_SLOTS, SLOTS, parseGet, buildSaveCommands, buildShortcutPagesCommands, parseShortcutPages, previousShortcutPageIndex, buildGameCommand };
