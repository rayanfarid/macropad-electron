const test = require("node:test");
const assert = require("node:assert/strict");
const { createDefaultScreenDesign } = require("../screen-design");
const { SCREEN_AI_INSTRUCTIONS, parseAiDesignResponse } = require("../ai-design");

test("AI design response accepts and bounds a valid supported screen design", () => {
  const result = parseAiDesignResponse(JSON.stringify({
    explanation: "A compact monochrome layout.",
    notes: ["Uses the live key grid."],
    design: createDefaultScreenDesign()
  }));
  assert.equal(result.design.pages[0].elements[0].binding, "KEYGRID");
  assert.equal(result.explanation, "A compact monochrome layout.");
});

test("AI response rejects invented colors, fonts, and malformed JSON before applying", () => {
  const design = createDefaultScreenDesign();
  design.pages[0].elements[0].mode = "BLUE";
  assert.throws(() => parseAiDesignResponse(JSON.stringify({ explanation: "Unsupported", notes: [], design })), /Unsupported rendering option/);
  const unsupported = createDefaultScreenDesign();
  unsupported.pages[0].elements[0].color = "blue";
  assert.throws(() => parseAiDesignResponse(JSON.stringify({ explanation: "Unsupported", notes: [], design: unsupported })), /unsupported property/);
  assert.throws(() => parseAiDesignResponse("not json"), /invalid JSON/);
  assert.throws(() => parseAiDesignResponse("x".repeat(16001)), /too large/);
});

test("AI instructions limit output to actual firmware capabilities and disclose absent system metrics", () => {
  assert.match(SCREEN_AI_INSTRUCTIONS, /128x64/);
  assert.match(SCREEN_AI_INSTRUCTIONS, /KEYGRID/);
  assert.match(SCREEN_AI_INSTRUCTIONS, /No CPU, RAM/);
  assert.match(SCREEN_AI_INSTRUCTIONS, /preserve the current design/);
  assert.match(SCREEN_AI_INSTRUCTIONS, /8 pages/);
  assert.match(SCREEN_AI_INSTRUCTIONS, /SW9/);
});

test("AI multi-page responses are validated before they can be applied", () => {
  const design = createDefaultScreenDesign();
  design.pages.push({
    id: "screen-page-2",
    name: "Page 2",
    elements: [{ id: "host-2", x: 4, y: 4, size: 1, mode: "NORMAL", alignment: "LEFT", binding: "HOST", text: "" }]
  });
  const result = parseAiDesignResponse(JSON.stringify({
    explanation: "Two pages for dashboard and host status.",
    notes: ["SW9 advances pages on-device."],
    design
  }));
  assert.equal(result.design.pages.length, 2);
  assert.equal(result.design.pages[1].name, "Page 2");
});
