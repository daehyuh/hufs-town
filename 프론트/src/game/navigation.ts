import type { MapDefinition, Rect, Zone } from "../generated/protocol";
import {
  NAVIGATION_CELLS_PER_TILE,
  NAVIGATION_GRID_STEP,
  gridCellCenterToMapCoordinate,
  gridCellCount,
  mapCoordinateToNearestCell,
} from "../mapGrid";
import { buildMovementCollisionGrid, canStand } from "./movement";

// A quarter-tile grid gives the route enough room to follow diagonal hallways
// without the coarse half-tile staircase that used to show up around corners.
const GRID_STEP = NAVIGATION_GRID_STEP;
const EDGE_PROBES = 8;
// Treat heading churn as visible motion cost, not a negligible tie breaker.
// The line-of-sight and rounded-corner passes still keep obstacle clearance,
// while this favors routes with a steadier heading through nearly equal paths.
const TURN_COST = 0.22;
const PATH_DIRECTIONS = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
] as const;

type PathQueueItem = { state: number; cost: number; priority: number };

class PathQueue {
  private items: PathQueueItem[] = [];

  push(item: PathQueueItem) {
    let index = this.items.length;
    this.items.push(item);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= item.priority) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (!first || !last || this.items.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.items.length) break;
      const child =
        right < this.items.length &&
        this.items[right].priority < this.items[left].priority
          ? right
          : left;
      if (this.items[child].priority >= last.priority) break;
      this.items[index] = this.items[child];
      index = child;
    }
    this.items[index] = last;
    return first;
  }

  get length() {
    return this.items.length;
  }
}

function octileDistance(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
) {
  const dx = Math.abs(toX - fromX);
  const dy = Math.abs(toY - fromY);
  const diagonal = Math.min(dx, dy);
  return dx + dy + (Math.SQRT2 - 2) * diagonal;
}

function directionChange(from: number, to: number) {
  const difference = Math.abs(from - to);
  return Math.min(difference, PATH_DIRECTIONS.length - difference);
}

export type NavigationGraph = {
  columns: number;
  rows: number;
  walkable: Uint8Array;
  canStandAt: (x: number, y: number) => boolean;
};

export type NavigationField = {
  parent: Int32Array;
  stopAtBoundary: boolean;
};

export type NavigationPath = {
  points: Array<{ x: number; y: number }>;
  distance: number;
};

export type NavigationFollowTarget = {
  target: { x: number; y: number };
  segmentIndex: number;
  reached: boolean;
};

function cellCenter(cell: number) {
  return gridCellCenterToMapCoordinate(cell, NAVIGATION_CELLS_PER_TILE);
}

function nearestCell(position: number) {
  return mapCoordinateToNearestCell(position, NAVIGATION_CELLS_PER_TILE);
}

function inside(rect: Rect, x: number, y: number) {
  return (
    x >= rect.x &&
    x < rect.x + rect.width &&
    y >= rect.y &&
    y < rect.y + rect.height
  );
}

function rectDistance(rect: Rect, x: number, y: number) {
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width));
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function segmentIsClear(
  graph: NavigationGraph,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const probes = Math.max(1, Math.ceil(distance / 0.04));
  for (let probe = 0; probe <= probes; probe++) {
    const progress = probe / probes;
    if (
      !graph.canStandAt(
        from.x + (to.x - from.x) * progress,
        from.y + (to.y - from.y) * progress,
      )
    )
      return false;
  }
  return true;
}

function projectToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const progress = lengthSquared
    ? Math.max(
        0,
        Math.min(
          1,
          ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
        ),
      )
    : 0;
  const projected = { x: start.x + dx * progress, y: start.y + dy * progress };
  return {
    point: projected,
    progress,
    distanceSquared:
      (point.x - projected.x) ** 2 + (point.y - projected.y) ** 2,
  };
}

function pointAlongPath(
  points: Array<{ x: number; y: number }>,
  segmentIndex: number,
  progress: number,
  distance: number,
) {
  const segmentEnd = points[segmentIndex + 1];
  const segmentStart = points[segmentIndex];
  let current = {
    x: segmentStart.x + (segmentEnd.x - segmentStart.x) * progress,
    y: segmentStart.y + (segmentEnd.y - segmentStart.y) * progress,
  };
  let remaining = distance;
  for (let index = segmentIndex; index < points.length - 1; index++) {
    const end = points[index + 1];
    const length = Math.hypot(end.x - current.x, end.y - current.y);
    if (length >= remaining && length > 0) {
      const ratio = remaining / length;
      return {
        x: current.x + (end.x - current.x) * ratio,
        y: current.y + (end.y - current.y) * ratio,
      };
    }
    remaining -= length;
    current = end;
  }
  return points.at(-1)!;
}

/**
 * Follow a smoothed route by aiming a short, collision-safe distance ahead.
 * This avoids steering back and forth between the tiny samples used to draw a
 * rounded corner while keeping route progress monotonic across server ticks.
 */
export function navigationFollowTarget(
  graph: NavigationGraph,
  points: Array<{ x: number; y: number }>,
  position: { x: number; y: number },
  fromSegment = 0,
  // Keep enough distance ahead that the held movement vector changes as a
  // gradual steer instead of chasing every tiny rounded-path sample. Near an
  // obstacle the collision checks below automatically shorten this distance.
  // Aim beyond the current curve sample so the avatar commits to a broad,
  // readable arc instead of steering after each small waypoint.
  lookAhead = 0.68,
): NavigationFollowTarget | null {
  if (points.length < 2) return null;
  const lastSegment = points.length - 2;
  const firstSegment = Math.max(0, Math.min(fromSegment, lastSegment));
  // Rounded corners have many short samples. Searching too far ahead can make
  // the steering point jump across the bend from tick to tick.
  const searchEnd = Math.min(lastSegment, firstSegment + 3);
  let selectedSegment = firstSegment;
  let selectedProjection = projectToSegment(
    position,
    points[firstSegment],
    points[firstSegment + 1],
  );

  for (let index = firstSegment + 1; index <= searchEnd; index++) {
    const projection = projectToSegment(
      position,
      points[index],
      points[index + 1],
    );
    if (
      projection.distanceSquared + 0.0004 <
      selectedProjection.distanceSquared
    ) {
      selectedSegment = index;
      selectedProjection = projection;
    }
  }

  let remainingDistance = Math.hypot(
    points[selectedSegment + 1].x - selectedProjection.point.x,
    points[selectedSegment + 1].y - selectedProjection.point.y,
  );
  for (let index = selectedSegment + 1; index < points.length - 1; index++)
    remainingDistance += Math.hypot(
      points[index + 1].x - points[index].x,
      points[index + 1].y - points[index].y,
    );

  const goal = points.at(-1)!;
  if (Math.hypot(goal.x - position.x, goal.y - position.y) <= 0.14)
    return { target: goal, segmentIndex: lastSegment, reached: true };

  const desiredDistance = Math.min(lookAhead, remainingDistance);
  for (let distance = desiredDistance; distance >= 0; distance -= 0.04) {
    const target = pointAlongPath(
      points,
      selectedSegment,
      selectedProjection.progress,
      distance,
    );
    if (segmentIsClear(graph, position, target))
      return { target, segmentIndex: selectedSegment, reached: false };
  }

  const target = points[selectedSegment + 1];
  if (!segmentIsClear(graph, position, target)) return null;
  return { target, segmentIndex: selectedSegment, reached: false };
}

function smoothPath(
  graph: NavigationGraph,
  points: Array<{ x: number; y: number }>,
) {
  if (points.length < 3) return points;
  const smoothed = [points[0]];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let next = points.length - 1;
    while (
      next > anchor + 1 &&
      !segmentIsClear(graph, points[anchor], points[next])
    )
      next--;
    smoothed.push(points[next]);
    anchor = next;
  }
  return smoothed;
}

/**
 * Round visible-path corners so the click controller changes direction over a
 * short arc instead of snapping from one grid-aligned segment to the next.
 * Every generated segment is checked against the avatar's collision radius;
 * if a corner is too tight, keep the original safe waypoint.
 */
function roundPathCorners(
  graph: NavigationGraph,
  points: Array<{ x: number; y: number }>,
) {
  if (points.length < 3) return points;
  const rounded = [points[0]];
  const cornerRadius = 0.38;
  const maxSampleLength = 0.12;

  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    const incomingLength = Math.hypot(
      corner.x - previous.x,
      corner.y - previous.y,
    );
    const outgoingLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    if (incomingLength < 0.01 || outgoingLength < 0.01) continue;

    const incoming = {
      x: (corner.x - previous.x) / incomingLength,
      y: (corner.y - previous.y) / incomingLength,
    };
    const outgoing = {
      x: (next.x - corner.x) / outgoingLength,
      y: (next.y - corner.y) / outgoingLength,
    };
    const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
    if (dot > 0.985 || dot < -0.9) {
      rounded.push(corner);
      continue;
    }

    const radius = Math.min(
      cornerRadius,
      incomingLength * 0.4,
      outgoingLength * 0.4,
    );
    if (radius < 0.08) {
      rounded.push(corner);
      continue;
    }

    const entry = {
      x: corner.x - incoming.x * radius,
      y: corner.y - incoming.y * radius,
    };
    const exit = {
      x: corner.x + outgoing.x * radius,
      y: corner.y + outgoing.y * radius,
    };
    if (!segmentIsClear(graph, rounded.at(-1)!, entry)) {
      rounded.push(corner);
      continue;
    }

    const curveLength = radius * 2;
    const samples = Math.max(2, Math.ceil(curveLength / maxSampleLength));
    const curve: Array<{ x: number; y: number }> = [];
    let previousSample = entry;
    let isClear = true;
    for (let sample = 1; sample <= samples; sample++) {
      const progress = sample / samples;
      const inverse = 1 - progress;
      const point = {
        x:
          inverse * inverse * entry.x +
          2 * inverse * progress * corner.x +
          progress * progress * exit.x,
        y:
          inverse * inverse * entry.y +
          2 * inverse * progress * corner.y +
          progress * progress * exit.y,
      };
      if (
        !graph.canStandAt(point.x, point.y) ||
        !segmentIsClear(graph, previousSample, point)
      ) {
        isClear = false;
        break;
      }
      curve.push(point);
      previousSample = point;
    }

    if (isClear) rounded.push(...curve);
    else rounded.push(corner);
  }

  rounded.push(points.at(-1)!);
  return rounded;
}

export function buildNavigationGraph(
  map: MapDefinition,
  blockedZoneIds: ReadonlySet<string>,
): NavigationGraph {
  const columns = gridCellCount(map.width, NAVIGATION_CELLS_PER_TILE);
  const rows = gridCellCount(map.height, NAVIGATION_CELLS_PER_TILE);
  const collisionGrid = buildMovementCollisionGrid(map);

  const zoneBuckets = new Map<number, Zone[]>();
  for (const zone of map.zones) {
    const minX = Math.max(0, Math.floor(zone.bounds.x));
    const maxX = Math.min(
      map.width - 1,
      Math.floor(zone.bounds.x + zone.bounds.width),
    );
    const minY = Math.max(0, Math.floor(zone.bounds.y));
    const maxY = Math.min(
      map.height - 1,
      Math.floor(zone.bounds.y + zone.bounds.height),
    );
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const key = y * map.width + x;
        const bucket = zoneBuckets.get(key);
        if (bucket) bucket.push(zone);
        else zoneBuckets.set(key, [zone]);
      }
    }
  }

  const canStandAt = (x: number, y: number) => {
    if (!canStand(map, x, y, collisionGrid)) return false;

    const tileKey = Math.floor(y) * map.width + Math.floor(x);
    const zonesInTile = zoneBuckets.get(tileKey);
    if (
      zonesInTile?.some(
        (zone) => blockedZoneIds.has(zone.id) && inside(zone.bounds, x, y),
      )
    )
      return false;
    return true;
  };

  const walkable = new Uint8Array(columns * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const worldX = cellCenter(x);
      const worldY = cellCenter(y);
      if (canStandAt(worldX, worldY)) walkable[y * columns + x] = 1;
    }
  }
  return { columns, rows, walkable, canStandAt };
}

export function buildNavigationField(
  graph: NavigationGraph,
  zone: Zone,
  stopAtBoundary: boolean,
): NavigationField {
  const total = graph.columns * graph.rows;
  const parent = new Int32Array(total);
  parent.fill(-1);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  for (let y = 0; y < graph.rows; y++) {
    for (let x = 0; x < graph.columns; x++) {
      const index = y * graph.columns + x;
      if (!graph.walkable[index]) continue;
      const worldX = cellCenter(x);
      const worldY = cellCenter(y);
      const destination = stopAtBoundary
        ? !inside(zone.bounds, worldX, worldY) &&
          rectDistance(zone.bounds, worldX, worldY) <= GRID_STEP
        : inside(zone.bounds, worldX, worldY);
      if (!destination) continue;
      parent[index] = index;
      queue[tail++] = index;
    }
  }

  const deltas = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  while (head < tail) {
    const current = queue[head++];
    const x = current % graph.columns;
    const y = Math.floor(current / graph.columns);
    const worldX = cellCenter(x);
    const worldY = cellCenter(y);
    for (const [dx, dy] of deltas) {
      const nextX = x + dx;
      const nextY = y + dy;
      if (
        nextX < 0 ||
        nextY < 0 ||
        nextX >= graph.columns ||
        nextY >= graph.rows
      )
        continue;
      const next = nextY * graph.columns + nextX;
      if (parent[next] !== -1 || !graph.walkable[next]) continue;
      const nextWorldX = cellCenter(nextX);
      const nextWorldY = cellCenter(nextY);
      let edgeIsClear = true;
      for (let probe = 1; probe <= EDGE_PROBES; probe++) {
        const progress = probe / EDGE_PROBES;
        if (
          !graph.canStandAt(
            worldX + (nextWorldX - worldX) * progress,
            worldY + (nextWorldY - worldY) * progress,
          )
        ) {
          edgeIsClear = false;
          break;
        }
      }
      if (!edgeIsClear) continue;
      parent[next] = current;
      queue[tail++] = next;
    }
  }
  return { parent, stopAtBoundary };
}

export function navigationPathFrom(
  graph: NavigationGraph,
  field: NavigationField,
  x: number,
  y: number,
): NavigationPath | null {
  const centerX = nearestCell(x);
  const centerY = nearestCell(y);
  let start = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let offsetY = -2; offsetY <= 2; offsetY++) {
    for (let offsetX = -2; offsetX <= 2; offsetX++) {
      const cellX = centerX + offsetX;
      const cellY = centerY + offsetY;
      if (
        cellX < 0 ||
        cellY < 0 ||
        cellX >= graph.columns ||
        cellY >= graph.rows
      )
        continue;
      const index = cellY * graph.columns + cellX;
      if (!graph.walkable[index] || field.parent[index] < 0) continue;
      const pointX = cellCenter(cellX);
      const pointY = cellCenter(cellY);
      let connectionIsClear = graph.canStandAt(x, y);
      for (let probe = 1; connectionIsClear && probe <= EDGE_PROBES; probe++) {
        const progress = probe / EDGE_PROBES;
        if (
          !graph.canStandAt(
            x + (pointX - x) * progress,
            y + (pointY - y) * progress,
          )
        )
          connectionIsClear = false;
      }
      if (!connectionIsClear) continue;
      const distance = (pointX - x) ** 2 + (pointY - y) ** 2;
      if (distance < nearestDistance) {
        start = index;
        nearestDistance = distance;
      }
    }
  }
  if (start < 0) return null;

  const points = [{ x, y }];
  let cursor = start;
  const visited = new Set<number>();
  while (!visited.has(cursor)) {
    visited.add(cursor);
    const cellX = cursor % graph.columns;
    const cellY = Math.floor(cursor / graph.columns);
    const point = { x: cellCenter(cellX), y: cellCenter(cellY) };
    const previous = points.at(-1)!;
    if (Math.hypot(point.x - previous.x, point.y - previous.y) > 0.01)
      points.push(point);
    const next = field.parent[cursor];
    if (next < 0 || next === cursor) break;
    cursor = next;
  }

  const simplified: typeof points = [];
  for (const point of points) {
    while (simplified.length >= 2) {
      const first = simplified[simplified.length - 2];
      const middle = simplified[simplified.length - 1];
      const cross =
        (middle.x - first.x) * (point.y - middle.y) -
        (middle.y - first.y) * (point.x - middle.x);
      if (Math.abs(cross) > 0.001) break;
      simplified.pop();
    }
    simplified.push(point);
  }

  let distance = 0;
  for (let index = 1; index < simplified.length; index++) {
    distance += Math.hypot(
      simplified[index].x - simplified[index - 1].x,
      simplified[index].y - simplified[index - 1].y,
    );
  }
  return { points: simplified, distance };
}

/**
 * Build a short client-side route from the avatar to a clicked map position.
 * The server remains authoritative; this route only turns a click into the
 * same held dx/dy inputs used by keyboard movement.
 */
export function navigationPathTo(
  graph: NavigationGraph,
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
): NavigationPath | null {
  const startPoint = { x: startX, y: startY };
  const requestedTarget = { x: targetX, y: targetY };
  if (
    graph.canStandAt(startX, startY) &&
    graph.canStandAt(targetX, targetY) &&
    segmentIsClear(graph, startPoint, requestedTarget)
  ) {
    return {
      points: [startPoint, requestedTarget],
      distance: Math.hypot(targetX - startX, targetY - startY),
    };
  }

  const findCell = (x: number, y: number) => {
    const centerX = nearestCell(x);
    const centerY = nearestCell(y);
    let selected = -1;
    let distance = Number.POSITIVE_INFINITY;
    for (let offsetY = -5; offsetY <= 5; offsetY++) {
      for (let offsetX = -5; offsetX <= 5; offsetX++) {
        const cellX = centerX + offsetX;
        const cellY = centerY + offsetY;
        if (
          cellX < 0 ||
          cellY < 0 ||
          cellX >= graph.columns ||
          cellY >= graph.rows
        )
          continue;
        const index = cellY * graph.columns + cellX;
        if (!graph.walkable[index]) continue;
        const pointX = cellCenter(cellX);
        const pointY = cellCenter(cellY);
        if (
          x === startX &&
          y === startY &&
          !segmentIsClear(graph, { x, y }, { x: pointX, y: pointY })
        )
          continue;
        const nextDistance = (pointX - x) ** 2 + (pointY - y) ** 2;
        if (nextDistance < distance) {
          selected = index;
          distance = nextDistance;
        }
      }
    }
    return selected;
  };
  const start = findCell(startX, startY);
  const goal = findCell(targetX, targetY);
  if (start < 0 || goal < 0) return null;
  const startCellX = start % graph.columns;
  const startCellY = Math.floor(start / graph.columns);
  const goalCellX = goal % graph.columns;
  const goalCellY = Math.floor(goal / graph.columns);
  const goalCenter = { x: cellCenter(goalCellX), y: cellCenter(goalCellY) };
  const goalPoint =
    graph.canStandAt(targetX, targetY) &&
    segmentIsClear(graph, goalCenter, requestedTarget)
      ? requestedTarget
      : goalCenter;
  if (start === goal) {
    if (
      Math.hypot(targetX - startX, targetY - startY) > 0.05 &&
      graph.canStandAt(targetX, targetY) &&
      segmentIsClear(graph, startPoint, requestedTarget)
    ) {
      return {
        points: [startPoint, requestedTarget],
        distance: Math.hypot(targetX - startX, targetY - startY),
      };
    }
    return { points: [startPoint], distance: 0 };
  }

  // Search on the quarter-tile occupancy grid used by the navigation graph. Diagonal
  // edges are accepted only when the avatar's full collision radius clears them;
  // a turn cost favors routes that do not keep changing direction.
  const cellCount = graph.columns * graph.rows;
  const startState = cellCount * PATH_DIRECTIONS.length;
  const stateCount = startState + 1;
  const parent = new Int32Array(stateCount);
  parent.fill(-1);
  const costs = new Float64Array(stateCount);
  costs.fill(Number.POSITIVE_INFINITY);
  costs[startState] = 0;
  parent[startState] = startState;
  const queue = new PathQueue();
  queue.push({
    state: startState,
    cost: 0,
    priority: octileDistance(startCellX, startCellY, goalCellX, goalCellY),
  });
  let goalState = -1;
  while (queue.length) {
    const current = queue.pop()!;
    if (current.cost !== costs[current.state]) continue;
    const currentCell =
      current.state === startState
        ? start
        : Math.floor(current.state / PATH_DIRECTIONS.length);
    if (currentCell === goal) {
      goalState = current.state;
      break;
    }
    const currentX = currentCell % graph.columns;
    const currentY = Math.floor(currentCell / graph.columns);
    const worldX = cellCenter(currentX);
    const worldY = cellCenter(currentY);
    const previousDirection =
      current.state === startState
        ? -1
        : current.state % PATH_DIRECTIONS.length;
    for (let direction = 0; direction < PATH_DIRECTIONS.length; direction++) {
      const [dx, dy] = PATH_DIRECTIONS[direction];
      const nextX = currentX + dx;
      const nextY = currentY + dy;
      if (
        nextX < 0 ||
        nextY < 0 ||
        nextX >= graph.columns ||
        nextY >= graph.rows
      )
        continue;
      const nextCell = nextY * graph.columns + nextX;
      if (!graph.walkable[nextCell]) continue;
      const nextWorldX = cellCenter(nextX);
      const nextWorldY = cellCenter(nextY);
      let edgeIsClear = true;
      for (let probe = 1; probe <= EDGE_PROBES; probe++) {
        const progress = probe / EDGE_PROBES;
        if (
          !graph.canStandAt(
            worldX + (nextWorldX - worldX) * progress,
            worldY + (nextWorldY - worldY) * progress,
          )
        ) {
          edgeIsClear = false;
          break;
        }
      }
      if (!edgeIsClear) continue;
      const nextState = nextCell * PATH_DIRECTIONS.length + direction;
      const turn =
        previousDirection < 0
          ? 0
          : directionChange(previousDirection, direction) * TURN_COST;
      const nextCost =
        current.cost + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) + turn;
      if (nextCost >= costs[nextState]) continue;
      costs[nextState] = nextCost;
      parent[nextState] = current.state;
      queue.push({
        state: nextState,
        cost: nextCost,
        priority: nextCost + octileDistance(nextX, nextY, goalCellX, goalCellY),
      });
    }
  }
  if (goalState < 0) return null;
  const points = [{ x: startX, y: startY }];
  const startCenter = { x: cellCenter(startCellX), y: cellCenter(startCellY) };
  if (Math.hypot(startCenter.x - startX, startCenter.y - startY) > 0.01)
    points.push(startCenter);
  const reversed: Array<{ x: number; y: number }> = [];
  let cursor = goalState;
  while (cursor !== startState) {
    const cell = Math.floor(cursor / PATH_DIRECTIONS.length);
    const cellX = cell % graph.columns;
    const cellY = Math.floor(cell / graph.columns);
    reversed.push({ x: cellCenter(cellX), y: cellCenter(cellY) });
    cursor = parent[cursor];
  }
  points.push(...reversed.reverse());
  const lastPoint = points.at(-1)!;
  if (Math.hypot(goalPoint.x - lastPoint.x, goalPoint.y - lastPoint.y) > 0.01)
    points.push(goalPoint);
  const simplified = roundPathCorners(graph, smoothPath(graph, points));
  let distance = 0;
  for (let index = 1; index < simplified.length; index++)
    distance += Math.hypot(
      simplified[index].x - simplified[index - 1].x,
      simplified[index].y - simplified[index - 1].y,
    );
  return { points: simplified, distance };
}
