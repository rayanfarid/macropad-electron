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

module.exports = { HOSTS, BUTTON_SLOTS, ENCODER_SLOTS, ALL_SLOTS, SLOTS, parseGet, buildSaveCommands };
