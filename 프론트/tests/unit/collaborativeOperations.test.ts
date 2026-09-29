import { describe, expect, it } from "vitest";
import type { MapDefinition } from "../../src/generated/protocol";
import {
  applyMapEditActions,
  diffMap,
  mapEditTouches,
} from "../../src/editor/collaborativeOperations";

function mapWith(overrides: Partial<MapDefinition> = {}): MapDefinition {
  return {
    schemaVersion: 2,
    id: "collaborative-test",
    revision: "test-revision",
    name: "Test map",
    width: 20,
    height: 16,
    spawnX: 2,
    spawnY: 2,
    collisions: [],
    objects: [
      { id: "desk-a", asset: "desk", x: 3, y: 3, scale: 1 },
      { id: "desk-b", asset: "desk", x: 5, y: 3, scale: 1 },
    ],
    zones: [],
    floors: [],
    walls: [],
    labels: [],
    portals: [],
    ...overrides,
  };
}

describe("collaborative map operations", () => {
  it("round-trips independent edits, entity changes, map fields, and order", () => {
    const before = mapWith();
    const after = mapWith({
      name: "Updated map",
      spawnX: 4,
      objects: [
        { id: "desk-b", asset: "desk", x: 5, y: 3, scale: 1 },
        { id: "desk-a", asset: "desk", x: 4, y: 3, scale: 1 },
        { id: "plant", asset: "plant-small", x: 8, y: 4, scale: 1 },
      ],
      labels: [{ id: "welcome", text: "Hello", x: 2, y: 6 }],
    });

    const actions = diffMap(before, after);
    const applied = applyMapEditActions(before, actions);

    expect(applied).toEqual(after);
    expect(actions).toContainEqual({
      kind: "MAP_FIELD_SET",
      field: "name",
      value: "Updated map",
    });
    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: "ENTITY_ADD",
        collection: "objects",
        entity: { id: "plant", asset: "plant-small", x: 8, y: 4, scale: 1 },
      }),
    );
    expect(actions.some((action) => action.kind === "ENTITY_REORDER")).toBe(
      true,
    );
  });

  it("uses entity and order touches to identify stale overlapping edits", () => {
    const actions = diffMap(
      mapWith(),
      mapWith({
        objects: [
          { id: "desk-a", asset: "desk", x: 3.5, y: 3, scale: 1 },
          { id: "desk-b", asset: "desk", x: 5, y: 3, scale: 1 },
        ],
      }),
    );

    expect(mapEditTouches(actions)).toEqual(new Set(["entity:desk-a"]));
    expect(
      [...mapEditTouches(actions)].some((touch) => touch.startsWith("map:")),
    ).toBe(false);
  });
});
