const { validateScreenDesign } = require("./screen-design");
const { getBuiltinIcon } = require("./icon-library");

const SCREEN_AI_INSTRUCTIONS = "You design pages for Macropad Studio's actual ESP32 OLED: 128x64, monochrome, Adafruit GFX classic ASCII font size 1 or 2, and optional 1-bit monochrome image/icon elements. Up to 8 pages and 8 elements per page. Supported bindings: STATIC, HOST, LAST, ENCODER, HID, KEYGRID, BITMAP. KEYGRID is fixed 62x62, size 1 NORMAL LEFT. Other text elements support LEFT/CENTER/RIGHT and NORMAL/INVERSE. HOST displays active OS; LAST last button label; ENCODER latest encoder action; HID displays HID OFF in safe mode. Supported image/icon elements: {id, type:'image', x, y, width, height, mode:'NORMAL'|'INVERSE', icon:'<name>', bitmap?:'<hex>'}. Prefer built-in icons for icons: paste, cut, undo, redo, select-all, close, chatgpt-ai, screenshot, copy, volume, play, pause, next, previous (built-in icons are 16x16). For custom icons, provide small monochrome 1-bit bitmap hex data (do not output huge image data). No CPU, RAM, network, volume, or sensor data. Interpret requests for multiple pages as separate designs in pages. SW9 page navigation is handled on-device when more than one page is uploaded. For help-only requests preserve the current design. Never claim unsupported features. Output ONLY JSON with explanation (string), notes (string array), design ({version:2,pages:[{id,name,elements:[{id,x,y,size,mode,alignment,binding,text}]}]}). Validate every position and text fits. Return a useful conservative design and explanation.";

function resolveAiIcons(design) {
  if (!design || !Array.isArray(design.pages)) return design;
  for (const page of design.pages) {
    if (!Array.isArray(page?.elements)) continue;
    for (const el of page.elements) {
      if ((el.type === "image" || el.binding === "BITMAP" || el.icon) && !el.bitmap && el.icon) {
        const builtin = getBuiltinIcon(el.icon);
        if (builtin) {
          el.type = "image";
          el.binding = "BITMAP";
          el.width = el.width || builtin.width;
          el.height = el.height || builtin.height;
          el.bitmap = builtin.bitmap;
        }
      }
    }
  }
  return design;
}

function parseAiDesignResponse(output) {
  if (typeof output !== "string" || output.length > 16000) throw new Error("AI response is missing or too large");
  let parsed;
  try { parsed = JSON.parse(output); }
  catch { throw new Error("AI returned invalid JSON; no design was applied"); }
  const design = validateScreenDesign(resolveAiIcons(parsed.design));
  if (typeof parsed.explanation !== "string" || !Array.isArray(parsed.notes) || parsed.notes.some(note => typeof note !== "string")) {
    throw new Error("AI response explanation was invalid");
  }
  return { design, explanation: parsed.explanation.slice(0, 1200), notes: parsed.notes.slice(0, 8).map(note => note.slice(0, 240)) };
}

module.exports = { SCREEN_AI_INSTRUCTIONS, parseAiDesignResponse };
