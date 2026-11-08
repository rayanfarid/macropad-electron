const BUTTON_SLOTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const ENCODER_SLOTS = ["CW", "CCW", "PRESS"];
const HOSTS = ["WINDOWS", "LINUX", "MACOS", "OMARCHY"];
const HOST_LABELS = { WINDOWS: "Windows", LINUX: "Linux", MACOS: "macOS", OMARCHY: "Omarchy" };
const PAGE_LABELS = {
  dashboard: ["WORKSPACE", "Dashboard"],
  buttons: ["DEVICE CONFIGURATION", "Macropad"],
  encoder: ["DEVICE CONFIGURATION", "Encoder"],
  layout: ["LOCAL APPEARANCE", "Key layout"],
  screen: ["DEVICE DISPLAY", "OLED Designer"],
  games: ["FIRMWARE LIBRARY", "Games"],
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
let selectedMacroPage = 0;
let deviceGameState = "UNKNOWN";
let selectedLayoutSlot = "1";
let layoutDraft = null;
let layoutEditing = false;
let importPreview = null;
let queuedDiscovery = undefined;
let selectedScreenElement = 0;
let selectedScreenPage = 0;
let selectedScreenEvent = "idle";
let pendingAiDesign = null;
let screenHistory = [];
let screenHistoryIndex = -1;
let screenPreviewMode = false;
let screenDrag = false;
let screenGuidesVisible = true;
let screenZoomPercent = 400;
let builtinScreenIcons = [];
let deviceCurrentScreenPage = null;
let lastScreenButtonSlot = null;
let lastScreenEncoderAction = "";
let hidStatusKnown = false;
let hidIsEnabled = true;
let aiKeyConfigured = false;
let pendingScreenImport = null;
let screenClipboard = null;
const unsubscribeEvents = [];

const $ = id => document.getElementById(id);

function activeScreenPage(design = config?.screenDesign) {
  if (!design?.pages?.length) return null;
  selectedScreenPage = Math.max(0, Math.min(selectedScreenPage, design.pages.length - 1));
  return design.pages[selectedScreenPage];
}

// OLED event screens: each page can hold an independent validated layout per
// event. "idle" overrides the page design while no temporary event screen is
// active; when absent the page's own elements are the idle screen.
const SCREEN_EVENTS = [
  ["idle", "Idle"],
  ["sw1Press", "SW1 Press"], ["sw2Press", "SW2 Press"], ["sw3Press", "SW3 Press"],
  ["sw4Press", "SW4 Press"], ["sw5Press", "SW5 Press"], ["sw6Press", "SW6 Press"],
  ["sw7Press", "SW7 Press"], ["sw8Press", "SW8 Press"], ["sw9Press", "SW9 Press"],
  ["encoderCW", "Encoder CW"], ["encoderCCW", "Encoder CCW"], ["encoderPress", "Encoder Press"]
];
const SCREEN_EVENT_IDS = SCREEN_EVENTS.map(([id]) => id);

function screenEventLabel(eventId) {
  return SCREEN_EVENTS.find(([id]) => id === eventId)?.[1] || eventId;
}

function screenEventOptions() {
  return config?.screenDesign?.eventOptions || { duration: "1500", trigger: "PRESS" };
}

// Read-only view of the elements for the current (page, event) selection.
// Never mutates config; falls back to firmware-style defaults for events that
// have no stored design yet.
function defaultEventElements(eventId) {
  const host = config?.host || "WINDOWS";
  const make = (id, x, y, size, alignment, text) =>
    ({ id, x, y, size, mode: "NORMAL", alignment, binding: "STATIC", text });
  const buttonMatch = eventId.match(/^sw([1-9])Press$/);
  if (buttonMatch) {
    const slot = buttonMatch[1];
    if (multiPageMode() && slot === "7") return [make(`ev-${eventId}-role`, 64, 10, 2, "CENTER", "PREV PAGE")];
    if (multiPageMode() && slot === "8") return [make(`ev-${eventId}-role`, 64, 8, 2, "CENTER", "GAMES"), make(`ev-${eventId}-hint`, 64, 38, 1, "CENTER", "ON DEVICE")];
    if (multiPageMode() && slot === "9") return [make(`ev-${eventId}-role`, 64, 10, 2, "CENTER", "NEXT PAGE")];
    const macroPage = config?.shortcutPages?.[selectedScreenPage];
    const label = multiPageMode() ? macroPage?.labels?.[slot] : config?.labels?.[slot];
    const combo = multiPageMode() ? macroPage?.profiles?.[host]?.[slot] : config?.profiles?.[host]?.[slot];
    const elements = [make(`ev-${eventId}-label`, 64, 8, 2, "CENTER", (label || `SW${slot}`).slice(0, 8))];
    if (combo && combo !== "NONE") elements.push(make(`ev-${eventId}-combo`, 64, 46, 1, "CENTER", combo.slice(0, 20)));
    return elements;
  }
  const encoderSlot = eventId === "encoderCW" ? "CW" : eventId === "encoderCCW" ? "CCW" : eventId === "encoderPress" ? "PRESS" : null;
  if (encoderSlot) {
    const name = encoderSlot === "CW" ? "CW" : encoderSlot === "CCW" ? "CCW" : "PRESS";
    const elements = [
      make(`ev-${eventId}-title`, 64, 6, 2, "CENTER", "ENCODER"),
      make(`ev-${eventId}-name`, 64, 28, 2, "CENTER", name)
    ];
    const combo = config?.profiles?.[host]?.[encoderSlot];
    if (combo && combo !== "NONE") elements.push(make(`ev-${eventId}-combo`, 64, 52, 1, "CENTER", combo.slice(0, 20)));
    return elements;
  }
  return [];
}

function activeScreenElements() {
  const page = activeScreenPage();
  if (!page) return [];
  if (selectedScreenEvent === "idle") {
    return page.events?.idle?.elements ?? page.elements ?? [];
  }
  return page.events?.[selectedScreenEvent]?.elements ?? defaultEventElements(selectedScreenEvent);
}

function screenElements() { return activeScreenElements(); }

// Returns the stored {elements} holder for the selected event inside `design`,
// materializing a copy of the page elements (idle) or generated defaults
// (other events) on first edit. Used for mutations on a cloned design.
function screenEventTargetInDesign(design, eventId = selectedScreenEvent) {
  const page = design?.pages?.[selectedScreenPage];
  if (!page) return null;
  if (!page.events || typeof page.events !== "object") page.events = {};
  if (eventId === "idle") {
    if (!page.events.idle) page.events.idle = { elements: clone(page.elements || []) };
    return page.events.idle;
  }
  if (!page.events[eventId]) page.events[eventId] = { elements: defaultEventElements(eventId) };
  return page.events[eventId];
}

// Same as above but mutates the live config (call before pushScreenHistory).
function ensureScreenEventDesign(eventId = selectedScreenEvent) {
  return screenEventTargetInDesign(config.screenDesign, eventId);
}

function selectScreenEvent(eventId) {
  if (!SCREEN_EVENT_IDS.includes(eventId) || eventId === selectedScreenEvent) { renderScreenEvents(); return; }
  selectedScreenEvent = eventId;
  selectedScreenElement = 0;
  renderScreenEvents();
  renderScreenInspector();
}

async function loadScreenIconOptions() {
  try {
    builtinScreenIcons = await window.macropad.getScreenIcons();
    const select = $("screenIconSelect");
    select.replaceChildren(...builtinScreenIcons.map(icon => {
      const option = document.createElement("option");
      option.value = icon.id;
      option.textContent = icon.name;
      return option;
    }));
    $("screenAddIconButton").disabled = builtinScreenIcons.length === 0;
  } catch (error) {
    $("screenAddIconButton").disabled = true;
    log(`Built-in OLED icons are unavailable: ${formatError(error)}`);
  }
}

function addScreenIcon() {
  const icon = builtinScreenIcons.find(item => item.id === $("screenIconSelect").value);
  if (!icon) { toast("No built-in OLED icon is available.", true); return; }
  ensureScreenEventDesign();
  if (screenElements().length >= 8) { toast("Firmware supports at most eight elements per screen.", true); return; }
  const element = {
    id: `icon-${Date.now().toString(36)}`,
    type: "image", x: 8, y: 8, width: icon.width, height: icon.height,
    mode: "NORMAL", binding: "BITMAP", bitmap: icon.bitmap, icon: icon.id
  };
  screenElements().push(element);
  selectedScreenElement = screenElements().length - 1;
  pushScreenHistory();
  renderScreenInspector();
}

function updateScreenCanvasScale() {
  screenZoomPercent = Number($("screenZoomSelect")?.value || 400);
  const canvas = $("screenCanvas");
  if (canvas) canvas.style.width = `${128 * screenZoomPercent / 100}px`;
  const grid = $("screenCanvasGrid");
  if (grid) {
    grid.style.setProperty("--pixel-size", `${screenZoomPercent / 100}px`);
    grid.classList.toggle("visible", Boolean($("screenGridToggle")?.checked));
  }
}

function selectScreenPageIndex(index, { pushHistory = false } = {}) {
  if (!config?.screenDesign?.pages?.length) return;
  const next = Math.max(0, Math.min(index, config.screenDesign.pages.length - 1));
  if (next === selectedScreenPage) { renderScreenPages(); return; }
  selectedScreenPage = next;
  if (next < config.shortcutPages.length) selectedMacroPage = next;
  selectedScreenElement = 0;
  if (pushHistory) pushScreenHistory();
  renderScreenPages();
  renderScreenInspector();
  renderButtonEditor(); renderMacroPages();
  renderDashboard();
}

function renderScreenPages() {
  const select = $("screenPageSelect");
  if (!select || !config) return;
  selectedScreenPage = Math.max(0, Math.min(selectedScreenPage, config.screenDesign.pages.length - 1));
  select.replaceChildren(...config.screenDesign.pages.map((page, index) => {
    const option = document.createElement("option"); option.value = String(index); option.textContent = page.name || `Page ${index + 1}`; return option;
  }));
  select.value = String(selectedScreenPage);
  $("screenPageCount").textContent = `Page ${selectedScreenPage + 1} / ${config.screenDesign.pages.length}`;
  $("screenDeletePageButton").disabled = config.screenDesign.pages.length <= 1;
  $("screenShowPageButton").disabled = !connection.connected;
  $("screenDuplicatePageButton").disabled = config.screenDesign.pages.length >= 8;
  $("screenAddPageButton").disabled = config.screenDesign.pages.length >= 8;
  $("screenRenamePageButton").disabled = !config.screenDesign.pages.length;
  $("sw9PageHint").textContent = config.screenDesign.pages.length > 1
    ? "SW7 previous · SW8 opens ESP32 Games · SW9 next/wrap. Games run offline on the Macropad."
    : "Single page: SW1–SW9 retain their normal macro assignments.";
  renderScreenEvents();
}

function renderScreenEvents() {
  const eventSelect = $("screenEventSelect");
  if (!eventSelect || !config) return;
  if (!eventSelect.options.length) {
    eventSelect.replaceChildren(...SCREEN_EVENTS.map(([id, label]) => {
      const option = document.createElement("option"); option.value = id; option.textContent = label; return option;
    }));
  }
  eventSelect.value = selectedScreenEvent;
  const options = screenEventOptions();
  $("screenEventDuration").value = String(options.duration ?? "1500");
  $("screenEventTrigger").value = options.trigger === "RELEASE" ? "RELEASE" : "PRESS";
  const targetSelect = $("screenEventDuplicateTarget");
  if (targetSelect) {
    if (!targetSelect.options.length) {
      targetSelect.replaceChildren(...SCREEN_EVENTS.map(([id, label]) => {
        const option = document.createElement("option"); option.value = id; option.textContent = label; return option;
      }));
    }
    targetSelect.value = SCREEN_EVENT_IDS.includes(selectedScreenEvent) ? selectedScreenEvent : "idle";
  }
  $("screenDuplicateEventButton").disabled = !config.screenDesign?.pages?.length || screenPreviewMode;
  $("screenEventHint").textContent = selectedScreenEvent === "idle"
    ? "Idle is the normal screen; event screens return to it automatically"
    : `Temporary ${screenEventLabel(selectedScreenEvent)} screen — actions still run normally`;
  if ($("screenEventBadge")) $("screenEventBadge").textContent = screenEventLabel(selectedScreenEvent);
}

function addScreenPage({ duplicate = false } = {}) {
  if (config.screenDesign.pages.length >= 8 || config.shortcutPages.length >= 8) { toast("The ESP32 supports up to eight pages.", true); return; }
  const hasSw9Assignment = Object.values(config.profiles).some(profile => profile["9"] && profile["9"] !== "NONE");
  if (config.screenDesign.pages.length === 1) {
    const detail = hasSw9Assignment ? " Existing SW7–SW9 macro assignments remain stored and are restored if you return to a single page." : " The reserved controls are restored to normal assignments if you return to one page.";
    if (!window.confirm(`Enable physical page navigation? SW7 becomes Previous Page, SW8 opens the ESP32 Games menu, and SW9 becomes Next Page on the ESP32. SW9 wraps to Page 1; SW7 stops at Page 1.${detail} Continue?`)) return;
  }
  const source = duplicate ? activeScreenPage() : null;
  const index = config.screenDesign.pages.length;
  const pageId = `screen-page-${Date.now().toString(36)}`;
  const macroSource = config.shortcutPages[selectedMacroPage] || config.shortcutPages[0];
  config.screenDesign.pages.push(source
    ? { ...clone(source), id: pageId, name: `Page ${index + 1}` }
    : { id: pageId, name: `Page ${index + 1}`, elements: [] });
  if (config.shortcutPages.length === index) {
    config.shortcutPages.push({ ...clone(macroSource), id: pageId, name: `Page ${index + 1}` });
  } else if (config.shortcutPages.length < index) {
    toast("Shortcut and OLED pages are out of sync. Read the device configuration before adding another page.", true);
    config.screenDesign.pages.pop(); return;
  }
  selectedScreenPage = index; selectedScreenElement = Math.max(0, screenElements().length - 1);
  selectedMacroPage = Math.min(index, config.shortcutPages.length - 1);
  pushScreenHistory(); renderScreenPages(); renderScreenInspector(); renderButtonEditor(); renderDashboard(); markDevicePending();
}

function renameCurrentPage() {
  const page = config.shortcutPages[selectedMacroPage];
  if (!page) return;
  const name = window.prompt("Name this shortcut page (up to 20 characters):", page.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 20 || /[^\x20-\x7e]/.test(trimmed)) { toast("Page names must be 1–20 printable ASCII characters.", true); return; }
  page.name = trimmed;
  if (config.screenDesign.pages[selectedMacroPage]) config.screenDesign.pages[selectedMacroPage].name = trimmed;
  renderMacroPages(); renderScreenPages(); pushScreenHistory(); markDevicePending();
}

function tooltipName(element) {
  const id = element.id || "";
  const names = {
    screenUndoButton: "Undo — Revert the last change",
    screenRedoButton: "Redo — Restore the change you just undid",
    screenAddButton: "Add Element — Add a new item to the OLED screen",
    screenDuplicateButton: "Duplicate Element — Copy the selected screen item",
    screenPreviewButton: "Preview — See how the OLED screen will look",
    screenReadButton: "Read from Device — Load the current configuration from the ESP32",
    screenUploadButton: "Upload to Device — Send this configuration to the ESP32",
    screenSaveButton: "Save — Save this configuration locally",
    screenImportButton: "Import — Load a previously exported configuration",
    screenExportButton: "Export — Save this configuration as a file",
    screenAddPageButton: "Add Page — Add another OLED screen page (up to 8)",
    screenDuplicatePageButton: "Duplicate Page — Copy the selected OLED page",
    screenDeletePageButton: "Delete Page — Remove the selected page; the final page cannot be deleted",
    screenPrevPageButton: "Previous Page — Edit the previous OLED page design",
    screenNextPageButton: "Next Page — Edit the next OLED page design",
    screenShowPageButton: "Show on Device — Display this page on the connected ESP32 OLED",
    screenEventSelect: "OLED Event — Choose which event's screen layout to edit (Idle is the normal screen)",
    screenEventDuration: "Event Display Duration — How long an event screen stays before returning to Idle",
    screenEventTrigger: "Event Trigger — Show the event screen on button press or on button release",
    screenEventDuplicateTarget: "Duplicate Target — Choose which event receives the copied design",
    screenDuplicateEventButton: "Duplicate Event Design — Copy the selected event's layout to another event",
    screenAiGenerateButton: "Generate with AI — Describe what you want and let AI create a screen layout",
    applyAiDesignButton: "Apply — Replace the local screen design with the AI preview (does not upload)",
    cancelAiDesignButton: "Cancel — Discard the AI-generated preview",
    openAiSettingsButton: "Open AI Settings — Go to Settings → AI Assistance",
    aiProviderSelect: "AI Provider — Select Google Gemini or OpenRouter (free tier only)",
    aiModelSelect: "Model — Choose a verified free model for OLED screen generation",
    saveAiKeyButton: "Save API Key — Encrypt and store the key for the selected provider",
    testAiConnectionButton: "Test Connection — Verify API key and accessibility of the selected free model",
    clearAiKeyButton: "Remove Key — Delete the encrypted API key for the selected provider",
    toggleAiKeyButton: "Show/Hide API key — Reveal or mask the key you entered",
    retrySecureStorageButton: "Retry — Recheck Electron secure credential storage",
    aiEnabledToggle: "Enable AI Assistance — Allow explicit AI generation after a key is saved",
    aiKeyInput: "API Key — Paste your secret key here; it is stored encrypted in Electron safeStorage",
    screenCanvas: "OLED preview — Drag elements to reposition them on the 128×64 display",
    connectButton: "Connect — Find and connect to the ESP32 Macropad",
    disconnectButton: "Disconnect — Close the serial connection",
    reloadDeviceButton: "Read from Device — Load the current configuration from the ESP32",
    saveDeviceButton: "Upload to Device — Send this configuration to the ESP32",
    resetDeviceButton: "Reset Device — Restore ESP32 macro defaults after confirmation",
    exportButton: "Export — Save this configuration as a file",
    importButton: "Import — Load a previously exported configuration",
    editLayoutButton: "Edit layout — Rearrange visual key positions without changing firmware slots",
    saveLayoutButton: "Save layout — Keep the visual arrangement locally",
    cancelLayoutButton: "Cancel — Discard unsaved visual layout changes",
    resetLayoutButton: "Reset layout — Restore the default 3×3 visual arrangement",
    clearShortcutButton: "Clear assignment — Set this slot's shortcut to NONE",
    restoreButtonDefault: "Restore slot defaults — Clear the label and shortcut for this physical slot",
    clearActivityButton: "Clear log — Remove activity messages from this panel",
    refreshDeviceInfoButton: "Refresh device details — Re-read connected serial port information",
    restoreUiButton: "Restore application UI defaults — Reset theme, spacing, and visual layout only",
    screenDeleteButton: "Delete element — Remove the selected item from this OLED page"
  };
  if (element.dataset.tooltip) return element.dataset.tooltip;
  if (names[id]) return names[id];
  if (element.matches(".key-button")) {
    const slot = element.dataset.slot;
    if (slot === "9" && config?.screenDesign?.pages?.length > 1) {
      return "SW9 — Physical Slot 9 acts as Next OLED Page while multiple pages are enabled";
    }
    return element.dataset.tooltip || "Physical button — Select this firmware slot to edit its settings";
  }
  if (element.matches(".nav-item")) return `${element.textContent.trim()} — Open this section`;
  if (element.matches("#hostSelect")) return "Host Profile — Choose which operating system's shortcuts you are editing";
  if (element.matches("#screenPageSelect")) return "OLED Page — Select which independent screen layout to edit";
  if (element.matches("input,select,textarea")) {
    const label = element.labels?.[0]?.innerText?.trim() || element.getAttribute("aria-label") || element.placeholder || id;
    if (!label || label === id) return "";
    return `${label.split("\n")[0].trim()} — Edit this setting`;
  }
  if (element.matches("button.icon-button,button.text-button")) {
    return `${element.getAttribute("aria-label") || element.textContent.trim() || "Control"} — Activate this control`;
  }
  if (element.matches("button,[role=button],canvas")) {
    const label = element.getAttribute("aria-label") || element.textContent.trim();
    return label ? `${label} — Activate or edit this control` : "";
  }
  return "";
}

function initializeTooltips() {
  const tooltip = $("appTooltip");
  let timer = null;
  let active = null;
  const interactive = "button,input,select,textarea,canvas,.nav-item,[role=button]";
  const hide = () => {
    clearTimeout(timer);
    tooltip.hidden = true;
    if (active) active.removeAttribute("aria-describedby");
    active = null;
  };
  const place = target => {
    tooltip.textContent = tooltipName(target);
    if (!tooltip.textContent) { hide(); return; }
    tooltip.hidden = false;
    const rect = target.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(innerWidth - tooltip.offsetWidth - 8, rect.left + rect.width / 2 - tooltip.offsetWidth / 2))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(innerHeight - tooltip.offsetHeight - 8, rect.bottom + 8))}px`;
  };
  const show = target => {
    const text = tooltipName(target);
    if (!text) return;
    clearTimeout(timer);
    active = target;
    target.setAttribute("aria-describedby", "appTooltip");
    timer = setTimeout(() => {
      if (!active || !active.isConnected) return;
      place(active);
    }, 400);
  };
  document.addEventListener("pointerover", event => {
    const target = event.target.closest(interactive);
    if (!target) return;
    if (active === target) return;
    show(target);
  });
  document.addEventListener("pointerout", event => {
    const target = event.target.closest(interactive);
    if (!target || target !== active) return;
    const next = event.relatedTarget?.closest?.(interactive);
    if (next === active) return;
    hide();
  });
  document.addEventListener("focusin", event => {
    if (event.target.matches(interactive)) show(event.target);
  });
  document.addEventListener("focusout", event => {
    if (event.target.matches(interactive)) hide();
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
}

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
  let message = error && error.message ? error.message : String(error);
  // Electron wraps IPC failures as: Error invoking remote method 'x': Error: <message>
  const ipcMatch = message.match(/^Error invoking remote method '[^']+':(?: Error:)?\s*(.*)$/s);
  if (ipcMatch) message = ipcMatch[1];
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, "[redacted-api-key]")
    .replace(/sk-or-v1-[A-Za-z0-9_-]{10,}/g, "[redacted-api-key]")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[redacted-api-key]")
    .replace(/([?&](?:api_)?key=)[^& \t\r\n]+/gi, "$1[redacted-api-key]")
    .replace(/(?:api_)?key=[A-Za-z0-9_-]{10,}/gi, "key=[redacted-api-key]");
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
  if (Array.isArray(deviceConfig.shortcutPages) && deviceConfig.shortcutPages.length) {
    next.shortcutPages = clone(deviceConfig.shortcutPages);
    while (next.screenDesign.pages.length < next.shortcutPages.length) {
      const page = next.shortcutPages[next.screenDesign.pages.length];
      next.screenDesign.pages.push({ id: page.id, name: page.name, elements: [] });
    }
  }
  return next;
}

function titleForSlot(slot) {
  return SLOT_TITLES[slot] || `Button ${slot}`;
}

function isConfigured(slot) {
  if (multiPageMode() && ["7", "8", "9"].includes(String(slot))) return false;
  const action = currentMacroAction(slot);
  return Boolean(action && action !== "NONE");
}

function currentMacroPage() {
  if (!config?.shortcutPages?.length) return null;
  selectedMacroPage = Math.max(0, Math.min(selectedMacroPage, config.shortcutPages.length - 1));
  return config.shortcutPages[selectedMacroPage];
}

function multiPageMode() { return (config?.shortcutPages?.length || 0) > 1; }

function currentMacroLabel(slot) {
  if (multiPageMode() && BUTTON_SLOTS.slice(0, 6).includes(String(slot))) return currentMacroPage()?.labels?.[slot] || "";
  return config?.labels?.[slot] || "";
}

function currentMacroAction(slot) {
  if (multiPageMode() && BUTTON_SLOTS.slice(0, 6).includes(String(slot))) return currentMacroPage()?.profiles?.[config.host]?.[slot] || "NONE";
  return config?.profiles?.[config.host]?.[slot] || "NONE";
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

function actionIconMarkup(slot) {
  if (multiPageMode() && Number(slot) >= 7) {
    if (String(slot) === "7") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7"/><path d="M7 12h12"/></svg>';
    if (String(slot) === "8") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8h12a4 4 0 0 1 3.8 5.2l-1.2 4A2.4 2.4 0 0 1 17 18.5l-2.3-2h-5.4l-2.3 2a2.4 2.4 0 0 1-3.6-1.3l-1.2-4A4 4 0 0 1 6 8Z"/><path d="M7 11v4m-2-2h4m8-1h.01M18 14h.01"/></svg>';
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5 7 7-7 7"/><path d="M17 12H5"/></svg>';
  }
  const label = `${currentMacroLabel(slot)} ${currentMacroAction(slot)}`.toLowerCase();
  if (/paste|clipboard/.test(label)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="13" height="16" rx="2"/><path d="M9 5.5V4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5M9 10h7m-7 4h7"/></svg>';
  if (/copy|select all/.test(label)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"/></svg>';
  if (/cut/.test(label)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="m8 8 12 12M8 16 20 4"/></svg>';
  if (/undo/.test(label)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 0 14h-2"/></svg>';
  if (/redo/.test(label)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9h-9a7 7 0 0 0 0 14h2"/></svg>';
  if (/save/.test(label)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h13l3 3v13H4z"/><path d="M8 4v6h8V4M8 20v-7h8v7"/></svg>';
  if (/find|search/.test(label)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg>';
  if (/shot|screen|capture/.test(label)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h4l2-2h4l2 2h4v12H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  if (/vol|mute|audio/.test(label)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4z"/><path d="M17 9a5 5 0 0 1 0 6m2-9a9 9 0 0 1 0 12"/></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h.01M11 9h.01M15 9h.01M7 13h.01M11 13h.01M15 13h.01M8 16h8"/></svg>';
}

function createKeyButton(slot, { layout = config.layout, compact = false, draggable = false, selected = false } = {}) {
  const position = slotPosition(slot, layout);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `key-button${selected ? " selected" : ""}${slot === selectedLayoutSlot && layoutEditing ? " layout-selected" : ""}`;
  button.dataset.slot = slot;
  const reserved = multiPageMode() && Number(slot) >= 7;
  const role = slot === "7" ? "Previous Page" : slot === "8" ? "Open Games" : "Next Page";
  button.dataset.tooltip = reserved ? `SW${slot} — ${role}, reserved by multi-page mode` : `SW${slot} — Select physical slot ${slot} to edit its label and shortcut.`;
  button.setAttribute("aria-label", reserved ? `Physical slot SW${slot}, reserved role ${role}` : `Physical slot ${slot}, ${currentMacroLabel(slot) || "Unlabeled"}, ${currentMacroAction(slot)}`);
  button.draggable = draggable;
  if (position) {
    button.style.gridRow = `${position.row + 1} / span ${position.rowSpan}`;
    button.style.gridColumn = `${position.column + 1} / span ${position.columnSpan}`;
  }

  const physical = document.createElement("span");
  physical.className = "key-slot";
  physical.textContent = `SW${slot}`;
  const identity = document.createElement("span");
  identity.className = "key-identity";
  const icon = document.createElement("span");
  icon.className = "key-action-icon";
  icon.innerHTML = actionIconMarkup(slot);
  identity.append(physical, icon);
  const label = document.createElement("span");
  label.className = "key-label";
  label.textContent = reserved ? role : (currentMacroLabel(slot) || "Unassigned");
  const shortcut = document.createElement("span");
  shortcut.className = "key-shortcut";
  shortcut.textContent = reserved ? (slot === "7" ? "Previous · stops at 1" : slot === "8" ? "Games · on device" : `Next · wraps at ${config.shortcutPages.length}`) : currentMacroAction(slot);
  button.append(identity, label, shortcut);
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
  $("dashboardScreenPages").textContent = String(config.shortcutPages.length);
  $("dashboardActivePage").textContent = Number.isInteger(deviceCurrentScreenPage)
    ? `Device showing page ${deviceCurrentScreenPage + 1} of ${config.shortcutPages.length}`
    : `Selected page ${selectedMacroPage + 1} of ${config.shortcutPages.length}`;
  renderBoard($("dashboardBoard"), { compact: true });
  renderEncoderSummary();
}

function renderMacroPages() {
  const select = $("macroPageSelect");
  if (!select || !config?.shortcutPages?.length) return;
  selectedMacroPage = Math.max(0, Math.min(selectedMacroPage, config.shortcutPages.length - 1));
  select.replaceChildren(...config.shortcutPages.map((page, index) => {
    const option = document.createElement("option");
    option.value = String(index); option.textContent = page.name || `Page ${index + 1}`;
    return option;
  }));
  select.value = String(selectedMacroPage);
  $("macroPageCount").textContent = `Page ${selectedMacroPage + 1} of ${config.shortcutPages.length}`;
  $("macroDeletePageButton").disabled = config.shortcutPages.length <= 1;
  $("macroAddPageButton").disabled = config.shortcutPages.length >= 8;
  $("macroDuplicatePageButton").disabled = config.shortcutPages.length >= 8;
  $("macroPageRoleHint").textContent = multiPageMode()
    ? "SW1–SW6 are page-specific. SW7 is Previous, SW8 opens Games, and SW9 is Next (wraps). Roles run on the ESP32 offline."
    : "Single page: SW1–SW9 remain assignable. Add a page to reserve SW7 Previous, SW8 Games, and SW9 Next.";
}

function renderButtonEditor() {
  renderMacroPages();
  $("hostSelect").value = config.host;
  $("buttonHostChip").textContent = HOST_LABELS[config.host];
  $("shortcutHostLabel").textContent = HOST_LABELS[config.host];
  renderBoard($("buttonEditorBoard"), { editor: true });
  const slot = selectedSlot;
  $("selectedSlotBadge").textContent = `SW${slot}`;
  $("selectedSlotTitle").textContent = titleForSlot(slot);
  const pageNavigation = multiPageMode() && Number(slot) >= 7;
  const reservedRole = slot === "7" ? "Previous Page" : slot === "8" ? "Open Games" : "Next Page";
  // Keep #selectedPosition as a stable child node. Never replace the parent <p>
  // via textContent — that deletes the span and crashes the next renderAll().
  $("selectedSlotKind").textContent = pageNavigation ? `Physical Slot ${slot} · ${reservedRole}` : `Physical slot · Shortcut page ${selectedMacroPage + 1}`;
  $("selectedPosition").textContent = pageNavigation
    ? slot === "7" ? "Stops at Page 1" : slot === "8" ? "Opens ESP32 Games; runs without Studio" : `Wraps after Page ${config.shortcutPages.length}`
    : `Visual position ${config.layout.positions[slot].row * 3 + config.layout.positions[slot].column + 1}`;
  $("buttonLabel").value = currentMacroLabel(slot);
  $("buttonShortcut").value = pageNavigation ? reservedRole.toUpperCase() : currentMacroAction(slot);
  $("shortcutPreview").textContent = pageNavigation ? reservedRole.toUpperCase() : currentMacroAction(slot);
  $("buttonLabel").disabled = pageNavigation;
  $("buttonLabel").hidden = pageNavigation;
  $("buttonLabel").previousElementSibling.hidden = pageNavigation;
  $("buttonShortcut").disabled = pageNavigation;
  $("clearShortcutButton").disabled = pageNavigation;
  $("restoreButtonDefault").disabled = pageNavigation;
  $("clearShortcutButton").hidden = pageNavigation;
  $("restoreButtonDefault").hidden = pageNavigation;
  $("normalButtonAssignment").hidden = pageNavigation;
  $("reservedNavigationAction").hidden = !pageNavigation;
  $("reservedNavigationBadge").textContent = reservedRole;
  $("reservedNavigationHelp").textContent = slot === "7" ? "Move to the previous page. Page 1 stays on Page 1." : slot === "8" ? "Open the ESP32 Games menu. Games continue working with Studio disconnected." : `Move to the next page. Page ${config.shortcutPages.length} wraps to Page 1.`;
  $("buttonEditorBoard").setAttribute("aria-description", pageNavigation ? `SW${slot} is reserved for ${reservedRole} while multiple pages are enabled.` : "Physical 3 by 3 button slots.");
  $("sw9ActionDescription").hidden = slot !== "9" || multiPageMode();
  $("sw9ActionDescription").textContent = "SW9 · Physical Slot 9 · Normal shortcut assignment is available while only one page is enabled.";
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

function screenDisplayText(element) {
  if (element.binding === "HOST") return HOST_LABELS[config.host] || "Windows";
  if (element.binding === "LAST") return lastScreenButtonSlot ? (config.labels[lastScreenButtonSlot] || `SW${lastScreenButtonSlot}`) : "--";
  if (element.binding === "ENCODER") return lastScreenEncoderAction || "--";
  if (element.binding === "HID") return hidStatusKnown && !hidIsEnabled ? "HID OFF" : "";
  return element.text;
}

function screenElementBounds(element) {
  if (element.binding === "BITMAP" || element.type === "image") return { x: element.x, y: element.y, width: element.width, height: element.height };
  if (element.type === "shape") return { x: element.x, y: element.y, width: element.width, height: element.height };
  if (element.binding === "KEYGRID") return { x: element.x, y: element.y, width: 62, height: 62 };
  const value = screenDisplayText(element);
  const width = value.length * 6 * element.size;
  let x = element.x;
  if (element.alignment === "CENTER") x -= Math.floor(width / 2);
  else if (element.alignment === "RIGHT") x -= width;
  return { x, y: element.y, width, height: 8 * element.size };
}

function drawScreenSelection(context, bounds) {
  if (screenPreviewMode || !screenGuidesVisible) return;
  const x = Math.max(0, bounds.x - 1);
  const y = Math.max(0, bounds.y - 1);
  const width = Math.min(128 - x, bounds.width + 2);
  const height = Math.min(64 - y, bounds.height + 2);
  context.strokeStyle = "#55d6a2";
  context.lineWidth = 1;
  context.strokeRect(x + .5, y + .5, Math.max(1, width - 1), Math.max(1, height - 1));
  context.fillStyle = "#55d6a2";
  for (const [hx, hy] of [[x, y], [x + width - 2, y], [x, y + height - 2], [x + width - 2, y + height - 2]]) context.fillRect(hx, hy, 2, 2);
}

function drawScreenPreview() {
  const canvas = $("screenCanvas");
  if (!canvas || !config) return;
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#05080c";
  context.fillRect(0, 0, 128, 64);
  screenElements().forEach((element, index) => {
    if (element.visible === false) {
      if (index === selectedScreenElement) drawScreenSelection(context, screenElementBounds(element));
      return;
    }
    if (element.type === "shape") {
      const { x, y, width, height } = element;
      const inverse = element.mode === "INVERSE";
      context.strokeStyle = inverse ? "#05080c" : "#f1f5f9";
      context.fillStyle = inverse ? "#05080c" : "#f1f5f9";
      if (inverse) { context.fillStyle = "#f1f5f9"; context.fillRect(x, y, width, height); context.strokeStyle = "#05080c"; context.fillStyle = "#05080c"; }
      if (element.shape === "RECT") {
        context.strokeRect(x + .5, y + .5, Math.max(0, width - 1), Math.max(0, height - 1));
      } else if (element.shape === "FILL_RECT") {
        if (inverse) { context.fillRect(x + 1, y + 1, Math.max(0, width - 2), Math.max(0, height - 2)); }
        else context.fillRect(x, y, width, height);
      } else if (element.shape === "CIRCLE" || element.shape === "FILL_CIRCLE") {
        context.beginPath(); context.arc(x + width / 2, y + height / 2, Math.max(0, width / 2 - .5), 0, Math.PI * 2);
        if (element.shape === "FILL_CIRCLE" && !inverse) context.fill(); else context.stroke();
        if (inverse && element.shape === "FILL_CIRCLE") { context.beginPath(); context.arc(x + width / 2, y + height / 2, Math.max(0, width / 2 - 2), 0, Math.PI * 2); context.fill(); }
      } else {
        context.beginPath(); context.moveTo(x, y); context.lineTo(x + width - 1, y + height - 1); context.stroke();
      }
      if (index === selectedScreenElement) drawScreenSelection(context, screenElementBounds(element));
      return;
    }
    if (element.binding === "KEYGRID") {
      context.strokeStyle = "#e7edf5";
      for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
        context.beginPath();
        context.roundRect(element.x + column * 22, element.y + row * 22, 18, 18, 3);
        context.stroke();
      }
      if (index === selectedScreenElement) drawScreenSelection(context, screenElementBounds(element));
      return;
    }
    if (element.binding === "BITMAP" || element.type === "image") {
      const bytesPerRow = Math.ceil(element.width / 8);
      if (element.mode === "INVERSE") {
        context.fillStyle = "#f1f5f9";
        context.fillRect(element.x, element.y, element.width, element.height);
      }
      context.fillStyle = element.mode === "INVERSE" ? "#05080c" : "#f1f5f9";
      for (let py = 0; py < element.height; py++) for (let px = 0; px < element.width; px++) {
        const byteIndex = (py * bytesPerRow + (px >> 3)) * 2;
        const byte = Number.parseInt(element.bitmap.slice(byteIndex, byteIndex + 2), 16);
        if (byte & (0x80 >> (px & 7))) context.fillRect(element.x + px, element.y + py, 1, 1);
      }
      if (index === selectedScreenElement) drawScreenSelection(context, screenElementBounds(element));
      return;
    }
    const value = screenDisplayText(element);
    if (!value) return;
    const width = value.length * 6 * element.size;
    let x = element.x;
    if (element.alignment === "CENTER") x -= Math.floor(width / 2);
    else if (element.alignment === "RIGHT") x -= width;
    const inverse = element.mode === "INVERSE";
    context.fillStyle = inverse ? "#f1f5f9" : "#05080c";
    context.fillRect(x, element.y, width, 8 * element.size);
    context.fillStyle = inverse ? "#05080c" : "#f1f5f9";
    const font = window.macropadOledFont;
    for (let n = 0; n < value.length; n++) {
      const code = value.charCodeAt(n);
      const glyph = Math.max(0, Math.min(94, code - 32)) * 5;
      for (let column = 0; column < 5; column++) {
        const bits = font[glyph + column];
        for (let row = 0; row < 7; row++) if (bits & (1 << row)) {
          context.fillRect(x + (n * 6 + column) * element.size, element.y + row * element.size, element.size, element.size);
        }
      }
    }
    if (index === selectedScreenElement) drawScreenSelection(context, { x, y: element.y, width, height: 8 * element.size });
  });
  if (screenGuidesVisible) {
    context.save();
    context.strokeStyle = "rgba(141, 119, 255, .38)";
    context.lineWidth = 0.5;
    context.setLineDash([2, 2]);
    context.beginPath(); context.moveTo(64.5, 0); context.lineTo(64.5, 64); context.moveTo(0, 32.5); context.lineTo(128, 32.5); context.stroke();
    context.restore();
  }
}

function renderScreenElementsList() {
  const list = $("screenElementsList");
  if (!list) return;
  const elements = screenElements();
  list.replaceChildren();
  if (!elements.length) {
    const empty = document.createElement("span"); empty.className = "screen-side-note"; empty.textContent = "No elements yet. Add a tool to begin."; list.append(empty); return;
  }
  elements.forEach((element, index) => {
    const row = document.createElement("div"); row.className = `screen-layer-row${index === selectedScreenElement ? " selected" : ""}`;
    const select = document.createElement("button"); select.type = "button"; select.className = "screen-layer-select";
    const name = element.type === "shape" ? element.shape.replaceAll("_", " ") : element.type === "image" ? (element.icon || "Bitmap") : element.binding === "KEYGRID" ? "Live key grid" : element.binding === "STATIC" ? (element.text || "Text") : element.binding;
    select.textContent = `${String(index + 1).padStart(2, "0")}  ${name}`;
    select.addEventListener("click", () => { selectedScreenElement = index; renderScreenInspector(); });
    const visible = document.createElement("button"); visible.type = "button"; visible.className = "screen-layer-visibility"; visible.textContent = element.visible === false ? "◌" : "◉"; visible.title = element.visible === false ? "Show element" : "Hide element";
    visible.addEventListener("click", () => updateScreenElement("visible", element.visible === false));
    row.append(select, visible); list.append(row);
  });
}

function renderScreenInspector() {
  const element = screenElements()[selectedScreenElement];
  const bitmap = Boolean(element && (element.binding === "BITMAP" || element.type === "image"));
  const shape = Boolean(element?.type === "shape");
  const text = Boolean(element && !bitmap && !shape && element.binding !== "KEYGRID");
  $("screenEmptyInspector").hidden = Boolean(element);
  $("screenInspectorFields").hidden = !element;
  $("screenUndoButton").disabled = screenHistoryIndex <= 0;
  $("screenRedoButton").disabled = screenHistoryIndex >= screenHistory.length - 1;
  $("screenDuplicateButton").disabled = !element || screenElements().length >= 8;
  $("screenCopyButton").disabled = !element;
  $("screenLayerUpButton").disabled = !element || selectedScreenElement >= screenElements().length - 1;
  $("screenLayerDownButton").disabled = !element || selectedScreenElement <= 0;
  $("screenUploadButton").disabled = !connection.connected;
  $("screenReadButton").disabled = !connection.connected;
  $("screenSelectionLabel").textContent = element ? `${shape ? element.shape.replaceAll("_", " ") : bitmap ? "Bitmap image" : element.binding === "KEYGRID" ? "Live key grid" : "Text"} ${selectedScreenElement + 1} · ${screenEventLabel(selectedScreenEvent)}` : "No selection";
  $("screenTextLimit").textContent = bitmap ? `${element.width} × ${element.height} px` : "21 ASCII max";
  $("screenTextFieldWrap").hidden = !text;
  $("screenBindingWrap").hidden = !text;
  $("screenAlignmentWrap").hidden = !text;
  $("screenImageProperties").hidden = !bitmap;
  renderScreenElementsList();
  if (element) {
    $("screenText").value = element.text || "";
    $("screenText").disabled = !text || element.binding !== "STATIC";
    $("screenX").value = element.x;
    $("screenY").value = element.y;
    const bounds = screenElementBounds(element);
    $("screenWidth").value = element.width || bounds.width;
    $("screenHeight").value = element.height || bounds.height;
    $("screenBinding").value = element.binding || "STATIC";
    $("screenSize").value = String(element.size || 1);
    $("screenMode").value = element.mode;
    $("screenAlignment").value = element.alignment || "LEFT";
    $("screenVisibility").checked = element.visible !== false;
    $("screenImageFit").value = element.fit || "contain";
    $("screenThreshold").value = String(element.threshold ?? 128);
    $("screenThresholdValue").textContent = String(element.threshold ?? 128);
    $("screenDither").value = element.dither || "threshold";
  }
  for (const id of ["screenText", "screenX", "screenY", "screenWidth", "screenHeight", "screenBinding", "screenSize", "screenMode", "screenAlignment", "screenVisibility", "screenDeleteButton", "screenImageFit", "screenThreshold", "screenDither"]) $(id).disabled = !element || screenPreviewMode;
  $("screenText").disabled ||= !text || element?.binding !== "STATIC";
  $("screenBinding").disabled ||= !text;
  $("screenSize").disabled ||= !text;
  $("screenAlignment").disabled ||= !text;
  $("screenWidth").disabled ||= !bitmap && !shape;
  $("screenHeight").disabled ||= !bitmap && !shape;
  $("screenImageFit").disabled ||= !element?.rawImage;
  $("screenThreshold").disabled ||= !element?.rawImage;
  $("screenDither").disabled ||= !element?.rawImage;
  if (element?.binding === "KEYGRID") { $("screenMode").disabled = true; $("screenVisibility").disabled = screenPreviewMode; }
  drawScreenPreview();
  updateScreenCanvasScale();
}

function pushScreenHistory() {
  screenHistory = screenHistory.slice(0, screenHistoryIndex + 1);
  screenHistory.push(clone(config.screenDesign));
  if (screenHistory.length > 40) screenHistory.shift();
  screenHistoryIndex = screenHistory.length - 1;
}

function screenBitmapHex(rawImage, width, height, { threshold = 128, dither = "threshold", fit = "contain" } = {}) {
  const source = Uint8Array.from(atob(rawImage.rgba), char => char.charCodeAt(0));
  const sw = rawImage.width, sh = rawImage.height;
  const scale = fit === "cover" ? Math.max(width / sw, height / sh) : Math.min(width / sw, height / sh);
  const drawW = sw * scale, drawH = sh * scale;
  const offsetX = (width - drawW) / 2, offsetY = (height - drawH) / 2;
  const gray = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.floor((x - offsetX) / scale), sy = Math.floor((y - offsetY) / scale);
    if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) { gray[y * width + x] = 0; continue; }
    const p = (sy * sw + sx) * 4, alpha = source[p + 3] / 255;
    gray[y * width + x] = (source[p] * .299 + source[p + 1] * .587 + source[p + 2] * .114) * alpha;
  }
  const errors = new Float32Array(gray);
  const bits = new Uint8Array(width * height);
  const mode = dither.toLowerCase().replace(/[-_\s]/g, "");
  const cutoff = Math.max(0, Math.min(255, Number(threshold) || 0));
  const set = (x, y, error, weight) => { if (x >= 0 && x < width && y >= 0 && y < height) errors[y * width + x] += error * weight; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, value = mode === "none" ? gray[i] : errors[i], bit = value >= (mode === "none" ? 128 : cutoff) ? 1 : 0;
    bits[i] = bit;
    if (mode === "floydsteinberg" || mode === "atkinson") {
      const error = value - (bit ? 255 : 0);
      if (mode === "floydsteinberg") {
        set(x + 1, y, error, 7 / 16); set(x - 1, y + 1, error, 3 / 16); set(x, y + 1, error, 5 / 16); set(x + 1, y + 1, error, 1 / 16);
      } else {
        for (const [dx, dy] of [[1,0],[2,0],[-1,1],[0,1],[1,1],[0,2]]) set(x + dx, y + dy, error / 8, 1);
      }
    }
  }
  const bytesPerRow = Math.ceil(width / 8), bytes = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (bits[y * width + x]) bytes[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function resizeBitmapHex(hex, oldWidth, oldHeight, width, height) {
  const oldStride = Math.ceil(oldWidth / 8), stride = Math.ceil(width / 8), bytes = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.min(oldWidth - 1, Math.floor(x * oldWidth / width));
    const sy = Math.min(oldHeight - 1, Math.floor(y * oldHeight / height));
    const value = Number.parseInt(hex.slice((sy * oldStride + (sx >> 3)) * 2, (sy * oldStride + (sx >> 3)) * 2 + 2), 16);
    if (value & (0x80 >> (sx & 7))) bytes[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function updateScreenElement(field, value) {
  if (!screenElements()[selectedScreenElement]) return;
  const next = clone(config.screenDesign);
  const target = screenEventTargetInDesign(next, selectedScreenEvent);
  if (!target?.elements?.[selectedScreenElement]) return;
  const item = target.elements[selectedScreenElement];
  const numeric = ["x", "y", "size", "width", "height"].includes(field);
  item[field] = numeric ? Number(value) : value;
  if (numeric && !Number.isFinite(item[field])) return;
  if (field === "x") item.x = Math.max(0, Math.min(127, item.x));
  if (field === "y") item.y = Math.max(0, Math.min(63, item.y));
  if (field === "width") item.width = Math.max(1, Math.min(128 - item.x, item.width));
  if (field === "height") item.height = Math.max(1, Math.min(64 - item.y, item.height));
  if (item.type === "shape" && (item.shape === "CIRCLE" || item.shape === "FILL_CIRCLE") && ["width", "height"].includes(field)) {
    const diameter = Math.max(1, Math.min(64, item[field], 128 - item.x, 64 - item.y)); item.width = diameter; item.height = diameter;
  }
  if (item.type === "shape" && item.shape === "LINE" && field === "mode") item.mode = "NORMAL";
  if (item.type === "image" && item.rawImage && ["width", "height", "threshold", "dither", "fit"].includes(field)) {
    item.bitmap = screenBitmapHex(item.rawImage, item.width, item.height, { threshold: item.threshold ?? 128, dither: item.dither || "threshold", fit: item.fit || "contain" });
  } else if (item.type === "image" && ["width", "height"].includes(field)) {
    const oldWidth = screenElements()[selectedScreenElement].width, oldHeight = screenElements()[selectedScreenElement].height;
    item.bitmap = resizeBitmapHex(item.bitmap, oldWidth, oldHeight, item.width, item.height);
  }
  if (item.binding === "KEYGRID") { item.x = Math.min(item.x, 66); item.y = Math.min(item.y, 2); }
  config.screenDesign = next;
  pushScreenHistory();
  renderScreenInspector();
}

function applyScreenDesign(design) {
  config.screenDesign = clone(design);
  selectedScreenPage = 0;
  selectedScreenEvent = "idle";
  selectedScreenElement = 0;
  renderScreenPages();
  screenHistory = [clone(config.screenDesign)];
  screenHistoryIndex = 0;
  renderScreenInspector();
}

async function saveScreenLocally() {
  try {
    config = await window.macropad.saveAppConfig({ ...config, screenDesign: config.screenDesign });
    $("screenDeviceStatus").textContent = "Saved locally · device unchanged";
    toast("Screen design saved locally. The ESP32 was not changed.");
  } catch (error) { toast(`Screen design is invalid: ${formatError(error)}`, true); }
}

async function uploadScreenDesign() {
  if (!connection.connected) { toast("Connect the Macropad before uploading a screen design.", true); return; }
  try {
    const result = await window.macropad.saveScreenDesign(config.screenDesign);
    if (result.cancelled) return;
    if (Number.isInteger(result.currentPage)) deviceCurrentScreenPage = result.currentPage;
    $("screenDeviceStatus").textContent = "Uploaded · verified on ESP32";
    renderDashboard();
    toast("OLED design uploaded and read back from the ESP32.");
    log(`OLED screen layout uploaded and verified (${result.sent} commands).`);
  } catch (error) { $("screenDeviceStatus").textContent = "Upload failed · local copy kept"; toast(`Screen upload failed: ${formatError(error)}`, true); }
}

async function readScreenFromDevice() {
  try {
    const result = await window.macropad.getScreenDesign();
    if (!result.supported) {
      $("screenDeviceStatus").textContent = "Firmware uses its built-in screen";
      toast("This firmware has no saved custom screen design. The current firmware renderer remains active.");
      return;
    }
    deviceCurrentScreenPage = Number.isInteger(result.currentPage) ? result.currentPage : null;
    renderDashboard();
    const same = JSON.stringify(result.design.pages.map(page => page.elements.map(({ id, ...item }) => item))) === JSON.stringify(config.screenDesign.pages.map(page => page.elements.map(({ id, ...item }) => item)));
    $("screenDeviceStatus").textContent = same ? "Local and device designs match" : "Device has a different saved design";
    toast(same ? "The local design matches the ESP32." : "Read completed. The local design was preserved; device design differs.");
  } catch (error) { toast(`Could not read the OLED design: ${formatError(error)}`, true); }
}

async function startScreenImport() {
  try {
    const result = await window.macropad.previewScreenImport();
    if (result.cancelled) return;
    pendingScreenImport = result.design;
    const eventCount = result.design.pages.reduce((total, page) => total + Object.keys(page.events || {}).length, 0);
    $("screenImportSummary").textContent = `${result.fileName} · ${result.design.pages.length} OLED page(s)${eventCount ? ` · ${eventCount} event screen(s)` : ""}`;
    const preview = $("screenImportPreview");
    preview.replaceChildren(...result.design.pages.flatMap((page, pageIndex) => [
      Object.assign(document.createElement("strong"), { textContent: page.name || `Page ${pageIndex + 1}` }),
      ...page.elements.map(item => Object.assign(document.createElement("div"), { textContent: `${item.binding} · ${item.text || "(dynamic)"} · x ${item.x}, y ${item.y} · ${item.size}× · ${item.mode}` }))
    ]));
    $("screenImportDialog").showModal();
  } catch (error) { toast(`Screen import preview failed: ${formatError(error)}`, true); }
}

async function applyScreenImport() {
  if (!pendingScreenImport) return;
  applyScreenDesign(pendingScreenImport);
  pendingScreenImport = null;
  $("screenImportDialog").close();
  $("screenDeviceStatus").textContent = "Imported · local only";
  await saveScreenLocally();
}

let aiStatusData = null;

function getSelectedProviderId() {
  return $("aiProviderSelect")?.value || config?.preferences?.aiProvider || "gemini";
}

function getSelectedModelId() {
  return $("aiModelSelect")?.value || config?.preferences?.aiModel || "gemini-2.5-flash-lite";
}

function updateAiKeyActionAvailability() {
  const storageOk = Boolean(updateAiKeyActionAvailability.secureStorageAvailable);
  const hasDraft = Boolean($("aiKeyInput")?.value?.trim());
  $("aiKeyInput").disabled = false;
  $("aiKeyInput").readOnly = false;
  $("toggleAiKeyButton").disabled = false;
  $("aiEnabledToggle").disabled = false;
  $("saveAiKeyButton").disabled = !storageOk || !hasDraft;
  $("testAiConnectionButton").disabled = !storageOk || !aiKeyConfigured;
  $("clearAiKeyButton").disabled = !aiKeyConfigured;
  $("retrySecureStorageButton").disabled = false;
}

function populateAiProviderSelect(catalog, currentProviderId) {
  const select = $("aiProviderSelect");
  if (!select || !catalog?.providers) return;
  const providers = catalog.providers;
  const previousValue = select.value || currentProviderId;
  select.innerHTML = "";
  for (const p of providers) {
    const option = document.createElement("option");
    option.value = p.id;
    option.textContent = `${p.label} (Free Tier)`;
    select.appendChild(option);
  }
  select.value = providers.some(p => p.id === previousValue) ? previousValue : currentProviderId;
}

function populateAiModelSelect(catalog, providerId, currentModelId) {
  const select = $("aiModelSelect");
  if (!select) return;
  const provider = catalog?.providers?.find(p => p.id === providerId);
  const models = provider?.models || [];
  select.innerHTML = "";
  for (const m of models) {
    const option = document.createElement("option");
    option.value = m.id;
    option.textContent = `${m.label} [FREE]`;
    select.appendChild(option);
  }
  if (currentModelId && models.some(m => m.id === currentModelId)) {
    select.value = currentModelId;
  } else if (models.length > 0) {
    select.value = provider?.defaultModel || models[0].id;
  }
}

function updateAiFieldHints(catalog, providerId) {
  const provider = catalog?.providers?.find(p => p.id === providerId);
  const labelEl = $("aiKeyInputLabel");
  const inputEl = $("aiKeyInput");
  const helpEl = $("aiKeyHelpText");
  if (labelEl) labelEl.textContent = `${provider?.label || "AI"} API Key`;
  if (inputEl) inputEl.placeholder = provider?.keyPlaceholder ? `Paste your ${provider.label} key (${provider.keyPlaceholder})` : "Paste API key…";
  if (helpEl) helpEl.textContent = provider?.help || "Only free-tier models are permitted. Free models have rate limits and availability can change.";
}

async function refreshAiStatus() {
  try {
    const currentProvider = getSelectedProviderId();
    const status = await window.macropad.getAiStatus(currentProvider);
    aiStatusData = status;
    aiKeyConfigured = status.keyConfigured;
    updateAiKeyActionAvailability.secureStorageAvailable = status.secureStorageAvailable;

    if (status.catalog) {
      populateAiProviderSelect(status.catalog, currentProvider);
      populateAiModelSelect(status.catalog, currentProvider, config.preferences.aiModel || status.model);
      updateAiFieldHints(status.catalog, currentProvider);
    }

    const aiReady = status.secureStorageAvailable && status.keyConfigured && config.preferences.aiEnabled;
    const providerTag = (status.providerLabel || currentProvider).toUpperCase();
    $("aiDesignerStatus").textContent = aiReady ? `${providerTag} READY (FREE)` : "AI NOT CONFIGURED";
    $("aiEnabledToggle").checked = config.preferences.aiEnabled;
    $("openAiSettingsButton").hidden = aiReady;
    $("screenAiGenerateButton").disabled = !aiReady;

    const subtitleEl = $("aiAssistantSubtitle");
    if (subtitleEl) {
      subtitleEl.textContent = `Generate OLED screen designs using ${status.providerLabel || "free AI"} · ${status.model || ""} (FREE). A generated design is only applied after your confirmation.`;
    }

    const statusEl = $("aiSettingsStatus");
    const credentialEl = $("aiCredentialStatus");
    const helpEl = $("aiStorageHelp");
    statusEl.classList.remove("is-error", "is-ok");
    credentialEl.classList.remove("is-error", "is-ok");

    if (!status.secureStorageAvailable) {
      statusEl.textContent = status.diagnosis || "Secure storage unavailable.";
      statusEl.classList.add("is-error");
      credentialEl.textContent = `Credential storage: Unavailable — ${status.backendLabel || status.backend || "unknown"}`;
      credentialEl.classList.add("is-error");
      helpEl.hidden = !status.help;
      helpEl.textContent = status.help || "";
    } else {
      statusEl.textContent = status.keyConfigured
        ? `API key saved securely for ${status.providerLabel || currentProvider}.`
        : `Secure storage available. Paste an API key for ${status.providerLabel || currentProvider} and click Save API Key.`;
      statusEl.classList.add("is-ok");
      credentialEl.textContent = `Credential storage: Available — ${status.backendLabel || status.backend || "Electron safeStorage"}`;
      credentialEl.classList.add("is-ok");
      helpEl.hidden = true;
      helpEl.textContent = "";
    }
    updateAiKeyActionAvailability();
  } catch (error) {
    $("aiSettingsStatus").textContent = formatError(error);
    $("aiSettingsStatus").classList.add("is-error");
    updateAiKeyActionAvailability.secureStorageAvailable = false;
    updateAiKeyActionAvailability();
  }
}

async function generateScreenWithAi() {
  if (!aiKeyConfigured || !config.preferences.aiEnabled) {
    $("screenAiResponse").textContent = "AI assistance is not configured. Go to Settings → AI Assistance and add your API key.";
    $("openAiSettingsButton").hidden = false;
    return;
  }
  const prompt = $("screenAiPrompt").value.trim();
  if (!prompt) { toast("Describe the screen layout first.", true); return; }
  try {
    $("screenAiGenerateButton").disabled = true;
    $("screenAiResponse").textContent = `Generating and validating screen layout with ${config.preferences.aiProvider || "free AI"} (${config.preferences.aiModel || ""})…`;
    const result = await window.macropad.generateScreenDesign({
      prompt,
      currentDesign: config.screenDesign,
      providerId: config.preferences.aiProvider,
      model: config.preferences.aiModel
    });
    pendingAiDesign = result.design;
    $("aiDesignCount").textContent = `AI generated ${result.design.pages.length} page(s).`;
    const aiPreview = $("aiDesignPreview");
    aiPreview.replaceChildren(...result.design.pages.flatMap((page, pageIndex) => [
      Object.assign(document.createElement("strong"), { textContent: page.name || `Page ${pageIndex + 1}` }),
      ...page.elements.map(element => Object.assign(document.createElement("div"), { textContent: `${element.binding} · ${element.text || "(dynamic)"} · (${element.x}, ${element.y})` }))
    ]));
    aiPreview.hidden = false;
    $("screenAiResponse").textContent = [result.explanation, ...result.notes].join("\n");
    $("aiDesignReview").hidden = false;
  } catch (error) { $("screenAiResponse").textContent = formatError(error); toast(`AI design failed: ${formatError(error)}`, true); }
  finally { $("screenAiGenerateButton").disabled = false; }
}

function renderSettings() {
  $("themeSelect").value = config.preferences.theme;
  $("gridGapSelect").value = String(config.preferences.gridGap);
  $("aiEnabledToggle").checked = config.preferences.aiEnabled;
  if ($("aiProviderSelect") && config.preferences.aiProvider) {
    $("aiProviderSelect").value = config.preferences.aiProvider;
  }
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
  for (const id of ["gameStartSnakeButton", "gameStartTttButton", "gameMenuButton", "gameExitButton"]) {
    const button = $(id);
    if (button) button.disabled = !connected;
  }
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
  renderScreenPages();
  if (screenHistoryIndex < 0) {
    screenHistory = [clone(config.screenDesign)];
    screenHistoryIndex = 0;
  }
  renderScreenInspector();
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
  if (name === "games") renderGameDeviceStatus();
}

function renderGameDeviceStatus(message) {
  const status = $("gameStatus");
  if (status) status.textContent = message || (connection.connected ? `ESP32 game state: ${deviceGameState}` : "Connect the ESP32 to control games");
}

async function sendDeviceGameCommand(payload) {
  if (!connection.connected) { toast("Connect the ESP32 before sending a game command.", true); return; }
  try {
    const response = await window.macropad.sendGameCommand(payload);
    if (response === "OK GAME EXIT") deviceGameState = "EXIT";
    else if (response === "OK GAME MENU") deviceGameState = "MENU";
    else if (response === "OK GAME START SNAKE") deviceGameState = "SNAKE";
    else if (response === "OK GAME START TTT") deviceGameState = "TTT";
    renderGameDeviceStatus(response);
    log(`→ ${response}`);
  } catch (error) {
    renderGameDeviceStatus(`Game command failed: ${formatError(error)}`);
    toast(`Could not control the ESP32 game: ${formatError(error)}`, true);
  }
}

async function refreshDeviceGameStatus() {
  if (!connection.connected) return;
  try {
    const response = await window.macropad.sendGameCommand({ action: "status" });
    const match = response.match(/^GAME STATE (EXIT|MENU|SNAKE|TTT)$/i);
    if (match) deviceGameState = match[1].toUpperCase();
    renderGameDeviceStatus(response);
  } catch (error) {
    renderGameDeviceStatus(`Device game runtime not detected: ${formatError(error)}`);
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
  const label = value.slice(0, 8);
  if (multiPageMode() && Number(selectedSlot) <= 6) currentMacroPage().labels[selectedSlot] = label;
  config.labels[selectedSlot] = label;
  markDevicePending();
  renderDashboard();
  renderButtonEditor();
}

function setSelectedShortcut(value) {
  const shortcut = value.trim().toUpperCase() || "NONE";
  if (multiPageMode() && Number(selectedSlot) <= 6) currentMacroPage().profiles[config.host][selectedSlot] = shortcut;
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
  initializeTooltips();
  document.querySelectorAll(".nav-item").forEach(button => button.addEventListener("click", () => showPage(button.dataset.view)));
  document.querySelectorAll("[data-go-view]").forEach(button => button.addEventListener("click", () => showPage(button.dataset.goView)));
  $("hostSelect").addEventListener("change", () => changeHost($("hostSelect").value));
  $("macroPageSelect").addEventListener("change", event => {
    selectedMacroPage = Number(event.target.value);
    if (selectedMacroPage < config.screenDesign.pages.length) selectScreenPageIndex(selectedMacroPage);
    renderMacroPages(); renderButtonEditor(); renderDashboard();
  });
  $("macroAddPageButton").addEventListener("click", () => {
    selectedScreenPage = Math.min(selectedMacroPage, config.screenDesign.pages.length - 1);
    addScreenPage();
  });
  $("macroDuplicatePageButton").addEventListener("click", () => {
    selectedScreenPage = Math.min(selectedMacroPage, config.screenDesign.pages.length - 1);
    addScreenPage({ duplicate: true });
  });
  $("macroRenamePageButton").addEventListener("click", renameCurrentPage);
  $("macroDeletePageButton").addEventListener("click", () => $("screenDeletePageButton").click());
  $("gameStartSnakeButton").addEventListener("click", () => sendDeviceGameCommand({ action: "start", game: "snake" }));
  $("gameStartTttButton").addEventListener("click", () => sendDeviceGameCommand({ action: "start", game: "ttt" }));
  $("gameMenuButton").addEventListener("click", () => sendDeviceGameCommand({ action: "menu" }));
  $("gameExitButton").addEventListener("click", () => sendDeviceGameCommand({ action: "exit" }));
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
    if (multiPageMode() && Number(selectedSlot) <= 6) currentMacroPage().profiles[config.host][selectedSlot] = "NONE";
    config.profiles[config.host][selectedSlot] = "NONE";
    $("buttonShortcut").value = "NONE";
    $("shortcutPreview").textContent = "NONE";
    markDevicePending();
    renderAll();
  });
  $("restoreButtonDefault").addEventListener("click", () => {
    if (multiPageMode() && Number(selectedSlot) <= 6) {
      currentMacroPage().labels[selectedSlot] = "";
      currentMacroPage().profiles[config.host][selectedSlot] = DEFAULT_ACTIONS[selectedSlot];
    }
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
  $("screenPageSelect").addEventListener("change", event => selectScreenPageIndex(Number(event.target.value)));
  $("screenAddPageButton").addEventListener("click", () => addScreenPage());
  $("screenDuplicatePageButton").addEventListener("click", () => addScreenPage({ duplicate: true }));
  $("screenRenamePageButton").addEventListener("click", renameCurrentPage);
  $("screenDeletePageButton").addEventListener("click", () => {
    if (config.screenDesign.pages.length <= 1) { toast("The final OLED page cannot be deleted.", true); return; }
    const returningToSingle = config.screenDesign.pages.length === 2;
    if (returningToSingle && !window.confirm("Delete this page and return to a single OLED page? Physical SW9 will resume its normal macro assignment after you upload.")) return;
    if (!returningToSingle && !window.confirm(`Delete ${config.screenDesign.pages[selectedScreenPage].name || `Page ${selectedScreenPage + 1}`}?`)) return;
    config.screenDesign.pages.splice(selectedScreenPage, 1);
    const macroPage = config.shortcutPages[selectedScreenPage];
    if (macroPage && macroPage.id === config.screenDesign.pages[selectedScreenPage]?.id) config.shortcutPages.splice(selectedScreenPage, 1);
    else if (macroPage) config.shortcutPages.splice(selectedScreenPage, 1);
    selectedScreenPage = Math.max(0, Math.min(selectedScreenPage, config.screenDesign.pages.length - 1));
    selectedMacroPage = Math.max(0, Math.min(selectedMacroPage, config.shortcutPages.length - 1));
    selectedScreenElement = 0;
    pushScreenHistory();
    renderScreenPages();
    renderScreenInspector();
    renderButtonEditor();
    renderDashboard();
    markDevicePending();
  });
  $("screenShowPageButton").addEventListener("click", async () => {
    if (!connection.connected) return;
    try {
      await window.macropad.selectScreenPage(selectedScreenPage);
      deviceCurrentScreenPage = selectedScreenPage;
      renderDashboard();
      toast(`Selected OLED Page ${selectedScreenPage + 1} on the ESP32.`);
    }
    catch (error) { toast(formatError(error), true); }
  });
  $("screenAddButton").addEventListener("click", () => {
    ensureScreenEventDesign();
    if (screenElements().length >= 8) { toast("Firmware supports at most eight elements per screen.", true); return; }
    screenElements().push({ id: `text-${Date.now().toString(36)}`, x: 4, y: 4, size: 1, mode: "NORMAL", alignment: "LEFT", binding: "STATIC", text: "Text" });
    selectedScreenElement = screenElements().length - 1; pushScreenHistory(); renderScreenInspector();
  });
  const addScreenShape = shape => {
    ensureScreenEventDesign();
    if (screenElements().length >= 8) { toast("Firmware supports at most eight elements per screen.", true); return; }
    const circle = shape.includes("CIRCLE");
    screenElements().push({ id: `shape-${Date.now().toString(36)}`, type: "shape", shape, x: 12, y: 12, width: circle ? 16 : 32, height: circle ? 16 : 20, mode: "NORMAL" });
    selectedScreenElement = screenElements().length - 1; pushScreenHistory(); renderScreenInspector();
  };
  $("screenAddRectButton").addEventListener("click", () => addScreenShape("RECT"));
  $("screenAddFillRectButton").addEventListener("click", () => addScreenShape("FILL_RECT"));
  $("screenAddCircleButton").addEventListener("click", () => addScreenShape("CIRCLE"));
  $("screenAddFillCircleButton").addEventListener("click", () => addScreenShape("FILL_CIRCLE"));
  $("screenAddLineButton").addEventListener("click", () => addScreenShape("LINE"));
  $("screenImageImportButton").addEventListener("click", () => $("screenImageFile").click());
  $("screenImageFile").addEventListener("change", async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("Choose an image smaller than 8 MB.");
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 128 / bitmap.width, 64 / bitmap.height);
      const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
      const source = document.createElement("canvas"); source.width = width; source.height = height;
      const ctx = source.getContext("2d", { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0, width, height); bitmap.close();
      const rgba = ctx.getImageData(0, 0, width, height).data;
      let binary = ""; for (let offset = 0; offset < rgba.length; offset += 8192) binary += String.fromCharCode(...rgba.subarray(offset, offset + 8192));
      const rawImage = { width, height, rgba: btoa(binary) };
      const item = { id: `image-${Date.now().toString(36)}`, type: "image", x: 4, y: 4, width, height, mode: "NORMAL", binding: "BITMAP", rawImage, source: file.name.slice(0, 200), threshold: 128, dither: "threshold", fit: "contain" };
      item.bitmap = screenBitmapHex(rawImage, width, height);
      ensureScreenEventDesign(); if (screenElements().length >= 8) throw new Error("Firmware supports at most eight elements per screen.");
      screenElements().push(item); selectedScreenElement = screenElements().length - 1; pushScreenHistory(); renderScreenInspector();
      toast("Image converted to a monochrome SSD1306 bitmap. Adjust threshold and dithering in Properties.");
    } catch (error) { toast(`Image import failed: ${formatError(error)}`, true); }
    finally { event.target.value = ""; }
  });
  $("screenAddIconButton").addEventListener("click", addScreenIcon);
  $("screenDuplicateButton").addEventListener("click", () => {
    ensureScreenEventDesign();
    const selected = screenElements()[selectedScreenElement];
    if (!selected || screenElements().length >= 8) return;
    screenElements().push({ ...selected, id: `copy-${Date.now().toString(36)}`, x: Math.min(127, selected.x + 6), y: Math.min(63, selected.y + 8) });
    selectedScreenElement = screenElements().length - 1; pushScreenHistory(); renderScreenInspector();
  });
  $("screenCopyButton").addEventListener("click", () => { const item = screenElements()[selectedScreenElement]; if (item) { screenClipboard = clone(item); $("screenPasteButton").disabled = false; } });
  $("screenPasteButton").addEventListener("click", () => {
    if (!screenClipboard || screenElements().length >= 8) return;
    const item = { ...clone(screenClipboard), id: `paste-${Date.now().toString(36)}`, x: Math.min(127, screenClipboard.x + 4), y: Math.min(63, screenClipboard.y + 4) };
    screenElements().push(item); selectedScreenElement = screenElements().length - 1; pushScreenHistory(); renderScreenInspector();
  });
  for (const [id, offset] of [["screenLayerUpButton", 1], ["screenLayerDownButton", -1]]) $(id).addEventListener("click", () => {
    const list = screenElements(), from = selectedScreenElement, to = from + offset;
    if (to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]]; selectedScreenElement = to; pushScreenHistory(); renderScreenInspector();
  });
  $("screenDeleteButton").addEventListener("click", () => {
    ensureScreenEventDesign();
    if (!screenElements()[selectedScreenElement]) return;
    screenElements().splice(selectedScreenElement, 1);
    selectedScreenElement = Math.max(0, selectedScreenElement - 1); pushScreenHistory(); renderScreenInspector();
  });
  $("screenEventSelect").addEventListener("change", event => selectScreenEvent(event.target.value));
  $("screenZoomSelect").addEventListener("change", updateScreenCanvasScale);
  $("screenGridToggle").addEventListener("change", updateScreenCanvasScale);
  $("screenGuidesToggle").addEventListener("change", event => {
    screenGuidesVisible = event.target.checked;
    drawScreenPreview();
  });
  const updateScreenEventOptions = () => {
    if (!config?.screenDesign) return;
    config.screenDesign.eventOptions = {
      duration: $("screenEventDuration").value,
      trigger: $("screenEventTrigger").value === "RELEASE" ? "RELEASE" : "PRESS"
    };
    pushScreenHistory();
    renderScreenEvents();
  };
  $("screenEventDuration").addEventListener("change", updateScreenEventOptions);
  $("screenEventTrigger").addEventListener("change", updateScreenEventOptions);
  $("screenDuplicateEventButton").addEventListener("click", () => {
    if (!config?.screenDesign?.pages?.length) return;
    const targetId = $("screenEventDuplicateTarget").value || "idle";
    const sourceElements = screenElements();
    if (!sourceElements.length) { toast("The selected event has no elements to duplicate.", true); return; }
    const next = clone(config.screenDesign);
    const target = screenEventTargetInDesign(next, targetId);
    if (!target) return;
    target.elements = clone(sourceElements).map((element, index) => ({ ...element, id: `ev-${targetId}-${index}`.slice(0, 24) }));
    config.screenDesign = next;
    pushScreenHistory();
    renderScreenPages();
    renderScreenInspector();
    toast(`Duplicated the ${screenEventLabel(selectedScreenEvent)} design to ${screenEventLabel(targetId)}.`);
  });
  for (const [id, field] of [["screenText", "text"], ["screenX", "x"], ["screenY", "y"], ["screenWidth", "width"], ["screenHeight", "height"], ["screenBinding", "binding"], ["screenSize", "size"], ["screenMode", "mode"], ["screenAlignment", "alignment"], ["screenImageFit", "fit"], ["screenThreshold", "threshold"], ["screenDither", "dither"]]) {
    $(id).addEventListener(id === "screenText" ? "input" : "change", event => updateScreenElement(field, event.target.value));
  }
  $("screenVisibility").addEventListener("change", event => updateScreenElement("visible", event.target.checked));
  $("screenUndoButton").addEventListener("click", () => {
    if (screenHistoryIndex <= 0) return;
    screenHistoryIndex--; config.screenDesign = clone(screenHistory[screenHistoryIndex]);
    selectedScreenPage = Math.min(selectedScreenPage, config.screenDesign.pages.length - 1); renderScreenPages();
    selectedScreenElement = Math.max(0, Math.min(selectedScreenElement, screenElements().length - 1)); renderScreenInspector();
  });
  $("screenRedoButton").addEventListener("click", () => {
    if (screenHistoryIndex >= screenHistory.length - 1) return;
    screenHistoryIndex++; config.screenDesign = clone(screenHistory[screenHistoryIndex]);
    selectedScreenPage = Math.min(selectedScreenPage, config.screenDesign.pages.length - 1); renderScreenPages();
    selectedScreenElement = Math.max(0, Math.min(selectedScreenElement, screenElements().length - 1)); renderScreenInspector();
  });
  $("screenPreviewButton").addEventListener("click", event => {
    screenPreviewMode = !screenPreviewMode;
    event.currentTarget.textContent = screenPreviewMode ? "Edit mode" : "Preview mode"; renderScreenInspector();
  });
  $("screenCanvas").addEventListener("pointerdown", event => {
    if (screenPreviewMode) return;
    const canvas = event.currentTarget;
    const px = event.offsetX * 128 / canvas.clientWidth;
    const py = event.offsetY * 64 / canvas.clientHeight;
    let hit = -1;
    for (let i = screenElements().length - 1; i >= 0; i--) {
      const item = screenElements()[i];
      const bounds = screenElementBounds(item);
      if (px >= bounds.x - 2 && px <= bounds.x + bounds.width + 2 && py >= bounds.y - 2 && py <= bounds.y + bounds.height + 2) { hit = i; break; }
    }
    if (hit < 0) return;
    ensureScreenEventDesign();
    selectedScreenElement = hit; screenDrag = true; canvas.setPointerCapture(event.pointerId); renderScreenInspector();
  });
  $("screenCanvas").addEventListener("pointermove", event => {
    if (!screenDrag) return;
    const item = screenElements()[selectedScreenElement];
    if (!item) return;
    const bounds = screenElementBounds(item);
    const maxX = 128 - bounds.width;
    const maxY = 64 - bounds.height;
    item.x = Math.max(0, Math.min(maxX, Math.floor(event.offsetX * 128 / event.currentTarget.clientWidth)));
    item.y = Math.max(0, Math.min(maxY, Math.floor(event.offsetY * 64 / event.currentTarget.clientHeight)));
    $("screenX").value = item.x; $("screenY").value = item.y; drawScreenPreview();
  });
  $("screenCanvas").addEventListener("pointerup", () => { if (screenDrag) pushScreenHistory(); screenDrag = false; renderScreenInspector(); });
  $("screenCanvas").addEventListener("pointercancel", () => { screenDrag = false; renderScreenInspector(); });
  $("screenSaveButton").addEventListener("click", saveScreenLocally);
  $("screenUploadButton").addEventListener("click", uploadScreenDesign);
  $("screenReadButton").addEventListener("click", readScreenFromDevice);
  $("screenExportButton").addEventListener("click", async () => {
    try {
      config = await window.macropad.saveAppConfig(config);
    const result = await window.macropad.exportScreenDesign(config.screenDesign);
      if (!result.cancelled) toast(`Screen design exported to ${result.fileName}.`);
    } catch (error) { toast(`Screen export failed: ${formatError(error)}`, true); }
  });
  $("screenImportButton").addEventListener("click", startScreenImport);
  $("screenApplyImportButton").addEventListener("click", applyScreenImport);
  $("screenImportDialog").addEventListener("close", () => { pendingScreenImport = null; });
  $("screenAiGenerateButton").addEventListener("click", generateScreenWithAi);
  $("applyAiDesignButton").addEventListener("click", () => {
    if (!pendingAiDesign) return;
    applyScreenDesign(pendingAiDesign); pendingAiDesign = null; $("aiDesignReview").hidden = true; $("aiDesignPreview").hidden = true;
    $("screenDeviceStatus").textContent = "AI design · local only";
    toast("AI design applied locally. It will not reach the ESP32 until you explicitly upload it.");
  });
  $("cancelAiDesignButton").addEventListener("click", () => { pendingAiDesign = null; $("aiDesignReview").hidden = true; $("aiDesignPreview").hidden = true; $("screenAiResponse").textContent = "Generated design discarded."; });
  $("openAiSettingsButton").addEventListener("click", () => showPage("settings"));
  $("aiProviderSelect").addEventListener("change", async event => {
    const newProvider = event.target.value;
    config.preferences.aiProvider = newProvider;
    const provider = aiStatusData?.catalog?.providers?.find(p => p.id === newProvider);
    config.preferences.aiModel = provider?.defaultModel || provider?.models?.[0]?.id || "";
    $("aiKeyInput").value = "";
    $("aiKeyInput").type = "password";
    $("toggleAiKeyButton").textContent = "Show";
    await persistNow();
    await refreshAiStatus();
  });
  $("aiModelSelect").addEventListener("change", async event => {
    config.preferences.aiModel = event.target.value;
    await persistNow();
    await refreshAiStatus();
  });
  $("toggleAiKeyButton").addEventListener("click", event => {
    const input = $("aiKeyInput"); const shown = input.type === "text";
    input.type = shown ? "password" : "text"; event.currentTarget.textContent = shown ? "Show" : "Hide";
  });
  $("aiEnabledToggle").addEventListener("change", async event => {
    try { await window.macropad.setAiEnabled(event.target.checked); config.preferences.aiEnabled = event.target.checked; await refreshAiStatus(); }
    catch (error) { event.target.checked = !event.target.checked; toast(formatError(error), true); }
  });
  $("aiKeyInput").addEventListener("input", updateAiKeyActionAvailability);
  $("aiKeyInput").addEventListener("paste", () => setTimeout(updateAiKeyActionAvailability, 0));
  $("retrySecureStorageButton").addEventListener("click", async () => {
    $("aiSettingsStatus").textContent = "Rechecking secure storage…";
    $("aiSettingsStatus").classList.remove("is-error", "is-ok");
    try {
      await window.macropad.retrySecureStorage();
      await refreshAiStatus();
      if (!updateAiKeyActionAvailability.secureStorageAvailable) {
        toast("Secure storage is still unavailable. Unlock your keyring or install gnome-keyring, then restart Macropad Studio.", true);
      }
    } catch (error) {
      $("aiSettingsStatus").textContent = formatError(error);
      $("aiSettingsStatus").classList.add("is-error");
    }
  });
  $("testAiConnectionButton").addEventListener("click", async () => {
    const providerId = getSelectedProviderId();
    const model = getSelectedModelId();
    $("aiSettingsStatus").textContent = `Testing ${providerId} connection with model ${model}…`;
    $("aiSettingsStatus").classList.remove("is-error", "is-ok");
    try {
      const result = await window.macropad.testAiConnection({ providerId, model });
      $("aiSettingsStatus").textContent = result.message;
      $("aiSettingsStatus").classList.add("is-ok");
    } catch (error) {
      $("aiSettingsStatus").textContent = formatError(error);
      $("aiSettingsStatus").classList.add("is-error");
    }
  });
  $("saveAiKeyButton").addEventListener("click", async () => {
    const providerId = getSelectedProviderId();
    try {
      const result = await window.macropad.setAiKey($("aiKeyInput").value, providerId);
      aiKeyConfigured = result.keyConfigured;
      $("aiKeyInput").value = "";
      $("aiKeyInput").type = "password";
      $("toggleAiKeyButton").textContent = "Show";
      await refreshAiStatus();
      $("aiSettingsStatus").textContent = `API key saved securely for ${providerId}.`;
      $("aiSettingsStatus").classList.add("is-ok");
    } catch (error) {
      $("aiSettingsStatus").textContent = formatError(error);
      $("aiSettingsStatus").classList.add("is-error");
      toast(`Could not store API key: ${formatError(error)}`, true);
    }
  });
  $("clearAiKeyButton").addEventListener("click", async () => {
    const providerId = getSelectedProviderId();
    try {
      await window.macropad.clearAiKey(providerId);
      await refreshAiStatus();
      $("aiSettingsStatus").textContent = `Saved API key removed for ${providerId}.`;
    } catch (error) {
      $("aiSettingsStatus").textContent = formatError(error);
      $("aiSettingsStatus").classList.add("is-error");
      toast(`Could not remove API key: ${formatError(error)}`, true);
    }
  });
  $("refreshDeviceInfoButton").addEventListener("click", refreshDeviceInfo);
  $("clearActivityButton").addEventListener("click", () => { $("activityLog").textContent = ""; });
  $("importPreviewDialog").addEventListener("close", () => { importPreview = null; });

  unsubscribeEvents.push(
    window.macropad.onConnection(data => {
      connection = data;
      renderSyncSummary();
      renderGameDeviceStatus();
      if (data.connected) refreshDeviceGameStatus();
      if (config) renderDashboard();
      renderDeviceInfo();
    }),
    window.macropad.onDiscovered(handleDiscovery),
    window.macropad.onSerialLine(line => {
      log(`← ${line}`);
      const pageMatch = line.match(/^PAGE\s+(\d+)\s+(\d+)$/i);
      if (pageMatch) {
        const page = Number(pageMatch[1]) - 1, total = Number(pageMatch[2]);
        if (Number.isInteger(page) && page >= 0 && page < config.shortcutPages.length && total === config.shortcutPages.length) {
          selectedMacroPage = page;
          deviceCurrentScreenPage = page;
          if (page < config.screenDesign.pages.length) selectScreenPageIndex(page);
          renderMacroPages(); renderButtonEditor(); renderDashboard(); renderScreenPages();
        }
      }
      if (/^NAV GAMES$/i.test(line)) { deviceGameState = "MENU"; showPage("games"); renderGameDeviceStatus("Games menu is running on the ESP32 OLED"); }
      const gameStateMatch = line.match(/^(?:GAME STATE |OK GAME )(EXIT|MENU|SNAKE|TTT|START SNAKE|START TTT)$/i);
      if (gameStateMatch) { deviceGameState = gameStateMatch[1].toUpperCase().replace(/^START /, ""); renderGameDeviceStatus(line); }
      const buttonMatch = line.match(/^SW([1-9])\s+->/i);
      const encoderMatch = line.match(/^Knob:\s*(.+)$/i);
      if (buttonMatch) lastScreenButtonSlot = buttonMatch[1];
      if (encoderMatch) lastScreenEncoderAction = encoderMatch[1].trim().slice(0, 20);
      if (/^SAFE MODE:/i.test(line)) { hidStatusKnown = true; hidIsEnabled = false; }
      if (buttonMatch || encoderMatch || /^SAFE MODE:/i.test(line)) drawScreenPreview();
    }),
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
    selectedScreenPage = 0;
    configLoaded = true;
    await loadScreenIconOptions();
    const version = await window.macropad.getVersion();
    $("appVersion").textContent = version;
    await refreshAiStatus();
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
