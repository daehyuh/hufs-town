import { describe, expect, it } from "vitest";
import type { MapDefinition } from "../../src/generated/protocol";
import officeMapFixture from "../../public/assets/office/default-map.json";
import {
  buildMovementCollisionGrid,
  canStand,
  step,
} from "../../src/game/movement";
import {
  buildNavigationGraph,
  navigationFollowTarget,
  navigationPathTo,
} from "../../src/game/navigation";

function mapWith(overrides: Partial<MapDefinition> = {}): MapDefinition {
  return {
    schemaVersion: 2,
    id: "navigation-test",
    revision: "navigation-revision",
    name: "Navigation test",
    width: 16,
    height: 16,
    spawnX: 2,
    spawnY: 8,
    collisions: [],
    objects: [],
    zones: [],
    floors: [],
    walls: [],
    labels: [],
    portals: [],
    ...overrides,
  };
}

function expectClearPath(
  graph: ReturnType<typeof buildNavigationGraph>,
  points: Array<{ x: number; y: number }>,
) {
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    for (let probe = 0; probe <= 20; probe++) {
      const progress = probe / 20;
      expect(
        graph.canStandAt(
          from.x + (to.x - from.x) * progress,
          from.y + (to.y - from.y) * progress,
        ),
      ).toBe(true);
    }
  }
}

function largestTurnAngle(points: Array<{ x: number; y: number }>) {
  let largest = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const first = { x: current.x - previous.x, y: current.y - previous.y };
    const second = { x: next.x - current.x, y: next.y - current.y };
    const firstLength = Math.hypot(first.x, first.y);
    const secondLength = Math.hypot(second.x, second.y);
    if (!firstLength || !secondLength) continue;
    const cosine = Math.max(
      -1,
      Math.min(
        1,
        (first.x * second.x + first.y * second.y) /
          (firstLength * secondLength),
      ),
    );
    largest = Math.max(largest, (Math.acos(cosine) * 180) / Math.PI);
  }
  return largest;
}

describe("click-to-move navigation", () => {
  it("uses quarter-tile cells so obstacle routes have finer steering points", () => {
    const graph = buildNavigationGraph(mapWith(), new Set());

    expect(graph.columns).toBe(64);
    expect(graph.rows).toBe(64);
  });

  it("keeps quarter-tile navigation occupancy aligned with movement collision", () => {
    const map = mapWith({
      collisions: [
        { x: 4.13, y: 2.17, width: 0.63, height: 6.25 },
        { x: 9.4, y: 8.35, width: 2.15, height: 1.7 },
        { x: 0, y: 0, width: 0.5, height: 0.5 },
      ],
    });
    const graph = buildNavigationGraph(map, new Set());

    for (let row = 0; row < graph.rows; row++) {
      for (let column = 0; column < graph.columns; column++) {
        const x = (column + 0.5) * 0.25;
        const y = (row + 0.5) * 0.25;
        expect(graph.walkable[row * graph.columns + column] === 1).toBe(
          canStand(map, x, y),
        );
      }
    }

    for (let y = 0.11; y < map.height; y += 0.137) {
      for (let x = 0.07; x < map.width; x += 0.119) {
        expect(graph.canStandAt(x, y)).toBe(canStand(map, x, y));
      }
    }
  });

  it("moves to the clicked point when start and target share one half-tile cell", () => {
    const graph = buildNavigationGraph(mapWith(), new Set());
    const path = navigationPathTo(graph, 2.1, 2.1, 2.35, 2.2);

    expect(path).toEqual({
      points: [
        { x: 2.1, y: 2.1 },
        { x: 2.35, y: 2.2 },
      ],
      distance: Math.hypot(0.25, 0.1),
    });
  });

  it("uses a direct diagonal on an open floor instead of a staircase route", () => {
    const graph = buildNavigationGraph(mapWith(), new Set());
    const path = navigationPathTo(graph, 2, 2, 12, 8);

    expect(path).not.toBeNull();
    expect(path!.points).toHaveLength(2);
    expect(path!.distance).toBeLessThan(12);
    expectClearPath(graph, path!.points);
  });

  it("rounds obstacle corners into a smooth, collision-safe route", () => {
    const graph = buildNavigationGraph(
      mapWith({ collisions: [{ x: 7, y: 2, width: 2, height: 12 }] }),
      new Set(),
    );
    const path = navigationPathTo(graph, 2, 8, 14, 8);

    expect(path).not.toBeNull();
    expect(path!.distance).toBeGreaterThan(12);
    expect(path!.points.length).toBeGreaterThan(4);
    expect(largestTurnAngle(path!.points)).toBeLessThan(35);
    expectClearPath(graph, path!.points);
  });

  it("follows rounded routes smoothly across their short samples", () => {
    const map = mapWith({
      collisions: [{ x: 7, y: 2, width: 2, height: 12 }],
    });
    const graph = buildNavigationGraph(map, new Set());
    const path = navigationPathTo(graph, 2, 8, 14, 8);
    expect(path).not.toBeNull();

    const movementGrid = buildMovementCollisionGrid(map);
    let position = { x: 2, y: 8 };
    let segmentIndex = 0;
    const samples = [position];
    let reached = false;
    for (let tick = 0; tick < 400; tick++) {
      const following = navigationFollowTarget(
        graph,
        path!.points,
        position,
        segmentIndex,
      );
      expect(following).not.toBeNull();
      if (following!.reached) {
        reached = true;
        break;
      }
      segmentIndex = following!.segmentIndex;
      const dx = following!.target.x - position.x;
      const dy = following!.target.y - position.y;
      const next = step(
        map,
        position.x,
        position.y,
        dx,
        dy,
        false,
        0.05,
        movementGrid,
      );
      expect(
        Math.hypot(next.x - position.x, next.y - position.y),
      ).toBeGreaterThan(0);
      position = next;
      samples.push(position);
    }

    expect(reached).toBe(true);
    expect(Math.hypot(position.x - 14, position.y - 8)).toBeLessThanOrEqual(
      0.14,
    );
    expect(samples.length).toBeGreaterThan(20);
    expect(largestTurnAngle(samples)).toBeLessThan(55);
    expectClearPath(graph, samples);
  });

  it("keeps route progress from jumping across a bend in one update", () => {
    const graph = buildNavigationGraph(mapWith(), new Set());
    const points = Array.from({ length: 11 }, (_, index) => ({
      x: 2 + index * 0.5,
      y: 2 + Math.sin(index * 0.3),
    }));
    const following = navigationFollowTarget(graph, points, points[7], 0);

    expect(following).not.toBeNull();
    expect(following!.segmentIndex).toBeLessThanOrEqual(3);
  });

  it("click-walks from the office spawn through the lounge doorway", () => {
    const map = officeMapFixture as MapDefinition;
    const graph = buildNavigationGraph(map, new Set());
    const path = navigationPathTo(graph, map.spawnX, map.spawnY, 12.5, 23.5);
    expect(path).not.toBeNull();

    let position = { x: map.spawnX, y: map.spawnY };
    let segmentIndex = 0;
    const movementGrid = buildMovementCollisionGrid(map);
    let reached = false;
    for (let tick = 0; tick < 500; tick++) {
      const following = navigationFollowTarget(
        graph,
        path!.points,
        position,
        segmentIndex,
      );
      if (!following) break;
      if (following.reached) {
        reached = true;
        break;
      }
      segmentIndex = following.segmentIndex;
      position = step(
        map,
        position.x,
        position.y,
        following.target.x - position.x,
        following.target.y - position.y,
        false,
        0.05,
        movementGrid,
      );
    }

    expect(reached).toBe(true);
    expect(
      Math.hypot(position.x - 12.5, position.y - 23.5),
    ).toBeLessThanOrEqual(0.14);
  });

  it("does not route across a locked zone that seals the map", () => {
    const graph = buildNavigationGraph(
      mapWith({
        zones: [
          {
            id: "locked-room",
            name: "Locked room",
            kind: "PRIVATE",
            bounds: { x: 7, y: 0, width: 2, height: 16 },
            capacity: 8,
          },
        ],
      }),
      new Set(["locked-room"]),
    );

    expect(navigationPathTo(graph, 2, 8, 14, 8)).toBeNull();
  });

  it("stops at the edge when a click target falls inside a locked zone", () => {
    const room = {
      id: "locked-room",
      name: "Locked room",
      kind: "PRIVATE" as const,
      bounds: { x: 7, y: 5, width: 3, height: 6 },
      capacity: 8,
    };
    const graph = buildNavigationGraph(
      mapWith({ zones: [room] }),
      new Set([room.id]),
    );
    const path = navigationPathTo(graph, 2, 8, 8, 8);

    expect(path).not.toBeNull();
    expectClearPath(graph, path!.points);
    const end = path!.points.at(-1)!;
    expect(
      end.x < room.bounds.x || end.x >= room.bounds.x + room.bounds.width,
    ).toBe(true);
  });
});
