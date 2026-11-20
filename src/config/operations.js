// Shared operation definitions for Solo Campaign (Operations 01-05) and 100-Player Mega-Basin.
// Adheres strictly to docs/INTERFACES.md §2 and docs/gamespec.md §3.

export const WATER_LEVEL = 12.0;

export const OPERATIONS = [
  {
    id: 'op01',
    index: 1,
    total: 5,
    name: 'Cinderpine Basin',
    subtitle: 'Scoop the lake. Drop on the fire head.',
    mode: 'solo',
    seed: 10107,
    gridSize: 128,
    cellSize: 16,
    windDirDeg: 90,
    windSpeedKt: 12,
    windGustKt: 14,
    cabinCount: 10,
    towerCount: 1,
    layoutType: 'cinderpine',
  },
  {
    id: 'op02',
    index: 2,
    total: 5,
    name: 'Redridge Narrows',
    subtitle: 'Split twin fronts converging on the pine peninsula.',
    mode: 'solo',
    seed: 20219,
    gridSize: 128,
    cellSize: 16,
    windDirDeg: 45,
    windSpeedKt: 16,
    windGustKt: 18,
    cabinCount: 12,
    towerCount: 1,
    layoutType: 'redridge',
  },
  {
    id: 'op03',
    index: 3,
    total: 5,
    name: 'Ashen Caldera',
    subtitle: 'Defend three rim settlements from the crater lake.',
    mode: 'solo',
    seed: 30331,
    gridSize: 128,
    cellSize: 16,
    windDirDeg: 225,
    windSpeedKt: 18,
    windGustKt: 22,
    cabinCount: 15,
    towerCount: 1,
    layoutType: 'caldera',
  },
  {
    id: 'op04',
    index: 4,
    total: 5,
    name: 'Timberline Gorge',
    subtitle: 'Track the S-curve river and douse canyon spot fires.',
    mode: 'solo',
    seed: 40447,
    gridSize: 128,
    cellSize: 16,
    windDirDeg: 112,
    windSpeedKt: 20,
    windGustKt: 24,
    cabinCount: 14,
    towerCount: 1,
    layoutType: 'gorge',
  },
  {
    id: 'op05',
    index: 5,
    total: 5,
    name: 'Ember Crown Peak',
    subtitle: 'Break dual ridgeline mega-fronts under gale-force gusts.',
    mode: 'solo',
    seed: 50563,
    gridSize: 128,
    cellSize: 16,
    windDirDeg: 295,
    windSpeedKt: 22,
    windGustKt: 26,
    cabinCount: 18,
    towerCount: 2,
    layoutType: 'crown',
  },
];

export const MEGA_BASIN_OP = {
  id: 'megabasin',
  index: 1,
  total: 1,
  name: 'Cascadia Mega-Basin',
  subtitle: '100-pilot cooperative basin defense. Hold all four stations.',
  mode: 'megabasin',
  seed: 90901,
  gridSize: 160,
  cellSize: 20,
  windDirDeg: 75,
  windSpeedKt: 14,
  windGustKt: 18,
  cabinCount: 44,
  towerCount: 4,
  layoutType: 'megabasin',
};

/**
 * Look up an operation config by id ('op01'..'op05' or 'megabasin').
 * Falls back to Operations 01 (Cinderpine Basin) if unrecognized.
 */
export function getOperationById(id) {
  if (id === MEGA_BASIN_OP.id) return MEGA_BASIN_OP;
  return OPERATIONS.find((op) => op.id === id) ?? OPERATIONS[0];
}
