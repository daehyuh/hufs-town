import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import schema from "../../../백엔드/contracts/world.schema.json";
import editingSchema from "../../../백엔드/contracts/map-editing.schema.json";
import {
  buildMovementCollisionGrid,
  canStand,
  step,
} from "../../src/game/movement";
import type { MapDefinition } from "../../src/generated/protocol";
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../백엔드/contracts/fixtures/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
describe("shared wire contracts", () => {
  const ajv = new Ajv({ strict: false });
  ajv.addSchema(schema);
  ajv.addSchema(editingSchema);
  it("accepts the Java join, movement and map fixtures", () => {
    expect(ajv.validate(schema, fixture("join"))).toBe(true);
    expect(ajv.validate(schema, fixture("move"))).toBe(true);
    expect(
      ajv.validate(
        { $ref: `${schema.$id}#/$defs/MapDefinition` },
        fixture("campus-map"),
      ),
    ).toBe(true);
  });
  it("requires a version and allows bounded fractional directions", () => {
    expect(
      ajv.validate(schema, { ...fixture("join"), protocolVersion: 1 }),
    ).toBe(false);
    expect(
      ajv.validate(schema, { ...fixture("move"), dx: 0.5, dy: -0.25 }),
    ).toBe(true);
    expect(ajv.validate(schema, { ...fixture("move"), dx: 1.01 })).toBe(false);
  });
  it("validates collaborative deltas without changing existing map snapshots", () => {
    const command = fixture("map-edit-command");
    expect(ajv.validate(editingSchema, command)).toBe(true);
    expect(
      ajv.validate(
        { $ref: `${editingSchema.$id}#/$defs/OperationEvent` },
        {
          mapId: command.mapId,
          sequence: 1,
          actorId: "member-1",
          actorName: "HUFS Member",
          clientId: command.clientId,
          operationId: command.operationId,
          baseSequence: 0,
          undoOfSequence: null,
          actions: command.actions,
          createdAt: "2026-09-27T08:00:00Z",
        },
      ),
    ).toBe(true);
    expect(
      ajv.validate(
        { $ref: `${editingSchema.$id}#/$defs/UndoCommand` },
        {
          protocolVersion: 1,
          mapId: command.mapId,
          clientId: command.clientId,
          operationId: command.operationId,
          baseSequence: 2,
          undoSequence: 1,
        },
      ),
    ).toBe(true);
    expect(
      ajv.validate(editingSchema, {
        ...fixture("map-edit-command"),
        actorId: "client-controlled",
      }),
    ).toBe(false);
    expect(
      ajv.validate(editingSchema, {
        ...fixture("map-edit-command"),
        actions: [
          {
            kind: "ENTITY_ADD",
            collection: "objects",
            entity: { id: "bad", asset: "desk", x: 1, y: 1, scale: 1 },
            collision: { x: 0, y: 0, width: 100, height: 100 },
          },
        ],
      }),
    ).toBe(false);
    expect(
      ajv.validate(
        { $ref: `${schema.$id}#/$defs/MapDefinition` },
        fixture("campus-map"),
      ),
    ).toBe(true);
  });
});
describe("client prediction invariants", () => {
  const map: MapDefinition = {
    ...fixture("campus-map"),
    collisions: [{ x: 5, y: 0, width: 1, height: 30 }],
  };
  it("keeps diagonal speed equal and clamps a stalled frame", () => {
    const result = step(map, 2, 2, 1, 1, false, 0.05);
    expect(Math.hypot(result.x - 2, result.y - 2)).toBeCloseTo(0.15);
    expect(step(map, 2, 2, 1, 0, true, 10).x).toBe(2.25);
  });
  it("keeps a safe diagonal around a collider corner instead of axis-stepping", () => {
    const cornerMap: MapDefinition = {
      ...map,
      collisions: [{ x: 5, y: 5, width: 1, height: 1 }],
    };
    const moved = step(cornerMap, 4.8, 4.8, 1, -1, false, 0.05);

    expect(moved.x).toBeGreaterThan(4.8);
    expect(moved.y).toBeLessThan(4.8);
    expect((moved.y - 4.8) / (moved.x - 4.8)).toBeCloseTo(-1);
  });
  it("keeps running outside the collider while sliding", () => {
    let p = { x: 4.7, y: 2 };
    for (let i = 0; i < 100; i++) p = step(map, p.x, p.y, 1, 1, true, 0.05);
    expect(p.x).toBeLessThan(4.78);
    expect(p.y).toBeGreaterThan(10);
    expect(canStand(map, 5.5, 12)).toBe(false);
  });
  it("keeps grid-indexed collision and movement identical to continuous checks", () => {
    const grid = buildMovementCollisionGrid(map);
    for (let y = 0.11; y < map.height; y += 0.137) {
      for (let x = 0.07; x < map.width; x += 0.119) {
        expect(canStand(map, x, y, grid)).toBe(canStand(map, x, y));
      }
    }

    let indexed = { x: 4.7, y: 2 };
    let continuous = { ...indexed };
    for (let i = 0; i < 100; i++) {
      indexed = step(map, indexed.x, indexed.y, 1, 1, true, 0.05, grid);
      continuous = step(map, continuous.x, continuous.y, 1, 1, true, 0.05);
      expect(indexed.x).toBe(continuous.x);
      expect(indexed.y).toBe(continuous.y);
    }
  });
  it("falls back to exact linear checks when a map is too dense to index safely", () => {
    const largeMap: MapDefinition = {
      ...map,
      width: 600,
      height: 600,
      collisions: [{ x: 0, y: 0, width: 600, height: 600 }],
    };
    const grid = buildMovementCollisionGrid(largeMap);

    expect(grid.buckets).toBeNull();
    expect(canStand(largeMap, 300, 300, grid)).toBe(
      canStand(largeMap, 300, 300),
    );
    expect(canStand(largeMap, 300, 300, grid)).toBe(false);
  });
});
