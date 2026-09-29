import type { MapDefinition } from "../generated/protocol";
import {
  COLLISION_CELLS_PER_TILE,
  gridCellCount,
  mapCoordinateToCell,
} from "../mapGrid";
export const RADIUS = 0.22;
export type FacingDirection = "down" | "up" | "left" | "right";

const MAX_GRID_REFERENCES = 200_000;

/**
 * A one-tile spatial index for collision rectangles. Avatar coordinates stay
 * continuous; this only narrows which rectangles need an exact collision test.
 */
export type MovementCollisionGrid = {
  map: MapDefinition;
  columns: number;
  buckets: Map<number, number[]> | null;
};

export function buildMovementCollisionGrid(
  map: MapDefinition,
): MovementCollisionGrid {
  const buckets = new Map<number, number[]>();
  const columns = gridCellCount(map.width, COLLISION_CELLS_PER_TILE);
  const rows = gridCellCount(map.height, COLLISION_CELLS_PER_TILE);
  let references = 0;

  for (let index = 0; index < map.collisions.length; index++) {
    const rect = map.collisions[index];
    const minX = Math.max(
      0,
      mapCoordinateToCell(rect.x - RADIUS, COLLISION_CELLS_PER_TILE),
    );
    const maxX = Math.min(
      columns - 1,
      mapCoordinateToCell(
        rect.x + rect.width + RADIUS,
        COLLISION_CELLS_PER_TILE,
      ),
    );
    const minY = Math.max(
      0,
      mapCoordinateToCell(rect.y - RADIUS, COLLISION_CELLS_PER_TILE),
    );
    const maxY = Math.min(
      rows - 1,
      mapCoordinateToCell(
        rect.y + rect.height + RADIUS,
        COLLISION_CELLS_PER_TILE,
      ),
    );
    if (minX > maxX || minY > maxY) continue;

    const coveredTiles = (maxX - minX + 1) * (maxY - minY + 1);
    references += coveredTiles;
    if (references > MAX_GRID_REFERENCES)
      return { map, columns, buckets: null };

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const key = y * columns + x;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(index);
        else buckets.set(key, [index]);
      }
    }
  }

  return { map, columns, buckets };
}

/**
 * Choose the closest stable four-way sprite facing for a continuous movement
 * vector. Keep the current axis near diagonals so tiny input changes do not
 * make the avatar flicker between vertical and horizontal animations.
 */
export function movementFacingDirection(
  dx: number,
  dy: number,
  current: FacingDirection,
): FacingDirection {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (horizontal === 0 && vertical === 0) return current;

  const currentIsHorizontal = current === "left" || current === "right";
  const currentIsAligned =
    current === "right"
      ? dx > 0
      : current === "left"
        ? dx < 0
        : current === "down"
          ? dy > 0
          : dy < 0;
  const currentMagnitude = currentIsHorizontal ? horizontal : vertical;
  const otherMagnitude = currentIsHorizontal ? vertical : horizontal;
  if (currentIsAligned && currentMagnitude >= otherMagnitude * 0.82)
    return current;

  if (horizontal > vertical) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

export function canStand(
  map: MapDefinition,
  x: number,
  y: number,
  grid?: MovementCollisionGrid,
) {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < RADIUS ||
    y < RADIUS ||
    x > map.width - RADIUS ||
    y > map.height - RADIUS
  )
    return false;
  const candidates =
    grid?.map === map && grid.buckets
      ? (grid.buckets.get(
          mapCoordinateToCell(y, COLLISION_CELLS_PER_TILE) * grid.columns +
            mapCoordinateToCell(x, COLLISION_CELLS_PER_TILE),
        ) ?? [])
      : map.collisions.keys();
  for (const index of candidates) {
    const r = map.collisions[index];
    if (
      Math.hypot(
        x - Math.max(r.x, Math.min(x, r.x + r.width)),
        y - Math.max(r.y, Math.min(y, r.y + r.height)),
      ) < RADIUS
    )
      return false;
  }
  return true;
}
export function step(
  map: MapDefinition,
  x: number,
  y: number,
  dx: number,
  dy: number,
  running: boolean,
  seconds: number,
  grid?: MovementCollisionGrid,
) {
  const length = Math.hypot(dx, dy);
  if (!length) return { x, y };
  const distance = (running ? 5 : 3) * Math.max(0, Math.min(seconds, 0.05));
  const nx = x + (dx / length) * distance;
  const ny = y + (dy / length) * distance;
  // Preserve the requested diagonal when its destination clears the collider.
  // Resolving each axis first can turn a safe diagonal around a corner into a
  // visible horizontal/vertical zigzag.
  if (canStand(map, nx, ny, grid)) return { x: nx, y: ny };
  if (canStand(map, nx, y, grid)) x = nx;
  if (canStand(map, x, ny, grid)) y = ny;
  return { x, y };
}
