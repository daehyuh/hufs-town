import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ASSET_GROUPS } from "../../src/generated/assetGroups";
import officeCatalog from "../../src/generated/office-catalog.json";

const publicRoot = path.resolve(process.cwd(), "public");
const backendRoot = path.resolve(process.cwd(), "../백엔드");
const readBackendJson = (file: string) =>
  JSON.parse(readFileSync(path.join(backendRoot, file), "utf8"));
const publicAssetExists = (url: string) =>
  existsSync(path.join(publicRoot, url.replace(/^\//, "")));

describe("curated runtime asset groups", () => {
  it("keeps the full design source catalog out of the web bundle", () => {
    const sourceManifest = readBackendJson("assets/source-manifest.json");
    const runtimeSources = sourceManifest.filter(
      (asset: { runtime: boolean }) => asset.runtime,
    );
    const runtimeCatalog = JSON.parse(
      readFileSync(path.join(publicRoot, "assets/catalog.json"), "utf8"),
    );

    expect(sourceManifest.length).toBeGreaterThan(6000);
    expect(runtimeSources.length / sourceManifest.length).toBeLessThan(0.1);
    expect(runtimeCatalog.groups.avatarSheets).toHaveLength(9);
    for (const { url } of Object.values(runtimeCatalog.selected) as Array<{
      url: string;
    }>)
      expect(publicAssetExists(url)).toBe(true);
  });

  it("loads only the starter map's pixel-art and GDG assets", () => {
    const campusSquare = readBackendJson(
      "contracts/fixtures/campus-square-map.json",
    );
    const mapAssetIds = new Set(
      campusSquare.objects.map((object: { asset: string }) => object.asset),
    );
    const catalogById = new Map(
      officeCatalog.items.map((asset) => [asset.id, asset]),
    );

    expect(mapAssetIds.has("gdg-sign")).toBe(true);
    expect(ASSET_GROUPS.campusSquare.every((id) => mapAssetIds.has(id))).toBe(
      true,
    );
    for (const id of ASSET_GROUPS.campusSquare) {
      const asset = catalogById.get(id);
      expect(asset, `Missing catalog entry for ${id}`).toBeDefined();
      expect(publicAssetExists(asset!.url)).toBe(true);
    }
  });

  it("uses generated avatar sheets and GDG branding in runtime loaders", () => {
    expect(ASSET_GROUPS.avatarSheets).toHaveLength(9);
    for (const asset of ASSET_GROUPS.avatarSheets) {
      expect(asset.frameWidth).toBe(16);
      expect(asset.frameHeight).toBe(16);
      expect(publicAssetExists(asset.url)).toBe(true);
    }
    expect(publicAssetExists(ASSET_GROUPS.brand.mark)).toBe(true);
    expect(publicAssetExists(ASSET_GROUPS.brand.campusIllustration)).toBe(true);
    expect(publicAssetExists(ASSET_GROUPS.woodlandAtlas.url)).toBe(true);
  });
});
