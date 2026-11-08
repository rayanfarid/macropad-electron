const { getBuiltinIcon } = require("./icon-library");

const SCREEN_WIDTH = 128;
const SCREEN_HEIGHT = 64;
const SCREEN_DESIGN_VERSION = 2;
const MAX_SCREEN_ELEMENTS = 8;
const MAX_SCREEN_PAGES = 8;
const MAX_PAGE_BITMAP_BYTES = 1024;
const MAX_TOTAL_BITMAP_BYTES = 8192;
const MAX_EVENT_BITMAP_BYTES = 8192;
const MAX_EVENT_BITMAP_PER_DESIGN = 256;   // firmware event arena per event screen
const MAX_IMAGE_ELEMENTS_PER_PAGE = 8;

// OLED event screens. Each page may carry an independent validated layout per event.
// "idle" overrides the page design while no temporary event screen is active;
// when absent the page's own elements are the idle screen (backward compatible).
const SCREEN_EVENT_IDS = [
  "idle",
  "sw1Press", "sw2Press", "sw3Press", "sw4Press", "sw5Press", "sw6Press", "sw7Press", "sw8Press", "sw9Press",
  "encoderCW", "encoderCCW", "encoderPress"
];
const SCREEN_EVENT_SET = new Set(SCREEN_EVENT_IDS);
const SCREEN_EVENT_LABELS = {
  idle: "Idle", sw1Press: "SW1 Press", sw2Press: "SW2 Press", sw3Press: "SW3 Press",
  sw4Press: "SW4 Press", sw5Press: "SW5 Press", sw6Press: "SW6 Press", sw7Press: "SW7 Press",
  sw8Press: "SW8 Press", sw9Press: "SW9 Press", encoderCW: "Encoder CW",
  encoderCCW: "Encoder CCW", encoderPress: "Encoder Press"
};
// Wire tokens understood by the ESP32 firmware SCREEN EVENTS protocol.
const SCREEN_EVENT_PROTOCOL = {
  idle: "IDLE",
  sw1Press: "SW1", sw2Press: "SW2", sw3Press: "SW3", sw4Press: "SW4", sw5Press: "SW5",
  sw6Press: "SW6", sw7Press: "SW7", sw8Press: "SW8", sw9Press: "SW9",
  encoderCW: "ENCW", encoderCCW: "ENCCW", encoderPress: "ENCP"
};
const PROTOCOL_SCREEN_EVENTS = Object.fromEntries(Object.entries(SCREEN_EVENT_PROTOCOL).map(([id, token]) => [token, id]));
const EVENT_DURATIONS = new Set(["500", "1000", "1500", "2000", "3000", "STICKY", "HOLD"]);
const EVENT_TRIGGERS = new Set(["PRESS", "RELEASE"]);
const DEFAULT_EVENT_OPTIONS = Object.freeze({ duration: "1500", trigger: "PRESS" });

const BINDINGS = new Set(["STATIC", "HOST", "LAST", "ENCODER", "HID", "KEYGRID", "BITMAP"]);
const ALIGNMENTS = new Set(["LEFT", "CENTER", "RIGHT"]);
const MODES = new Set(["NORMAL", "INVERSE"]);

const ALLOWED_TEXT_KEYS = new Set(["id", "type", "x", "y", "size", "mode", "alignment", "binding", "text"]);
const ALLOWED_IMAGE_KEYS = new Set([
  "id", "type", "x", "y", "width", "height", "mode", "binding", "bitmap",
  "rotation", "scale", "threshold", "dither", "invert", "crop", "icon", "source", "rawImage", "src", "visible", "fit"
]);
const ALLOWED_SHAPE_KEYS = new Set(["id", "type", "shape", "x", "y", "width", "height", "mode", "visible"]);

function defaultElements() {
  return [
    { id: "key-grid", x: 4, y: 1, size: 1, mode: "NORMAL", alignment: "LEFT", binding: "KEYGRID", text: "" },
    { id: "host", x: 74, y: 2, size: 1, mode: "INVERSE", alignment: "LEFT", binding: "HOST", text: "" },
    { id: "last-label", x: 72, y: 20, size: 1, mode: "NORMAL", alignment: "LEFT", binding: "STATIC", text: "Last:" },
    { id: "last", x: 72, y: 31, size: 1, mode: "NORMAL", alignment: "LEFT", binding: "LAST", text: "" },
    { id: "encoder", x: 72, y: 44, size: 1, mode: "NORMAL", alignment: "LEFT", binding: "ENCODER", text: "" },
    { id: "hid", x: 72, y: 55, size: 1, mode: "NORMAL", alignment: "LEFT", binding: "HID", text: "" }
  ];
}

function createDefaultScreenPage(index = 0) {
  return { id: `screen-page-${index + 1}`, name: `Page ${index + 1}`, elements: defaultElements() };
}

function createDefaultScreenDesign() {
  return { version: SCREEN_DESIGN_VERSION, pages: [createDefaultScreenPage()] };
}

function validateElements(elements, { maxBitmapBytes = MAX_PAGE_BITMAP_BYTES } = {}) {
  if (!Array.isArray(elements) || elements.length > MAX_SCREEN_ELEMENTS) {
    throw new Error(`Each OLED page supports at most ${MAX_SCREEN_ELEMENTS} elements`);
  }
  const ids = new Set();
  let pageBitmapBytes = 0;
  let imageElementCount = 0;

  return elements.map((element, index) => {
    if (!element || typeof element !== "object" || Array.isArray(element)) {
      throw new Error(`Screen element ${index + 1} is invalid`);
    }

    const isImage = element.type === "image" || element.binding === "BITMAP";
    const isShape = element.type === "shape";
    const allowedKeys = isImage ? ALLOWED_IMAGE_KEYS : isShape ? ALLOWED_SHAPE_KEYS : new Set([...ALLOWED_TEXT_KEYS, "visible"]);

    if (Object.keys(element).some(key => !allowedKeys.has(key))) {
      throw new Error(`Screen element ${index + 1} contains an unsupported property`);
    }

    const { id, x, y } = element;
    if (typeof id !== "string" || !/^[a-z0-9-]{1,24}$/i.test(id) || ids.has(id)) {
      throw new Error(`Screen element ${index + 1} has an invalid or duplicate ID`);
    }
    ids.add(id);

    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT) {
      throw new Error(`Position for ${id} is outside the 128×64 display`);
    }

    const mode = (element.mode || "NORMAL").toUpperCase();
    if (!MODES.has(mode)) {
      throw new Error(`Unsupported rendering option for ${id}`);
    }

    if (element.visible !== undefined && typeof element.visible !== "boolean") throw new Error(`Visibility for ${id} must be a boolean`);
    if (isShape) {
      const shape = String(element.shape || "").toUpperCase();
      if (!["RECT", "FILL_RECT", "CIRCLE", "FILL_CIRCLE", "LINE"].includes(shape)) throw new Error(`Unsupported shape for ${id}`);
      const { width, height } = element;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || x + width > SCREEN_WIDTH || y + height > SCREEN_HEIGHT) {
        throw new Error(`Shape ${id} must fit within the 128×64 display`);
      }
      if ((shape === "CIRCLE" || shape === "FILL_CIRCLE") && width !== height) throw new Error(`Circle ${id} must have equal width and height`);
      return { id, type: "shape", shape, x, y, width, height, mode, ...(element.visible === false ? { visible: false } : {}) };
    }

    if (isImage) {
      imageElementCount++;
      if (imageElementCount > MAX_IMAGE_ELEMENTS_PER_PAGE) {
        throw new Error(`Each OLED page supports at most ${MAX_IMAGE_ELEMENTS_PER_PAGE} image elements`);
      }

      let { width, height, bitmap } = element;

      // Auto-resolve built-in icon if bitmap is missing but icon is given
      if (!bitmap && element.icon) {
        const builtin = getBuiltinIcon(element.icon);
        if (builtin) {
          width = width || builtin.width;
          height = height || builtin.height;
          bitmap = builtin.bitmap;
        }
      }

      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > SCREEN_WIDTH || height < 1 || height > SCREEN_HEIGHT) {
        throw new Error(`Dimensions for image element ${id} must fit within 128×64 (received ${width}×${height})`);
      }

      if (x + width > SCREEN_WIDTH || y + height > SCREEN_HEIGHT) {
        throw new Error(`Image element ${id} exceeds display bounds (${x + width}×${y + height} > 128×64)`);
      }

      const expectedBytes = Math.ceil(width / 8) * height;
      const expectedHexLength = expectedBytes * 2;

      if (typeof bitmap !== "string" || bitmap.length !== expectedHexLength || !/^[0-9a-f]+$/i.test(bitmap)) {
        throw new Error(`Bitmap data for ${id} is malformed or invalid length (expected ${expectedBytes} bytes / ${expectedHexLength} hex chars)`);
      }

      pageBitmapBytes += expectedBytes;
      if (pageBitmapBytes > maxBitmapBytes) {
        throw new Error(`OLED bitmap memory exceeds ${maxBitmapBytes} bytes (requested ${pageBitmapBytes} bytes)`);
      }

      const validImage = {
        id,
        type: "image",
        x,
        y,
        width,
        height,
        mode,
        binding: "BITMAP",
        bitmap: bitmap.toLowerCase()
      };
      if (element.visible === false) validImage.visible = false;

      if (element.fit !== undefined) {
        if (!["contain", "cover"].includes(element.fit)) throw new Error(`Image fit for ${id} must be contain or cover`);
        validImage.fit = element.fit;
      }
      if (element.threshold !== undefined) {
        if (!Number.isInteger(element.threshold) || element.threshold < 0 || element.threshold > 255) throw new Error(`Image threshold for ${id} must be from 0 to 255`);
        validImage.threshold = element.threshold;
      }
      if (element.dither !== undefined) {
        if (!["threshold", "none", "floydsteinberg", "atkinson"].includes(element.dither)) throw new Error(`Image dithering for ${id} is unsupported`);
        validImage.dither = element.dither;
      }

      if (element.rotation !== undefined) validImage.rotation = element.rotation;
      if (element.scale !== undefined) validImage.scale = element.scale;
      if (element.threshold !== undefined) validImage.threshold = element.threshold;
      if (element.dither !== undefined) validImage.dither = element.dither;
      if (element.invert !== undefined) validImage.invert = element.invert;
      if (element.crop !== undefined) validImage.crop = element.crop;
      if (element.icon !== undefined) validImage.icon = element.icon;
      if (element.source !== undefined) {
        if (typeof element.source !== "string" || element.source.length > 200) throw new Error(`Image source name for ${id} is invalid`);
        validImage.source = element.source;
      }
      if (element.rawImage !== undefined) {
        const raw = element.rawImage;
        if (!raw || typeof raw !== "object" || Object.keys(raw).some(key => !["width", "height", "rgba"].includes(key)) ||
            !Number.isInteger(raw.width) || !Number.isInteger(raw.height) || raw.width < 1 || raw.width > 128 || raw.height < 1 || raw.height > 64 ||
            typeof raw.rgba !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.rgba) || raw.rgba.length > 44000 ||
            raw.rgba.length !== Math.ceil(raw.width * raw.height * 4 / 3) * 4) {
          throw new Error(`Original image data for ${id} is invalid`);
        }
        validImage.rawImage = { width: raw.width, height: raw.height, rgba: raw.rgba };
      }

      return validImage;
    }

    // Text / widget element
    const { size, alignment, binding, text } = element;
    if (size !== 1 && size !== 2) throw new Error(`Font size for ${id} must be 1 or 2`);
    if (!ALIGNMENTS.has(alignment) || !BINDINGS.has(binding)) throw new Error(`Unsupported rendering option for ${id}`);
    if (typeof text !== "string" || text.length > 21 || /[^\x20-\x7e]/.test(text) || /[\r\n]/.test(text)) {
      throw new Error(`Text for ${id} must be at most 21 printable ASCII characters`);
    }

    if (binding === "KEYGRID") {
      if (size !== 1 || mode !== "NORMAL" || alignment !== "LEFT" || x + 62 > SCREEN_WIDTH || y + 62 > SCREEN_HEIGHT) {
        throw new Error(`Key grid for ${id} must fit its fixed 62×62 monochrome widget`);
      }
      return { id, x, y, size, mode, alignment, binding, text, ...(element.visible === false ? { visible: false } : {}) };
    }

    const shownText = binding === "STATIC" ? text : binding === "HOST" ? "Omarchy" : binding === "HID" ? "HID OFF" : text || "WWWWWWWW";
    const width = shownText.length * 6 * size;
    const left = alignment === "CENTER" ? x - Math.floor(width / 2) : alignment === "RIGHT" ? x - width : x;
    if (left < 0 || left + width > SCREEN_WIDTH || y + 8 * size > SCREEN_HEIGHT) {
      throw new Error(`Text for ${id} does not fit on the 128×64 display`);
    }

    const result = { id, x, y, size, mode, alignment, binding, text };
    if (element.type) result.type = element.type;
    if (element.visible === false) result.visible = false;
    return result;
  });
}

function validateScreenEvent(input, eventId) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`OLED event ${eventId} is invalid`);
  if (Object.keys(input).some(key => key !== "elements")) throw new Error(`OLED event ${eventId} contains an unsupported property`);
  return { elements: validateElements(input.elements, { maxBitmapBytes: MAX_EVENT_BITMAP_PER_DESIGN }) };
}

function validateScreenPageEvents(input, pageLabel, bitmapBudget) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${pageLabel} event screens must be an object`);
  const events = {};
  for (const [eventId, eventDesign] of Object.entries(input)) {
    if (!SCREEN_EVENT_SET.has(eventId)) throw new Error(`${pageLabel} contains an unknown OLED event: ${eventId}`);
    const valid = validateScreenEvent(eventDesign, eventId);
    for (const element of valid.elements) {
      if (element.binding === "BITMAP") {
        bitmapBudget.used += Math.ceil(element.width / 8) * element.height;
        if (bitmapBudget.used > MAX_EVENT_BITMAP_BYTES) {
          throw new Error(`Total OLED event bitmap memory exceeds ${MAX_EVENT_BITMAP_BYTES} bytes`);
        }
      }
    }
    events[eventId] = valid;
  }
  return events;
}

function validateEventOptions(input) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("OLED event options must be an object");
  if (Object.keys(input).some(key => !["duration", "trigger"].includes(key))) throw new Error("OLED event options contain an unsupported property");
  const duration = input.duration ?? DEFAULT_EVENT_OPTIONS.duration;
  const trigger = input.trigger ?? DEFAULT_EVENT_OPTIONS.trigger;
  if (!EVENT_DURATIONS.has(duration)) throw new Error("OLED event duration must be 500, 1000, 1500, 2000, 3000, STICKY, or HOLD");
  if (!EVENT_TRIGGERS.has(trigger)) throw new Error("OLED event trigger must be PRESS or RELEASE");
  return { duration, trigger };
}

function validateScreenPage(input, index = 0, bitmapBudget = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`OLED page ${index + 1} is invalid`);
  if (Object.keys(input).some(key => !["id", "name", "elements", "events"].includes(key))) throw new Error(`OLED page ${index + 1} contains an unsupported property`);
  const id = input.id ?? `screen-page-${index + 1}`;
  const name = input.name ?? `Page ${index + 1}`;
  if (typeof id !== "string" || !/^[a-z0-9-]{1,24}$/i.test(id)) throw new Error(`Page ${index + 1} has an invalid ID`);
  if (typeof name !== "string" || name.length < 1 || name.length > 20 || /[^\x20-\x7e]/.test(name)) throw new Error(`Page ${index + 1} name must be 1–20 printable ASCII characters`);
  const page = { id, name, elements: validateElements(input.elements) };
  const events = validateScreenPageEvents(input.events, `Page ${index + 1}`, bitmapBudget || { used: 0 });
  if (events !== undefined) page.events = events;
  return page;
}

function validateScreenDesign(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Screen design must be an object");
  if (input.version === 1 && Array.isArray(input.elements)) {
    if (Object.keys(input).some(key => !["version", "elements"].includes(key))) throw new Error("Screen design contains an unsupported property");
    const migrated = validateScreenPage({ id: "screen-page-1", name: "Page 1", elements: input.elements });
    return { version: SCREEN_DESIGN_VERSION, pages: [migrated] };
  }
  if (input.version !== 1 && input.version !== 2 && input.version !== 3) {
    throw new Error(`Unsupported screen design version: ${input.version}`);
  }
  if (Object.keys(input).some(key => !["version", "pages", "eventOptions"].includes(key))) throw new Error("Screen design contains an unsupported property");
  if (!Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > MAX_SCREEN_PAGES) {
    throw new Error(`OLED designs must contain 1–${MAX_SCREEN_PAGES} pages`);
  }

  const ids = new Set();
  let totalScreenBitmapBytes = 0;
  const eventBitmapBudget = { used: 0 };

  const pages = input.pages.map((page, index) => {
    const valid = validateScreenPage(page, index, eventBitmapBudget);
    if (ids.has(valid.id)) throw new Error(`Duplicate OLED page ID: ${valid.id}`);
    ids.add(valid.id);

    for (const el of valid.elements) {
      if (el.binding === "BITMAP") {
        totalScreenBitmapBytes += Math.ceil(el.width / 8) * el.height;
      }
    }

    return valid;
  });

  if (totalScreenBitmapBytes > MAX_TOTAL_BITMAP_BYTES) {
    throw new Error(`Total OLED screen memory usage exceeds ${MAX_TOTAL_BITMAP_BYTES} bytes (requested ${totalScreenBitmapBytes} bytes)`);
  }

  const eventOptions = validateEventOptions(input.eventOptions);
  return { version: SCREEN_DESIGN_VERSION, pages, ...(eventOptions ? { eventOptions } : {}) };
}

function encodeText(text) {
  return text ? Array.from(text, char => char.charCodeAt(0).toString(16).padStart(2, "0")).join("") : "-";
}

function screenModeToken(element) {
  return element.visible === false ? `HIDDEN_${element.mode}` : element.mode;
}

function screenItemCommand(element, index) {
  const valid = validateElements([element])[0];
  const mode = screenModeToken(valid);
  if (valid.type === "shape") return `SCREEN ITEM ${index} ${valid.x} ${valid.y} ${valid.width} ${mode} ${valid.shape} ${valid.height}`;
  if (valid.binding === "BITMAP") {
    return `SCREEN ITEM ${index} ${valid.x} ${valid.y} ${valid.width} ${mode} BITMAP ${valid.height} ${valid.bitmap}`;
  }
  return `SCREEN ITEM ${index} ${valid.x} ${valid.y} ${valid.size} ${mode} ${valid.binding} ${valid.alignment} ${encodeText(valid.text)}`;
}

function buildScreenUploadCommands(input) {
  const design = validateScreenDesign(input);
  if (design.pages.length !== 1) throw new Error("Use buildScreenPagesUploadCommands for multi-page designs");
  return ["SCREEN BEGIN", "SCREEN CLEAR", ...design.pages[0].elements.map(screenItemCommand), "SCREEN VALIDATE", "SCREEN COMMIT"];
}

function buildScreenPagesUploadCommands(input) {
  const design = validateScreenDesign(input);
  const commands = ["SCREEN PAGES BEGIN", "SCREEN PAGES CLEAR"];
  design.pages.forEach((page, pageIndex) => {
    commands.push(`SCREEN PAGE ADD ${pageIndex} ${encodeText(page.name)}`);
    page.elements.forEach((element, elementIndex) => {
      const valid = validateElements([element])[0];
      if (valid.binding === "BITMAP") {
        commands.push(`SCREEN PAGE ITEM ${pageIndex} ${elementIndex} ${valid.x} ${valid.y} ${valid.width} ${screenModeToken(valid)} BITMAP ${valid.height} ${valid.bitmap}`);
      } else if (valid.type === "shape") {
        commands.push(`SCREEN PAGE ITEM ${pageIndex} ${elementIndex} ${valid.x} ${valid.y} ${valid.width} ${screenModeToken(valid)} ${valid.shape} ${valid.height}`);
      } else {
        commands.push(`SCREEN PAGE ITEM ${pageIndex} ${elementIndex} ${valid.x} ${valid.y} ${valid.size} ${screenModeToken(valid)} ${valid.binding} ${valid.alignment} ${encodeText(valid.text)}`);
      }
    });
  });
  commands.push("SCREEN PAGES VALIDATE", "SCREEN PAGES COMMIT");
  return commands;
}

function screenEventItemCommand(element, index) {
  const valid = validateElements([element])[0];
  const mode = screenModeToken(valid);
  if (valid.type === "shape") return `SCREEN EVENT ITEM ${index} ${valid.x} ${valid.y} ${valid.width} ${mode} ${valid.shape} ${valid.height}`;
  if (valid.binding === "BITMAP") {
    return `SCREEN EVENT ITEM ${index} ${valid.x} ${valid.y} ${valid.width} ${mode} BITMAP ${valid.height} ${valid.bitmap}`;
  }
  return `SCREEN EVENT ITEM ${index} ${valid.x} ${valid.y} ${valid.size} ${mode} ${valid.binding} ${valid.alignment} ${encodeText(valid.text)}`;
}

// Uploads the per-page event screens and the shared event timing options.
// Every event key present on a page is sent (even empty layouts) so the device
// state exactly matches the local design; absent keys leave firmware defaults.
function buildScreenEventsUploadCommands(input) {
  const design = validateScreenDesign(input);
  const options = design.eventOptions || DEFAULT_EVENT_OPTIONS;
  const commands = [
    "SCREEN EVENTS BEGIN",
    "SCREEN EVENTS CLEAR",
    `SCREEN EVENTS SETTINGS ${options.duration} ${options.trigger}`
  ];
  design.pages.forEach((page, pageIndex) => {
    for (const eventId of SCREEN_EVENT_IDS) {
      const event = page.events?.[eventId];
      if (!event) continue;
      commands.push(`SCREEN EVENT SELECT ${pageIndex} ${SCREEN_EVENT_PROTOCOL[eventId]}`);
      event.elements.forEach((element, elementIndex) => {
        commands.push(screenEventItemCommand(element, elementIndex));
      });
    }
  });
  commands.push("SCREEN EVENTS VALIDATE", "SCREEN EVENTS COMMIT");
  return commands;
}

function decodeText(value) {
  if (value === "-") return "";
  if (!/^(?:[0-9a-f]{2})*$/i.test(value)) throw new Error("Screen text encoding is invalid");
  const decoded = (value.match(/.{2}/g) || []).map(pair => String.fromCharCode(parseInt(pair, 16))).join("");
  if (/[^\x20-\x7e]/.test(decoded)) throw new Error("Screen text is not printable ASCII");
  return decoded;
}

function parseScreenItemLine(line, idPrefix = "device") {
  const modePattern = "(NORMAL|INVERSE|HIDDEN_NORMAL|HIDDEN_INVERSE)";
  const bitmapMatch = line.match(new RegExp(`^SCREEN (?:PAGE ITEM \\d+ |ITEM )(\\d+) (\\d+) (\\d+) (\\d+) ${modePattern} BITMAP (\\d+) ([0-9a-f]+)$`, "i"));
  if (bitmapMatch) {
    const [, index, x, y, width, mode, height, rawBitmap] = bitmapMatch;
    return {
      index: Number(index),
      element: {
        id: `${idPrefix}-${index}`,
        type: "image",
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height),
        mode: mode.replace(/^HIDDEN_/, "").toUpperCase(),
        ...(mode.toUpperCase().startsWith("HIDDEN_") ? { visible: false } : {}),
        binding: "BITMAP",
        bitmap: rawBitmap.toLowerCase()
      }
    };
  }

  const shapeMatch = line.match(new RegExp(`^SCREEN (?:PAGE ITEM \\d+ |ITEM )(\\d+) (\\d+) (\\d+) (\\d+) ${modePattern} (RECT|FILL_RECT|CIRCLE|FILL_CIRCLE|LINE) (\\d+)$`, "i"));
  if (shapeMatch) {
    const [, index, x, y, width, rawMode, shape, height] = shapeMatch;
    return { index: Number(index), element: { id: `${idPrefix}-${index}`, type: "shape", shape: shape.toUpperCase(), x: Number(x), y: Number(y), width: Number(width), height: Number(height), mode: rawMode.replace(/^HIDDEN_/, "").toUpperCase(), ...(rawMode.toUpperCase().startsWith("HIDDEN_") ? { visible: false } : {}) } };
  }

  const textMatch = line.match(new RegExp(`^SCREEN (?:PAGE ITEM \\d+ |ITEM )(\\d+) (\\d+) (\\d+) ([12]) ${modePattern} (STATIC|HOST|LAST|ENCODER|HID|KEYGRID) (LEFT|CENTER|RIGHT) ([0-9a-f]*|\\-)$`, "i"));
  if (textMatch) {
    const [, index, x, y, size, mode, binding, alignment, rawText] = textMatch;
    return {
      index: Number(index),
      element: {
        id: `${idPrefix}-${index}`,
        x: Number(x),
        y: Number(y),
        size: Number(size),
        mode: mode.replace(/^HIDDEN_/, "").toUpperCase(),
        ...(mode.toUpperCase().startsWith("HIDDEN_") ? { visible: false } : {}),
        binding: binding.toUpperCase(),
        alignment: alignment.toUpperCase(),
        text: decodeText(rawText)
      }
    };
  }
  return null;
}

function parseScreenGet(lines) {
  if (lines.some(raw => ["SCREEN LEGACY", "ERR unknown command"].includes(String(raw).trim()))) return { supported: false, design: null };
  const elements = [];
  for (const raw of lines) {
    const parsed = parseScreenItemLine(String(raw).trim());
    if (parsed) elements[parsed.index] = parsed.element;
  }
  return { supported: true, design: validateScreenDesign({ version: SCREEN_DESIGN_VERSION, pages: [{ id: "screen-page-1", name: "Page 1", elements: elements.filter(Boolean) }] }) };
}

function parseScreenPagesGet(lines) {
  const normalized = lines.map(raw => String(raw).trim());
  if (normalized.some(line => ["ERR unknown command", "ERR unknown SCREEN command"].includes(line))) return { supported: false, design: null };
  const countLine = normalized.find(line => /^SCREEN PAGES \d+$/.test(line));
  if (!countLine) return { supported: false, design: null };
  const pageCount = Number(countLine.split(" ")[2]);
  const currentLine = normalized.find(line => /^SCREEN CURRENT \d+$/.test(line));
  const currentPageNumber = currentLine ? Number(currentLine.split(" ")[2]) : 0;
  const pages = [];
  let currentPage = null;
  for (const line of normalized) {
    const pageMatch = line.match(/^SCREEN PAGE (\d+) ([0-9a-f]*|-)$/i);
    if (pageMatch) {
      currentPage = Number(pageMatch[1]);
      pages[currentPage] = { id: `device-page-${currentPage + 1}`, name: decodeText(pageMatch[2]), elements: [] };
      continue;
    }
    if (line === "SCREEN PAGE END") { currentPage = null; continue; }
    if (currentPage !== null) {
      const item = parseScreenItemLine(line, `device-p${currentPage + 1}-item`);
      if (item) pages[currentPage].elements[item.index] = item.element;
    }
  }
  if (pageCount < 1 || pageCount > MAX_SCREEN_PAGES || currentPageNumber >= pageCount || pages.filter(Boolean).length !== pageCount) throw new Error("Device returned an invalid OLED page list");
  return { supported: true, multiPageSupported: true, currentPage: currentPageNumber, design: validateScreenDesign({ version: SCREEN_DESIGN_VERSION, pages: pages.map(page => ({ ...page, elements: page.elements.filter(Boolean) })) }) };
}

function parseCurrentScreenPage(lines) {
  const match = lines.map(raw => String(raw).trim()).map(line => line.match(/^SCREEN CURRENT (\d+)$/)).find(Boolean);
  if (!match) throw new Error("Device did not report the current OLED page");
  return Number(match[1]);
}

// Parses `SCREEN EVENTS GET` output:
//   SCREEN EVENTS <duration> <trigger>
//   SCREEN EVENT <page> <TOKEN> <count>
//   SCREEN ITEM <index> ...            (same rows as page dumps)
//   SCREEN EVENT END
//   ...
//   SCREEN EVENTS END
function parseScreenEventsGet(lines) {
  const normalized = lines.map(raw => String(raw).trim());
  if (normalized.some(line => line.startsWith("ERR"))) return { supported: false, eventOptions: null, events: null };
  const header = normalized.map(line => line.match(/^SCREEN EVENTS (500|1000|1500|2000|3000|STICKY|HOLD) (PRESS|RELEASE)$/)).find(Boolean);
  if (!header) return { supported: false, eventOptions: null, events: null };
  const eventOptions = { duration: header[1], trigger: header[2] };

  const events = {};
  let currentPage = null;
  let currentEvent = null;
  let currentItems = [];
  const finishBlock = () => {
    if (currentPage === null || currentEvent === null) return;
    const elements = [];
    for (const item of currentItems) elements[item.index] = item.element;
    if (!events[currentPage]) events[currentPage] = {};
    events[currentPage][currentEvent] = { elements: elements.filter(Boolean) };
    currentPage = null;
    currentEvent = null;
    currentItems = [];
  };

  for (const line of normalized) {
    const blockMatch = line.match(/^SCREEN EVENT (\d+) (IDLE|SW[1-9]|ENCW|ENCCW|ENCP) (\d+)$/);
    if (blockMatch) {
      finishBlock();
      currentPage = Number(blockMatch[1]);
      currentEvent = PROTOCOL_SCREEN_EVENTS[blockMatch[2]];
      continue;
    }
    if (line === "SCREEN EVENT END") { finishBlock(); continue; }
    if (line === "SCREEN EVENTS END") break;
    if (currentPage !== null) {
      const item = parseScreenItemLine(line, `device-p${currentPage + 1}-ev`);
      if (item) currentItems[item.index] = item;
    }
  }
  finishBlock();
  return { supported: true, eventOptions, events };
}

function nextScreenPageIndex(currentPage, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_SCREEN_PAGES) throw new Error("OLED page count is invalid");
  if (!Number.isInteger(currentPage) || currentPage < 0 || currentPage >= pageCount) throw new Error("Current OLED page is invalid");
  return (currentPage + 1) % pageCount;
}

module.exports = {
  SCREEN_WIDTH, SCREEN_HEIGHT, SCREEN_DESIGN_VERSION, MAX_SCREEN_ELEMENTS, MAX_SCREEN_PAGES,
  MAX_PAGE_BITMAP_BYTES, MAX_TOTAL_BITMAP_BYTES, MAX_EVENT_BITMAP_BYTES, MAX_IMAGE_ELEMENTS_PER_PAGE,
  SCREEN_EVENT_IDS, SCREEN_EVENT_SET, SCREEN_EVENT_LABELS, SCREEN_EVENT_PROTOCOL, PROTOCOL_SCREEN_EVENTS,
  EVENT_DURATIONS, EVENT_TRIGGERS, DEFAULT_EVENT_OPTIONS,
  createDefaultScreenPage, createDefaultScreenDesign, validateScreenPage, validateScreenDesign,
  screenItemCommand, buildScreenUploadCommands, buildScreenPagesUploadCommands,
  buildScreenEventsUploadCommands, screenEventItemCommand,
  parseScreenGet, parseScreenPagesGet, parseScreenEventsGet, parseCurrentScreenPage, nextScreenPageIndex
};
