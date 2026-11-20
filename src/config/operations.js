// Shared live mission definitions for EMBER FRONT (Operations 01-05, scaling 1..100 pilots).
// Starts on focused Operation 01: Cinderpine Basin and rolls smoothly 01 -> 05 -> 01 on containment.
// MEGA_BASIN_OP is retained for backward compatibility with loopback stress tests.

export const WATER_LEVEL = 12.0;
export const DEFAULT_OPERATION_ID = 'op01';

export const OPERATIONS = [
  {
    id: 'op01',
    opIndex: 0,
    index: 1,
    total: 5,
    name: 'Cinderpine Basin',
    subtitle: 'Skim Cinderpine Lake. Cut off the eastern fire head.',
    mode: 'coop',
    maxPilots: 100,
    seed: 10107,
    gridSize: 128,
    cellSize: 16,
    windDirDeg: 90,
    windSpeedKt: 11,
    windGustKt: 13,
    cabinCount: 10,
    towerCount: 1,
    layoutType: 'cinderpine',
  },
  {
    id: 'op02',
    opIndex: 1,
    index: 2,
    total: 5,
    name: 'Redridge Narrows',
    subtitle: 'Split twin fronts converging on the pine peninsula.',
    mode: 'coop',
    maxPilots: 100,
    seed: 20219,
    gridSize: 128,
    cellSize: 16,
    windDirDeg: 45,
    windSpeedKt: 12,
    windGustKt: 15,
    cabinCount: 12,
    towerCount: 1,
    layoutType: 'redridge',
  },
  {
    id: 'op03',
    opIndex: 2,
    index: 3,
    total: 5,
    name: 'Ashen Caldera',
    subtitle: 'Defend three rim settlements from the crater lake.',
    mode: 'coop',
    maxPilots: 100,
    seed: 30331,
    gridSize: 128,
    cellSize: 16,
    windDirDeg: 225,
    windSpeedKt: 14,
    windGustKt: 17,
    cabinCount: 15,
    towerCount: 1,
    layoutType: 'caldera',
  },
  {
    id: 'op04',
    opIndex: 3,
    index: 4,
    total: 5,
    name: 'Timberline Gorge',
    subtitle: 'Track the S-curve river and douse canyon spot fires.',
    mode: 'coop',
    maxPilots: 100,
    seed: 40447,
    gridSize: 128,
    cellSize: 16,
    windDirDeg: 112,
    windSpeedKt: 15,
    windGustKt: 19,
    cabinCount: 14,
    towerCount: 1,
    layoutType: 'gorge',
  },
  {
    id: 'op05',
    opIndex: 4,
    index: 5,
    total: 5,
    name: 'Ember Crown Peak',
    subtitle: 'Break dual ridgeline fronts under gusty mountain winds.',
    mode: 'coop',
    maxPilots: 100,
    seed: 50563,
    gridSize: 128,
    cellSize: 16,
    windDirDeg: 295,
    windSpeedKt: 17,
    windGustKt: 21,
    cabinCount: 18,
    towerCount: 2,
    layoutType: 'crown',
  },
];

export const DEFAULT_OPERATION = OPERATIONS[0];

export const MEGA_BASIN_OP = {
  id: 'megabasin',
  opIndex: 0,
  index: 1,
  total: 1,
  name: 'Cascadia Mega-Basin',
  subtitle: '100-pilot cooperative basin defense. Hold all four stations.',
  mode: 'megabasin',
  maxPilots: 100,
  seed: 90901,
  gridSize: 160,
  cellSize: 20,
  windDirDeg: 75,
  windSpeedKt: 13,
  windGustKt: 16,
  cabinCount: 44,
  towerCount: 4,
  layoutType: 'megabasin',
};

/**
 * Look up an operation config by id ('op01'..'op05' or 'megabasin').
 * Falls back to Operation 01 (Cinderpine Basin) if unrecognized.
 */
export function getOperationById(id) {
  if (id === MEGA_BASIN_OP.id) return MEGA_BASIN_OP;
  return OPERATIONS.find((op) => op.id === id) ?? OPERATIONS[0];
}

/**
 * Look up a live operation by 0-based index (wrapping cleanly 0..4).
 */
export function getOperationByIndex(opIndex) {
  const n = OPERATIONS.length;
  const idx = Number.isFinite(opIndex) ? ((Math.floor(opIndex) % n) + n) % n : 0;
  return OPERATIONS[idx];
}

/**
 * Return the next operation in the 01 -> 05 -> 01 live mission rotation.
 */
export function getNextOperation(current) {
  if (typeof current === 'number') {
    return getOperationByIndex(current + 1);
  }
  if (typeof current === 'string') {
    const idx = OPERATIONS.findIndex((op) => op.id === current);
    return getOperationByIndex((idx >= 0 ? idx : 0) + 1);
  }
  if (current && typeof current === 'object') {
    if (typeof current.opIndex === 'number') {
      return getOperationByIndex(current.opIndex + 1);
    }
    const idx = OPERATIONS.findIndex((op) => op.id === current.id);
    return getOperationByIndex((idx >= 0 ? idx : 0) + 1);
  }
  return OPERATIONS[1];
}
