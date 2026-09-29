import { expect, it } from "vitest";
import { importMap, MapImportError } from "../../src/editor/importMap";
import source from "../../../백엔드/contracts/fixtures/campus-map.json";
import validationCases from "../../../백엔드/contracts/fixtures/map-validation-cases.json";
it("rebuilds catalog collisions and ignores imported collision overrides", () => {
  const map = importMap({ ...source, collisions: [] });
  expect(map.collisions).toEqual(source.collisions);
});
it("rejects corrupted recovery data and unregistered assets before rendering", () => {
  expect(() => importMap({ schemaVersion: 2 })).toThrow();
  expect(() =>
    importMap({
      ...source,
      objects: [
        { ...source.objects[0], asset: "https://example.invalid/asset" },
      ],
    }),
  ).toThrow();
  expect(() => importMap({ ...source, width: 99999 })).toThrow();
});

it("applies the scavenger clue limit in the shared map schema", () => {
  const marker = {
    ...source.objects[0],
    id: "clue-marker",
    interaction: {
      kind: "SCAVENGER_ITEM",
      title: "캠퍼스 표식",
      body: "🙂".repeat(280),
    },
  };
  expect(() => importMap({ ...source, objects: [marker] })).not.toThrow();
  expect(() =>
    importMap({
      ...source,
      objects: [
        {
          ...marker,
          interaction: { ...marker.interaction, body: "🙂".repeat(281) },
        },
      ],
    }),
  ).toThrow();
});

it("keeps rotated sprites and their collision footprints aligned on import", () => {
  const map = importMap({
    ...source,
    objects: [
      {
        id: "rotated-board",
        asset: "whiteboard",
        x: 8,
        y: 4,
        scale: 2,
        direction: "right",
      },
    ],
  });
  expect(map.objects[0].direction).toBe("right");
  const footprint = map.collisions.find(
    (rect) =>
      Math.abs(rect.width - 0.4) < 0.01 && Math.abs(rect.height - 3.75) < 0.01,
  )!;
  expect(footprint.x).toBeCloseTo(6.5, 6);
  expect(footprint.y).toBeCloseTo(0.625, 6);
  expect(footprint.width).toBeCloseTo(0.4, 6);
  expect(footprint.height).toBeCloseTo(3.75, 6);
});

it("rejects a rotated sprite when its new rendered bounds leave the map", () => {
  let thrown: unknown;
  try {
    importMap({
      ...source,
      objects: [
        {
          id: "edge-plant",
          asset: "plant-small",
          x: 0.7,
          y: 2,
          scale: 2,
          direction: "right",
        },
      ],
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MapImportError);
  expect(thrown).toMatchObject({
    code: "invalidAsset",
    translationKey: "editor.asset.error.importAsset",
  });
});

it("returns a precise translation key for common invalid map imports", () => {
  const duplicateId = {
    ...source,
    objects: [
      ...source.objects,
      { ...source.objects[0], id: source.floors[0].id },
    ],
  };
  const cases = [
    [{ schemaVersion: 2 }, "invalidSchema", "editor.asset.error.importSchema"],
    [{ ...source, width: 99999 }, "bounds", "editor.asset.error.importBounds"],
    [duplicateId, "duplicateId", "editor.asset.error.importDuplicateId"],
  ] as const;

  for (const [input, code, translationKey] of cases) {
    let thrown: unknown;
    try {
      importMap(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MapImportError);
    expect(thrown).toMatchObject({ code, translationKey });
  }
});

it("matches the shared Java map validation fixtures", () => {
  for (const testCase of validationCases.cases) {
    let input: Record<string, unknown> = {
      ...structuredClone(source),
      ...("patch" in testCase ? testCase.patch : {}),
    };
    const map = input as typeof source;
    switch ("mutation" in testCase ? testCase.mutation : "") {
      case "duplicate-first-floor-id":
        input = {
          ...input,
          floors: [...map.floors, { ...map.floors[0] }],
        };
        break;
      case "add-out-of-bounds-zone":
        input = {
          ...input,
          zones: [
            {
              id: "outside-zone",
              name: "맵 밖 구역",
              kind: "PRIVATE",
              bounds: { x: map.width - 1, y: 2, width: 2, height: 2 },
              capacity: 12,
            },
          ],
        };
        break;
      case "replace-with-overlapping-zones":
        input = {
          ...input,
          zones: [
            {
              id: "zone-a",
              name: "구역 A",
              kind: "PRIVATE",
              bounds: { x: 2, y: 2, width: 4, height: 4 },
              capacity: 12,
            },
            {
              id: "zone-b",
              name: "구역 B",
              kind: "SILENT",
              bounds: { x: 5, y: 5, width: 4, height: 4 },
            },
          ],
        };
        break;
      case "replace-with-touching-zones":
        input = {
          ...input,
          zones: [
            {
              id: "zone-a",
              name: "구역 A",
              kind: "PRIVATE",
              bounds: { x: 2, y: 2, width: 4, height: 4 },
              capacity: 12,
            },
            {
              id: "zone-b",
              name: "구역 B",
              kind: "SILENT",
              bounds: { x: 6, y: 2, width: 4, height: 4 },
            },
          ],
        };
        break;
    }

    if (testCase.valid)
      expect(() => importMap(input), testCase.name).not.toThrow();
    else expect(() => importMap(input), testCase.name).toThrow();
  }
});
