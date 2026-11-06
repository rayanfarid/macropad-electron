const { BUTTON_SLOTS } = require("./serial-protocol");

const GRID_SIZE = 3;

function createDefaultLayout() {
  const positions = {};
  BUTTON_SLOTS.forEach((slot, index) => {
    positions[slot] = { row: Math.floor(index / GRID_SIZE), column: index % GRID_SIZE, rowSpan: 1, columnSpan: 1 };
  });
  return { rows: GRID_SIZE, columns: GRID_SIZE, positions };
}

function validateLayout(layout) {
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) throw new Error("Layout must be an object");
  if (layout.rows !== GRID_SIZE || layout.columns !== GRID_SIZE) throw new Error("Layout grid must be 3×3");
  if (!layout.positions || typeof layout.positions !== "object" || Array.isArray(layout.positions)) throw new Error("Layout positions are required");
  const expected = new Set(BUTTON_SLOTS);
  if (Object.keys(layout.positions).length !== expected.size || Object.keys(layout.positions).some(slot => !expected.has(slot))) {
    throw new Error("Layout must contain every physical and encoder slot exactly once");
  }

  const occupied = new Set();
  for (const [slot, position] of Object.entries(layout.positions)) {
    if (!position || typeof position !== "object") throw new Error(`Position for ${slot} is invalid`);
    const { row, column, rowSpan = 1, columnSpan = 1 } = position;
    for (const [key, value] of Object.entries({ row, column, rowSpan, columnSpan })) {
      if (!Number.isInteger(value)) throw new Error(`${key} for ${slot} must be an integer`);
    }
    if (row < 0 || column < 0 || rowSpan < 1 || columnSpan < 1 || row + rowSpan > GRID_SIZE || column + columnSpan > GRID_SIZE) {
      throw new Error(`Position for ${slot} is outside the 3×3 layout`);
    }
    for (let r = row; r < row + rowSpan; r++) {
      for (let c = column; c < column + columnSpan; c++) {
        const cell = `${r}:${c}`;
        if (occupied.has(cell)) throw new Error(`Layout positions overlap at ${cell}`);
        occupied.add(cell);
      }
    }
  }

  return {
    rows: GRID_SIZE,
    columns: GRID_SIZE,
    positions: Object.fromEntries(Object.entries(layout.positions).map(([slot, p]) => [slot, {
      row: p.row,
      column: p.column,
      rowSpan: p.rowSpan ?? 1,
      columnSpan: p.columnSpan ?? 1
    }]))
  };
}

function swapLayoutSlots(layout, firstSlot, secondSlot) {
  const current = validateLayout(layout);
  if (!current.positions[firstSlot] || !current.positions[secondSlot]) throw new Error("Unknown physical slot");
  if (firstSlot === secondSlot) return current;
  const a = current.positions[firstSlot];
  const b = current.positions[secondSlot];
  current.positions[firstSlot] = { ...a, row: b.row, column: b.column };
  current.positions[secondSlot] = { ...b, row: a.row, column: a.column };
  return validateLayout(current);
}

function resizeLayoutSlot(layout, slot, rowSpan, columnSpan) {
  const current = validateLayout(layout);
  if (!current.positions[slot]) throw new Error(`Unknown physical slot: ${slot}`);
  current.positions[slot] = { ...current.positions[slot], rowSpan, columnSpan };
  return validateLayout(current);
}

module.exports = { GRID_SIZE, createDefaultLayout, validateLayout, swapLayoutSlots, resizeLayoutSlot };
