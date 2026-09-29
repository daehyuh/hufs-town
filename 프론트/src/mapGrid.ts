/**
 * Map coordinates use tile units: one map unit is one logical tile. Grid
 * subdivisions describe editor and navigation precision; avatars still move
 * through continuous coordinates between cells.
 */
export const MAP_UNITS_PER_TILE = 1;

export const COLLISION_CELLS_PER_TILE = 1;
export const COLLISION_CELL_SIZE =
  MAP_UNITS_PER_TILE / COLLISION_CELLS_PER_TILE;

export const EDITOR_CELLS_PER_TILE = 2;
export const EDITOR_GRID_STEP = MAP_UNITS_PER_TILE / EDITOR_CELLS_PER_TILE;

export const FLOOR_CELLS_PER_TILE = EDITOR_CELLS_PER_TILE;
export const FLOOR_GRID_STEP = MAP_UNITS_PER_TILE / FLOOR_CELLS_PER_TILE;

export const NAVIGATION_CELLS_PER_TILE = 4;
export const NAVIGATION_GRID_STEP =
  MAP_UNITS_PER_TILE / NAVIGATION_CELLS_PER_TILE;

export function gridCellCount(mapUnits: number, cellsPerTile: number) {
  return Math.round(mapUnits * cellsPerTile);
}

export function mapCoordinateToCell(value: number, cellsPerTile: number) {
  return Math.floor(value * cellsPerTile);
}

export function mapCoordinateToNearestCell(
  value: number,
  cellsPerTile: number,
) {
  return Math.round(value * cellsPerTile - 0.5);
}

export function gridCellCenterToMapCoordinate(
  cell: number,
  cellsPerTile: number,
) {
  return (cell + 0.5) / cellsPerTile;
}
