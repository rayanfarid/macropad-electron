const test = require("node:test");
const assert = require("node:assert/strict");
const { createDefaultLayout, validateLayout, swapLayoutSlots, resizeLayoutSlot } = require("../layout");

test("default visual layout places all nine physical slots without overlap", () => {
  const layout = validateLayout(createDefaultLayout());
  assert.equal(Object.keys(layout.positions).length, 9);
  assert.deepEqual(layout.positions["1"], { row: 0, column: 0, rowSpan: 1, columnSpan: 1 });
  assert.deepEqual(layout.positions["9"], { row: 2, column: 2, rowSpan: 1, columnSpan: 1 });
});

test("drag swap moves visual positions without changing physical slot keys", () => {
  const layout = swapLayoutSlots(createDefaultLayout(), "1", "9");
  assert.deepEqual(layout.positions["1"], { row: 2, column: 2, rowSpan: 1, columnSpan: 1 });
  assert.deepEqual(layout.positions["9"], { row: 0, column: 0, rowSpan: 1, columnSpan: 1 });
  assert.deepEqual(Object.keys(layout.positions).sort(), ["1", "2", "3", "4", "5", "6", "7", "8", "9"].sort());
});

test("layout rejects overlaps and out-of-grid dimensions", () => {
  const overlapping = createDefaultLayout();
  overlapping.positions["2"].column = 0;
  assert.throws(() => validateLayout(overlapping), /overlap/);
  assert.throws(() => resizeLayoutSlot(createDefaultLayout(), "1", 2, 1), /overlap/);
  assert.throws(() => resizeLayoutSlot(createDefaultLayout(), "3", 1, 2), /outside/);
});

test("layout editor only accepts a physical button slot", () => {
  assert.throws(() => swapLayoutSlots(createDefaultLayout(), "1", "CW"), /Unknown physical slot/);
});
