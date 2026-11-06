const BUTTON_SLOTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const ENCODER_SLOTS = ["CW", "CCW", "PRESS"];
const HOSTS = ["WINDOWS", "LINUX", "MACOS", "OMARCHY"];
const HOST_LABELS = { WINDOWS: "Windows", LINUX: "Linux", MACOS: "macOS", OMARCHY: "Omarchy" };
const PAGE_LABELS = {
  dashboard: ["MACROPAD CONTROL", "Dashboard"],
  buttons: ["PHYSICAL KEY CONFIGURATION", "Button editor"],
  encoder: ["ROTARY CONTROL", "Encoder settings"],
  layout: ["LOCAL APPEARANCE", "Layout editor"],
  settings: ["APPLICATION", "Settings"]
};
const SLOT_TITLES = { CW: "Clockwise", CCW: "Counterclockwise", PRESS: "Encoder press" };
const DEFAULT_ACTIONS = Object.fromEntries([...BUTTON_SLOTS, ...ENCODER_SLOTS].map(slot => [slot, "NONE"]));

let config = null;
let configLoaded = false;
let configLoadTask = null;
let persistTimer = null;
let connection = { connected: false };
let connectionInfo = { ports: [] };
let syncState = { state: "disconnected", detail: "" };
let lastSyncAt = null;
let selectedSlot = "1";
let selectedLayoutSlot = "1";
let layoutDraft = null;
let layoutEditing = false;
let importPreview = null;
let queuedDiscovery = undefined;
const unsubscribeEvents = [];

const $ = id => document.getElementById(id);

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  const logElement = $("activityLog");
  logElement.textContent += `${line}\n`;
  logElement.scrollTop = logElement.scrollHeight;
}

function toast(message, isError = false) {
  const element = $("toast");
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 6000);
}

function formatError(error) {
  return error && error.message ? error.message : String(error);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultLayout() {
  const positions = {};
  BUTTON_SLOTS.forEach((slot, index) => {
    positions[slot] = { row: Math.floor(index / 3), column: index % 3, rowSpan: 1, columnSpan: 1 };
  });
  return { rows: 3, columns: 3, positions };
}

function validateLayout(layout) {
  if (!layout || layout.rows !== 3 || layout.columns !== 3 || !layout.positions) throw new Error("Layout must be a 3×3 grid");
  if (Object.keys(layout.positions).length !== BUTTON_SLOTS.length || BUTTON_SLOTS.some(slot => !layout.positions[slot])) {
    throw new Error("Layout must contain all nine physical button slots");
  }
  const occupied = new Set();
  for (const slot of BUTTON_SLOTS) {
    const position = layout.positions[slot];
    const { row, column, rowSpan = 1, columnSpan = 1 } = position;
    if (![row, column, rowSpan, columnSpan].every(Number.isInteger) || row < 0 || column < 0 || rowSpan < 1 || columnSpan < 1 || row + rowSpan > 3 || column + columnSpan > 3) {
      throw new Error(`Visual size or position for SW${slot} is outside the 3×3 grid`);
    }
    for (let r = row; r < row + rowSpan; r++) for (let c = column; c < column + columnSpan; c++) {
      const cell = `${r}:${c}`;
      if (occupied.has(cell)) throw new Error("That visual change would overlap another key");
      occupied.add(cell);
    }
  }
  return clone(layout);
}

function swapLayoutSlots(layout, firstSlot, secondSlot) {
  const next = validateLayout(layout);
  if (!next.positions[firstSlot] || !next.positions[secondSlot]) throw new Error("Unknown physical key");
  const first = next.positions[firstSlot];
  const second = next.positions[secondSlot];
  next.positions[firstSlot] = { ...first, row: second.row, column: second.column };
  next.positions[secondSlot] = { ...second, row: first.row, column: first.column };
  return validateLayout(next);
}

function resizeLayoutSlot(layout, slot, rowSpan, columnSpan) {
  const next = validateLayout(layout);
  if (!next.positions[slot]) throw new Error(`Unknown physical key: ${slot}`);
  next.positions[slot] = { ...next.positions[slot], rowSpan, columnSpan };
  return validateLayout(next);
}

function mergeDeviceConfig(deviceConfig, previous) {
  const next = clone(previous);
  if (HOSTS.includes(deviceConfig.host)) next.host = deviceConfig.host;
  next.deviceWritePending = false;
  next.labels = Object.fromEntries([...BUTTON_SLOTS, ...ENCODER_SLOTS].map(slot => [slot, String(deviceConfig.labels?.[slot] ?? "").slice(0, 8)]));
  next.profiles = Object.fromEntries(HOSTS.map(host => [host,
    Object.fromEntries([...BUTTON_SLOTS, ...ENCODER_SLOTS].map(slot => [slot, String(deviceConfig.combos?.[host]?.[slot] ?? "NONE")]))
  ]));
  return next;
}

function titleForSlot(slot) {
  return SLOT_TITLES[slot] || `Button ${slot}`;
}

function isConfigured(slot) {
  return Boolean(config?.profiles?.[config.host]?.[slot] && config.profiles[config.host][slot] !== "NONE");
}

function applyTheme() {
  document.documentElement.dataset.theme = config?.preferences?.theme || "dark";
  document.documentElement.style.setProperty("--key-gap", `${config?.preferences?.gridGap || 12}px`);
}

function persistSoon() {
  if (!configLoaded || !config) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistNow().catch(error => toast(`Could not save local settings: ${formatError(error)}`, true));
  }, 240);
}

async function persistNow() {
  clearTimeout(persistTimer);
  persistTimer = null;
  if (!configLoaded || !config) return;
  config = await window.macropad.saveAppConfig(config);
}

function markDevicePending() {
  config.deviceWritePending = true;
  persistSoon();
  renderSyncSummary();
}

function slotPosition(slot, layout = config.layout) {
  return layout.positions[slot];
}

function createKeyButton(slot, { layout = config.layout, compact = false, draggable = false, selected = false } = {}) {
  const position = slotPosition(slot, layout);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `key-button${selected ? " selected" : ""}${slot === selectedLayoutSlot && layoutEditing ? " layout-selected" : ""}`;
  button.dataset.slot = slot;
  button.title = `Physical firmware slot ${slot}`;
  button.setAttribute("aria-label", `Physical slot ${slot}, ${config.labels[slot] || "Unlabeled"}, ${config.profiles[config.host][slot] || "NONE"}`);
  button.draggable = draggable;
  if (position) {
    button.style.gridRow = `${position.row + 1} / span ${position.rowSpan}`;
    button.style.gridColumn = `${position.column + 1} / span ${position.columnSpan}`;
  }

  const physical = document.createElement("span");
  physical.className = "key-slot";
  physical.textContent = `SW${slot}`;
  const label = document.createElement("span");
  label.className = "key-label";
  label.textContent = config.labels[slot] || "Unassigned";
  const shortcut = document.createElement("span");
  shortcut.className = "key-shortcut";
  shortcut.textContent = config.profiles[config.host][slot] || "NONE";
  button.append(physical, label, shortcut);
  if (compact) button.classList.add("compact-key");
  return button;
}

function renderBoard(container, options = {}) {
  container.replaceChildren();
  container.style.setProperty("--key-gap", `${config.preferences.gridGap}px`);
  for (const slot of BUTTON_SLOTS) {
    const button = createKeyButton(slot, { ...options, selected: slot === selectedSlot && options.editor });
    button.addEventListener("click", () => {
      if (options.layout) {
        selectedLayoutSlot = slot;
        if (layoutEditing) renderLayoutBoard();
        else {
          selectedSlot = slot;
          showPage("buttons");
        }
        return;
      }
      selectedSlot = slot;
      renderButtonEditor();
      showPage("buttons");
    });
    if (options.draggable) {
      button.addEventListener("dragstart", event => {
        event.dataTransfer.setData("text/plain", slot);
        event.dataTransfer.effectAllowed = "move";
        button.classList.add("dragging");
      });
      button.addEventListener("dragend", () => button.classList.remove("dragging", "drop-target"));
      button.addEventListener("dragover", event => {
        event.preventDefault();
        button.classList.add("drop-target");
      });
      button.addEventListener("dragleave", () => button.classList.remove("drop-target"));
      button.addEventListener("drop", event => {
        event.preventDefault();
        button.classList.remove("drop-target");
        const source = event.dataTransfer.getData("text/plain");
        if (!source || source === slot) return;
        try {
          layoutDraft = swapLayoutSlots(layoutDraft, source, slot);
          selectedLayoutSlot = source;
          renderLayoutBoard();
          updateLayoutInspector();
        } catch (error) {
          toast(formatError(error), true);
        }
      });
    }
    container.appendChild(button);
  }
}

function renderEncoderSummary() {
  const container = $("dashboardEncoder");
  container.replaceChildren();
  for (const slot of ENCODER_SLOTS) {
    const row = document.createElement("div");
    row.className = "encoder-summary-item";
    const label = document.createElement("span");
    label.textContent = SLOT_TITLES[slot];
    const action = document.createElement("kbd");
    action.textContent = config.profiles[config.host][slot] || "NONE";
    row.append(label, action);
    container.appendChild(row);
  }
}

function renderDashboard() {
  if (!config) return;
  $("dashboardHost").textContent = HOST_LABELS[config.host];
  $("configuredCount").textContent = String([...BUTTON_SLOTS, ...ENCODER_SLOTS].filter(isConfigured).length);
  $("dashboardStatus").textContent = connection.connected ? "Connected" : "Disconnected";
  $("dashboardPort").textContent = connection.path || (connection.connected ? "Checking serial device" : "No active serial port");
  $("lastSync").textContent = lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString() : "Not yet";
  $("syncDetail").textContent = config.deviceWritePending ? "Local changes are waiting to be written" : "Visual layout stays local to this app";
  renderBoard($("dashboardBoard"), { compact: true });
  renderEncoderSummary();
}

function renderButtonEditor() {
  $("hostSelect").value = config.host;
  $("buttonHostChip").textContent = HOST_LABELS[config.host];
  $("shortcutHostLabel").textContent = HOST_LABELS[config.host];
  renderBoard($("buttonEditorBoard"), { editor: true });
  const slot = selectedSlot;
  $("selectedSlotBadge").textContent = `SW${slot}`;
  $("selectedSlotTitle").textContent = titleForSlot(slot);
  $("selectedPosition").textContent = `Position ${config.layout.positions[slot].row * 3 + config.layout.positions[slot].column + 1}`;
  $("buttonLabel").value = config.labels[slot];
  $("buttonShortcut").value = config.profiles[config.host][slot];
  $("shortcutPreview").textContent = config.profiles[config.host][slot] || "NONE";
}

function makeEncoderEditorCard(slot) {
  const card = document.createElement("article");
  card.className = "panel encoder-card";
  const icon = document.createElement("div");
  icon.className = "encoder-card-icon";
  icon.textContent = slot === "CW" ? "↻" : slot === "CCW" ? "↺" : "●";
  const title = document.createElement("h3");
  title.textContent = SLOT_TITLES[slot];
  const description = document.createElement("p");
  description.textContent = `Firmware action · ${slot}`;
  const label = document.createElement("label");
  label.className = "field-label";
  label.htmlFor = `encoder-label-${slot}`;
  label.textContent = "Action label";
  const labelInput = document.createElement("input");
  labelInput.id = `encoder-label-${slot}`;
  labelInput.className = "text-input";
  labelInput.maxLength = 8;
  labelInput.value = config.labels[slot];
  labelInput.placeholder = "e.g. Volume";
  labelInput.addEventListener("input", () => {
    config.labels[slot] = labelInput.value.slice(0, 8);
    markDevicePending();
    renderDashboard();
  });
  const shortcutLabel = document.createElement("label");
  shortcutLabel.className = "field-label";
  shortcutLabel.htmlFor = `encoder-shortcut-${slot}`;
  shortcutLabel.textContent = "Shortcut";
  const shortcutInput = document.createElement("input");
  shortcutInput.id = `encoder-shortcut-${slot}`;
  shortcutInput.className = "text-input mono-input";
  shortcutInput.maxLength = 64;
  shortcutInput.value = config.profiles[config.host][slot];
  shortcutInput.placeholder = "e.g. VOL_UP";
  shortcutInput.addEventListener("input", () => {
    config.profiles[config.host][slot] = shortcutInput.value.trim().toUpperCase() || "NONE";
    markDevicePending();
    renderDashboard();
  });
  const preview = document.createElement("div");
  preview.className = "shortcut-preview";
  const current = document.createElement("span");
  current.className = "preview-label";
  current.textContent = "CURRENT ACTION";
  const key = document.createElement("kbd");
  key.textContent = config.profiles[config.host][slot] || "NONE";
  preview.append(current, key);
  shortcutInput.addEventListener("input", () => { key.textContent = config.profiles[config.host][slot]; });
  const actions = document.createElement("div");
  actions.className = "inspector-actions";
  const clear = document.createElement("button");
  clear.className = "button secondary";
  clear.textContent = "Clear assignment";
  clear.addEventListener("click", () => {
    config.profiles[config.host][slot] = "NONE";
    shortcutInput.value = "NONE";
    key.textContent = "NONE";
    markDevicePending();
  });
  const restore = document.createElement("button");
  restore.className = "text-button";
  restore.textContent = "Restore slot defaults";
  restore.addEventListener("click", () => {
    config.labels[slot] = "";
    config.profiles[config.host][slot] = DEFAULT_ACTIONS[slot];
    labelInput.value = "";
    shortcutInput.value = "NONE";
    key.textContent = "NONE";
    markDevicePending();
  });
  actions.append(clear, restore);
  card.append(icon, title, description, label, labelInput, shortcutLabel, shortcutInput, preview, actions);
  return card;
}

function renderEncoderEditor() {
  $("encoderHostChip").textContent = HOST_LABELS[config.host];
  const container = $("encoderEditor");
  container.replaceChildren(...ENCODER_SLOTS.map(makeEncoderEditorCard));
}

function updateLayoutInspector() {
  const position = (layoutEditing ? layoutDraft : config.layout).positions[selectedLayoutSlot];
  $("layoutSelection").textContent = `SW${selectedLayoutSlot} · visual row ${position.row + 1}, column ${position.column + 1}`;
  $("layoutWidth").value = String(position.columnSpan);
  $("layoutHeight").value = String(position.rowSpan);
  $("layoutWidth").disabled = !layoutEditing;
  $("layoutHeight").disabled = !layoutEditing;
}

function renderLayoutBoard() {
  const board = $("layoutBoard");
  board.classList.toggle("editing", layoutEditing);
  const layout = layoutEditing ? layoutDraft : config.layout;
  renderBoard(board, { layout, draggable: layoutEditing });
  for (const button of board.querySelectorAll(".key-button")) {
    button.classList.toggle("layout-selected", button.dataset.slot === selectedLayoutSlot);
  }
  updateLayoutInspector();
}

function renderSettings() {
  $("themeSelect").value = config.preferences.theme;
  $("gridGapSelect").value = String(config.preferences.gridGap);
  renderDeviceInfo();
}

function renderDeviceInfo() {
  const list = $("deviceInfoList");
  list.replaceChildren();
  const ports = Array.isArray(connectionInfo.ports) ? connectionInfo.ports : [];
  const active = connectionInfo.connected ? connectionInfo : null;
  const selected = active || ports.find(port => port.manufacturer || port.vendorId) || null;
  const fields = [
    ["Status", connection.connected ? "Connected" : "Disconnected"],
    ["Serial path", selected?.path || "Not connected"],
    ["Manufacturer", selected?.manufacturer || "—"],
    ["USB vendor", selected?.vendorId || "—"],
    ["USB product", selected?.productId || "—"],
    ["Serial number", selected?.serialNumber || "—"],
    ["Available ports", String(ports.length)]
  ];
  for (const [term, value] of fields) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    list.append(dt, dd);
  }
}

function renderSyncSummary() {
  const connected = Boolean(connection.connected);
  const state = syncState.state;
  const syncing = state === "reading" || state === "saving";
  const failed = state === "failed";
  const synchronized = state === "synchronized" && !config?.deviceWritePending;
  const message = failed ? "Synchronization failed" : syncing ? (state === "reading" ? "Reading configuration" : "Saving configuration") : synchronized ? "Synchronized" : connected ? "Connected" : "Disconnected";
  $("sideConnection").textContent = message;
  $("sidePort").textContent = connection.path || (connected ? "Checking serial device" : "No serial port");
  $("dashboardStatus").textContent = connected ? "Connected" : "Disconnected";
  $("dashboardPort").textContent = connection.path || (connected ? "Checking serial device" : "No active serial port");
  $("syncLabel").textContent = config?.deviceWritePending && connected ? "Changes waiting to sync" : message;
  $("syncIndicator").className = `sync-indicator${syncing ? " syncing" : synchronized ? " synced" : failed ? " failed" : ""}`;
  $("connectionDot").className = `connection-dot${connected ? " connected" : " disconnected"}`;
  $("syncPillDot").className = connected ? "connected" : "disconnected";
  $("syncPillText").textContent = config?.deviceWritePending && connected ? "Local changes pending" : message;
  $("connectButton").disabled = syncing;
  $("disconnectButton").disabled = !connected || syncing;
  $("reloadDeviceButton").disabled = !connected || syncing;
  $("resetDeviceButton").disabled = !connected || syncing;
  $("saveDeviceButton").disabled = !connected || syncing || !config;
  $("saveDeviceButton").textContent = config?.deviceWritePending ? "Save changes to device" : "Save to device";
  if (syncState.detail && failed) $("syncDetail").textContent = syncState.detail;
}

function renderAll() {
  if (!config) return;
  applyTheme();
  $("hostSelect").value = config.host;
  renderDashboard();
  renderButtonEditor();
  renderEncoderEditor();
  renderLayoutBoard();
  renderSettings();
  renderSyncSummary();
}

function showPage(name) {
  if (!PAGE_LABELS[name]) return;
  document.querySelectorAll(".view").forEach(section => section.classList.toggle("active-view", section.id === `view-${name}`));
  document.querySelectorAll(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === name));
  $("pageEyebrow").textContent = PAGE_LABELS[name][0];
  $("pageTitle").textContent = PAGE_LABELS[name][1];
  if (config && config.preferences.startView !== name) {
    config.preferences.startView = name;
    persistSoon();
  }
}

async function refreshDeviceInfo() {
  try {
    connectionInfo = await window.macropad.getDeviceInfo();
    renderDeviceInfo();
  } catch (error) {
    toast(`Could not read device details: ${formatError(error)}`, true);
  }
}

async function syncFromDevice({ discardLocalChanges = false } = {}) {
  if (!connection.connected || !config) return;
  if (config.deviceWritePending && !discardLocalChanges) {
    toast("Local changes are waiting to be saved. Save them or explicitly reload from the device.");
    return;
  }
  if (config.deviceWritePending && discardLocalChanges && !window.confirm("Discard local macro edits and replace them with the current ESP32 settings?")) return;
  try {
    const deviceConfig = await window.macropad.getConfig();
    config = mergeDeviceConfig(deviceConfig, config);
    config.deviceWritePending = false;
    config = await window.macropad.saveAppConfig(config);
    lastSyncAt = new Date().toISOString();
    log(`Loaded ${HOST_LABELS[deviceConfig.host] || deviceConfig.host} settings from ${connection.path || "the Macropad"}.`);
    renderAll();
  } catch (error) {
    syncState = { state: "failed", detail: formatError(error) };
    log(`GET failed: ${formatError(error)}`);
    renderSyncSummary();
    toast(`Could not read Macropad settings: ${formatError(error)}`, true);
  }
}

async function handleDiscovery(found) {
  queuedDiscovery = found;
  if (!found) {
    connection = { connected: false };
    renderSyncSummary();
    log("No compatible Macropad responded to HELLO.");
    await refreshDeviceInfo();
    return;
  }
  connection = { connected: true, path: found.path, info: found.info };
  connectionInfo = { ...found.info, connected: true, path: found.path, ports: connectionInfo.ports || [] };
  log(`HELLO succeeded on ${found.path}: ${found.response}.`);
  renderSyncSummary();
  await refreshDeviceInfo();
  if (!configLoaded) return;
  if (config.deviceWritePending) {
    toast("Device connected. Local macro changes are preserved; choose Save to device or Reload from device.");
    return;
  }
  await syncFromDevice();
}

async function saveToDevice() {
  if (!connection.connected || !config) return;
  try {
    await persistNow();
    const result = await window.macropad.saveDeviceConfig(config);
    if (result.cancelled) return;
    config = result.appConfig;
    config.deviceWritePending = false;
    lastSyncAt = new Date().toISOString();
    log(`Saved ${result.sent} protocol commands and read the configuration back from the ESP32.`);
    renderAll();
    toast("Settings saved and verified with GET.");
  } catch (error) {
    syncState = { state: "failed", detail: formatError(error) };
    renderSyncSummary();
    log(`Save failed: ${formatError(error)}`);
    toast(`Could not save to Macropad: ${formatError(error)}`, true);
  }
}

async function resetDevice() {
  try {
    const result = await window.macropad.resetDevice();
    if (result.cancelled) return;
    config = result.appConfig;
    config.deviceWritePending = false;
    lastSyncAt = new Date().toISOString();
    renderAll();
    log("Device reset completed; defaults were read back from the ESP32.");
    toast("Device shortcuts reset. Application theme and layout were kept.");
  } catch (error) {
    syncState = { state: "failed", detail: formatError(error) };
    renderSyncSummary();
    log(`Device reset failed: ${formatError(error)}`);
    toast(`Could not reset device: ${formatError(error)}`, true);
  }
}

function changeHost(host) {
  if (!HOSTS.includes(host) || host === config.host) return;
  config.host = host;
  markDevicePending();
  renderAll();
  toast(`${HOST_LABELS[host]} selected. Save to device to update the ESP32 host profile.`);
}

function setSelectedLabel(value) {
  config.labels[selectedSlot] = value.slice(0, 8);
  markDevicePending();
  renderBoard($("dashboardBoard"), { compact: true });
  renderBoard($("buttonEditorBoard"), { editor: true });
  $("selectedPosition").textContent = `Position ${config.layout.positions[selectedSlot].row * 3 + config.layout.positions[selectedSlot].column + 1}`;
  renderDashboard();
}

function setSelectedShortcut(value) {
  const shortcut = value.trim().toUpperCase() || "NONE";
  config.profiles[config.host][selectedSlot] = shortcut;
  $("shortcutPreview").textContent = shortcut;
  markDevicePending();
  renderBoard($("dashboardBoard"), { compact: true });
  renderBoard($("buttonEditorBoard"), { editor: true });
  renderDashboard();
}

function beginLayoutEdit() {
  layoutDraft = clone(config.layout);
  layoutEditing = true;
  $("layoutModeTitle").textContent = "Unsaved layout changes";
  $("layoutModeHint").textContent = "Drag keys to swap visual positions. Physical firmware slots stay fixed.";
  $("editLayoutButton").hidden = true;
  $("cancelLayoutButton").hidden = false;
  $("resetLayoutButton").hidden = false;
  $("saveLayoutButton").hidden = false;
  renderLayoutBoard();
}

function endLayoutEdit() {
  layoutEditing = false;
  layoutDraft = null;
  $("layoutModeTitle").textContent = "Layout saved";
  $("layoutModeHint").textContent = "Enter edit mode to rearrange keys or change their visual size.";
  $("editLayoutButton").hidden = false;
  $("cancelLayoutButton").hidden = true;
  $("resetLayoutButton").hidden = true;
  $("saveLayoutButton").hidden = true;
  renderLayoutBoard();
}

function changeLayoutSize() {
  if (!layoutEditing) return;
  try {
    layoutDraft = resizeLayoutSlot(
      layoutDraft,
      selectedLayoutSlot,
      Number($("layoutHeight").value),
      Number($("layoutWidth").value)
    );
    renderLayoutBoard();
  } catch (error) {
    toast(formatError(error), true);
    updateLayoutInspector();
  }
}

async function saveLayout() {
  if (!layoutEditing || !layoutDraft) return;
  try {
    config.layout = validateLayout(layoutDraft);
    config = await window.macropad.saveAppConfig(config);
    endLayoutEdit();
    renderDashboard();
    renderButtonEditor();
    toast("Visual layout saved locally. The ESP32 was not changed.");
  } catch (error) {
    toast(`Layout could not be saved: ${formatError(error)}`, true);
  }
}

function appendSummaryCell(container, label, value) {
  const cell = document.createElement("div");
  cell.className = "summary-cell";
  const name = document.createElement("span");
  name.textContent = label;
  const content = document.createElement("strong");
  content.textContent = value;
  cell.append(name, content);
  container.appendChild(cell);
}

async function startImportPreview() {
  try {
    const result = await window.macropad.previewImport();
    if (result.cancelled) return;
    importPreview = result;
    $("importFileName").textContent = result.fileName;
    const summary = $("importSummary");
    summary.replaceChildren();
    appendSummaryCell(summary, "Current profile", HOST_LABELS[result.preview.host]);
    appendSummaryCell(summary, "Host profiles", result.preview.profiles.map(host => HOST_LABELS[host]).join(", "));
    appendSummaryCell(summary, "Labeled actions", String(result.preview.labeledSlots));
    appendSummaryCell(summary, "Visual key positions", String(result.preview.layoutSlots));
    appendSummaryCell(summary, "Theme", result.preview.theme);
    $("importPreviewDialog").showModal();
  } catch (error) {
    toast(`Import preview failed: ${formatError(error)}`, true);
  }
}

async function applyImport() {
  if (!importPreview) return;
  try {
    config = await window.macropad.applyImport(importPreview.config);
    config.deviceWritePending = true;
    await persistNow();
    $("importPreviewDialog").close();
    importPreview = null;
    renderAll();
    toast("Settings imported to this app only. Review them, then choose Save to device to write to the ESP32.");
    log("Imported a validated settings file into local application configuration.");
  } catch (error) {
    toast(`Could not apply settings: ${formatError(error)}`, true);
  }
}

async function exportSettings() {
  try {
    await persistNow();
    const result = await window.macropad.exportSettings();
    if (!result.cancelled) toast(`Settings exported to ${result.fileName}.`);
  } catch (error) {
    toast(`Export failed: ${formatError(error)}`, true);
  }
}

async function restoreUiDefaults() {
  if (!window.confirm("Restore the application theme, startup page, grid spacing, and visual layout? ESP32 shortcuts will not be reset.")) return;
  try {
    config = await window.macropad.restoreUiDefaults();
    layoutEditing = false;
    layoutDraft = null;
    renderAll();
    showPage("dashboard");
    toast("Application appearance and layout defaults restored. The ESP32 was not changed.");
  } catch (error) {
    toast(`Could not restore UI defaults: ${formatError(error)}`, true);
  }
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach(button => button.addEventListener("click", () => showPage(button.dataset.view)));
  document.querySelectorAll("[data-go-view]").forEach(button => button.addEventListener("click", () => showPage(button.dataset.goView)));
  $("hostSelect").addEventListener("change", () => changeHost($("hostSelect").value));
  $("connectButton").addEventListener("click", async () => {
    try {
      $("connectButton").disabled = true;
      await window.macropad.discover();
    } catch (error) {
      syncState = { state: "failed", detail: formatError(error) };
      renderSyncSummary();
      toast(`Device discovery failed: ${formatError(error)}`, true);
    } finally {
      renderSyncSummary();
    }
  });
  $("disconnectButton").addEventListener("click", async () => {
    try { await window.macropad.disconnect(); }
    catch (error) { toast(`Disconnect failed: ${formatError(error)}`, true); }
  });
  $("reloadDeviceButton").addEventListener("click", () => syncFromDevice({ discardLocalChanges: true }));
  $("saveDeviceButton").addEventListener("click", saveToDevice);
  $("resetDeviceButton").addEventListener("click", resetDevice);
  $("buttonLabel").addEventListener("input", event => setSelectedLabel(event.target.value));
  $("buttonShortcut").addEventListener("input", event => setSelectedShortcut(event.target.value));
  $("clearShortcutButton").addEventListener("click", () => {
    config.profiles[config.host][selectedSlot] = "NONE";
    $("buttonShortcut").value = "NONE";
    $("shortcutPreview").textContent = "NONE";
    markDevicePending();
    renderAll();
  });
  $("restoreButtonDefault").addEventListener("click", () => {
    config.labels[selectedSlot] = "";
    config.profiles[config.host][selectedSlot] = DEFAULT_ACTIONS[selectedSlot];
    markDevicePending();
    renderAll();
  });
  $("layoutBoard").addEventListener("dragover", event => { if (layoutEditing) event.preventDefault(); });
  $("layoutWidth").addEventListener("change", changeLayoutSize);
  $("layoutHeight").addEventListener("change", changeLayoutSize);
  $("editLayoutButton").addEventListener("click", beginLayoutEdit);
  $("cancelLayoutButton").addEventListener("click", endLayoutEdit);
  $("resetLayoutButton").addEventListener("click", () => {
    if (!layoutEditing) return;
    layoutDraft = createDefaultLayout();
    selectedLayoutSlot = "1";
    renderLayoutBoard();
    toast("Default visual arrangement loaded. Save layout to keep it locally.");
  });
  $("saveLayoutButton").addEventListener("click", saveLayout);
  $("themeSelect").addEventListener("change", async () => {
    config.preferences.theme = $("themeSelect").value;
    applyTheme();
    await persistNow();
  });
  $("gridGapSelect").addEventListener("change", async () => {
    config.preferences.gridGap = Number($("gridGapSelect").value);
    applyTheme();
    renderDashboard(); renderButtonEditor(); renderLayoutBoard();
    await persistNow();
  });
  $("exportButton").addEventListener("click", exportSettings);
  $("importButton").addEventListener("click", startImportPreview);
  $("applyImportButton").addEventListener("click", applyImport);
  $("restoreUiButton").addEventListener("click", restoreUiDefaults);
  $("refreshDeviceInfoButton").addEventListener("click", refreshDeviceInfo);
  $("clearActivityButton").addEventListener("click", () => { $("activityLog").textContent = ""; });
  $("importPreviewDialog").addEventListener("close", () => { importPreview = null; });

  unsubscribeEvents.push(
    window.macropad.onConnection(data => {
      connection = data;
      renderSyncSummary();
      if (config) renderDashboard();
      renderDeviceInfo();
    }),
    window.macropad.onDiscovered(handleDiscovery),
    window.macropad.onSerialLine(line => log(`← ${line}`)),
    window.macropad.onError(error => {
      const message = typeof error === "string" ? error : `${error.path ? `${error.path}: ` : ""}${error.message || "Serial error"}`;
      log(`Serial error: ${message}`);
    }),
    window.macropad.onSyncState(data => {
      syncState = data;
      if (data.state === "synchronized") lastSyncAt = data.timestamp;
      renderSyncSummary();
      if (config) renderDashboard();
    }),
    window.macropad.onWarning(message => toast(message, true))
  );
  window.addEventListener("beforeunload", () => unsubscribeEvents.splice(0).forEach(unsubscribe => unsubscribe()));
}

async function initialize() {
  bindEvents();
  try {
    config = await window.macropad.getAppConfig();
    configLoaded = true;
    const version = await window.macropad.getVersion();
    $("appVersion").textContent = version;
    renderAll();
    showPage(config.preferences.startView);
    await refreshDeviceInfo();
    if (queuedDiscovery && !config.deviceWritePending) await syncFromDevice();
    if (config.deviceWritePending) toast("Local macro changes are preserved. Save them to the device or reload from the ESP32.");
  } catch (error) {
    toast(`Application settings could not be loaded: ${formatError(error)}`, true);
    log(`Startup error: ${formatError(error)}`);
  }
}

document.addEventListener("DOMContentLoaded", initialize, { once: true });
