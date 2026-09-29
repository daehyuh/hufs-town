import { describe, expect, it } from "vitest";
import {
  COLLISION_CELL_SIZE,
  EDITOR_GRID_STEP as SHARED_EDITOR_GRID_STEP,
  FLOOR_GRID_STEP,
  NAVIGATION_GRID_STEP,
  gridCellCenterToMapCoordinate,
  gridCellCount,
  mapCoordinateToCell,
  mapCoordinateToNearestCell,
} from "../../src/mapGrid";
import { EDITOR_GRID_STEP, snapCoordinate } from "../../src/editor/grid";

describe("map editor grid", () => {
  it("snaps pointer coordinates to half-tile increments", () => {
    expect(EDITOR_GRID_STEP).toBe(0.5);
    expect(snapCoordinate(3.24, true)).toBe(3);
    expect(snapCoordinate(3.26, true)).toBe(3.5);
  });

  it("preserves the exact pointer coordinate when snap is disabled", () => {
    expect(snapCoordinate(3.247, false)).toBe(3.247);
  });

  it("keeps editor, floor, collision, and pathfinding precision on one tile unit", () => {
    expect(EDITOR_GRID_STEP).toBe(SHARED_EDITOR_GRID_STEP);
    expect(FLOOR_GRID_STEP).toBe(EDITOR_GRID_STEP);
    expect(COLLISION_CELL_SIZE).toBe(1);
    expect(NAVIGATION_GRID_STEP * 2).toBe(EDITOR_GRID_STEP);
    expect(gridCellCount(16, 2)).toBe(32);
    expect(mapCoordinateToCell(3.26, 2)).toBe(6);
    expect(gridCellCenterToMapCoordinate(6, 2)).toBe(3.25);
    expect(mapCoordinateToNearestCell(3.26, 4)).toBe(13);
  });
});
