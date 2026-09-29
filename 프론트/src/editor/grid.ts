import { EDITOR_GRID_STEP } from "../mapGrid";

export { EDITOR_GRID_STEP } from "../mapGrid";

export function snapCoordinate(value: number, enabled: boolean) {
  return enabled
    ? Math.round(value / EDITOR_GRID_STEP) * EDITOR_GRID_STEP
    : value;
}
