import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { MapDefinition } from "../../src/generated/protocol";

function readMapFixture(fileName: string) {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../백엔드/contracts/fixtures/${fileName}`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as MapDefinition;
}
const campusMap = readMapFixture("campus-map.json");
const campusSquare = readMapFixture("campus-square-map.json");
const studySpace = readMapFixture("study-space-map.json");
const meetupHall = readMapFixture("meetup-hall-map.json");
const templateMaps = [campusMap, campusSquare, studySpace, meetupHall];

test("starter maps use the GDG HUFS name without decorative banners", () => {
  expect(campusMap.name).toBe("GDG HUFS 훕스타운");
  expect(templateMaps.every((map) => map.labels.length === 0)).toBe(true);
  const bundledMap = JSON.parse(
    readFileSync(
      new URL(
        "../../../프론트/public/assets/office/default-map.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as MapDefinition;
  expect(bundledMap).toEqual(campusMap);
});

test("GDG campus starter map renders its curated pixel-art bundle", async ({
  page,
}) => {
  await page.goto("/");
  const loadedAssets = await page.evaluate(async (map) => {
    const renderMapModule = new URL("/src/game/renderMap.ts", location.origin)
      .href;
    const { loadOfficeImages, paintMap, TILE } = await import(
      /* @vite-ignore */ renderMapModule
    );
    const assetIds = [...new Set(map.objects.map((object) => object.asset))];
    const images = await loadOfficeImages(assetIds);
    const canvas = document.createElement("canvas");
    canvas.width = map.width * TILE;
    canvas.height = map.height * TILE;
    canvas.style.width = "min(100vw, 1200px)";
    canvas.style.height = "auto";
    canvas.style.imageRendering = "pixelated";
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas rendering is unavailable");
    paintMap(context, map, images);
    document.body.replaceChildren(canvas);
    return [...images.keys()];
  }, campusSquare);

  expect(loadedAssets).toHaveLength(
    new Set(campusSquare.objects.map((object) => object.asset)).size,
  );
  expect(loadedAssets).toEqual(
    expect.arrayContaining([
      "gdg-sign",
      "campus-tree-large",
      "campus-tree",
      "campus-bush",
      "campus-berries",
      "campus-house-large",
    ]),
  );
  await page.screenshot({
    path: "test-results/campus-square-starter.png",
    fullPage: true,
  });
});

test("a failed bundled image reports its name and can be retried", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/assets/tree_deciduous_huge_1.png", async (route) => {
    requests += 1;
    if (requests === 1) return route.abort("failed");
    return route.continue();
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const renderMapModule = new URL("/src/game/renderMap.ts", location.origin)
      .href;
    const { loadOfficeImages } = await import(
      /* @vite-ignore */ renderMapModule
    );
    let failure = "";
    try {
      await loadOfficeImages(["campus-tree-large"]);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const retry = await loadOfficeImages(["campus-tree-large"]);
    return { failure, recovered: retry.has("campus-tree-large") };
  });

  expect(result.failure).toContain("큰 도트 나무");
  expect(result.recovered).toBe(true);
  expect(requests).toBe(2);
});

test("every starter template loads its objects and paints a map", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async (maps) => {
    const renderMapModule = new URL("/src/game/renderMap.ts", location.origin)
      .href;
    const { loadOfficeImages, paintMap, TILE } = await import(
      /* @vite-ignore */ renderMapModule
    );
    const counts: number[] = [];
    for (const map of maps) {
      const assetIds = [...new Set(map.objects.map((object) => object.asset))];
      const images = await loadOfficeImages(assetIds);
      const canvas = document.createElement("canvas");
      canvas.width = map.width * TILE;
      canvas.height = map.height * TILE;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas rendering is unavailable");
      paintMap(context, map, images);
      counts.push(assetIds.filter((assetId) => images.has(assetId)).length);
    }
    return counts;
  }, templateMaps);

  expect(results).toHaveLength(4);
  expect(results.every((count) => count > 0)).toBe(true);
  expect(results[0]).toBe(
    new Set(campusMap.objects.map((object) => object.asset)).size,
  );
  expect(results[2]).toBe(
    new Set(studySpace.objects.map((object) => object.asset)).size,
  );
  expect(results[3]).toBe(
    new Set(meetupHall.objects.map((object) => object.asset)).size,
  );
});

test("16-tile floor chunks preserve the full-map pattern across every seam", async ({
  page,
}) => {
  await page.goto("/");
  const rendered = await page.evaluate(async (map) => {
    const renderMapModule = new URL("/src/game/renderMap.ts", location.origin)
      .href;
    const { mapRenderChunks, paintFloor, TILE } = await import(
      /* @vite-ignore */ renderMapModule
    );
    const expected = document.createElement("canvas");
    expected.width = map.width * TILE;
    expected.height = map.height * TILE;
    const expectedContext = expected.getContext("2d");
    if (!expectedContext) throw new Error("Canvas rendering is unavailable");
    paintFloor(expectedContext, map);

    const actual = document.createElement("canvas");
    actual.width = expected.width;
    actual.height = expected.height;
    const actualContext = actual.getContext("2d");
    if (!actualContext) throw new Error("Canvas rendering is unavailable");
    const chunks = mapRenderChunks(map.width, map.height);
    for (const chunk of chunks) {
      const width = chunk.width * TILE;
      const height = chunk.height * TILE;
      const layer = document.createElement("canvas");
      layer.width = width;
      layer.height = height;
      const context = layer.getContext("2d");
      if (!context) throw new Error("Canvas rendering is unavailable");
      context.save();
      context.beginPath();
      context.rect(0, 0, width, height);
      context.clip();
      context.translate(-chunk.x * TILE, -chunk.y * TILE);
      paintFloor(context, map, chunk);
      context.restore();
      actualContext.drawImage(layer, chunk.x * TILE, chunk.y * TILE);
    }
    const expectedPixels = expectedContext.getImageData(
      0,
      0,
      expected.width,
      expected.height,
    ).data;
    const actualPixels = actualContext.getImageData(
      0,
      0,
      actual.width,
      actual.height,
    ).data;
    let mismatchedPixels = 0;
    for (let index = 0; index < expectedPixels.length; index++)
      if (expectedPixels[index] !== actualPixels[index]) mismatchedPixels++;
    return { count: chunks.length, mismatchedPixels };
  }, campusSquare);

  expect(rendered.count).toBe(9);
  expect(rendered.mismatchedPixels).toBe(0);
});
