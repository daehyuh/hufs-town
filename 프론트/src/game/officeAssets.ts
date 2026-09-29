import catalog from "../generated/office-catalog.json";
import type { MapDefinition, MapObject, Rect } from "../generated/protocol";
export interface OfficeAsset {
  id: string;
  name: string;
  category: string;
  width: number;
  height: number;
  footprint: Rect | null;
  url: string;
  thumbnailUrl?: string;
  source: string;
  layer: string;
}
export const OFFICE_ASSETS: OfficeAsset[] = catalog.items;
export const OBJECT_DIRECTIONS = ["down", "left", "up", "right"] as const;
export const ASSETS_BY_ID = new Map(
  OFFICE_ASSETS.map((asset) => [asset.id, asset]),
);
const customAssetIds = new Set<string>();
export function registerCustomAssets(assets: OfficeAsset[]) {
  for (const asset of assets) {
    if (!asset.id.startsWith("custom_")) continue;
    customAssetIds.add(asset.id);
    ASSETS_BY_ID.set(asset.id, asset);
  }
}
export function replaceCustomAssets(assets: OfficeAsset[]) {
  for (const id of customAssetIds) ASSETS_BY_ID.delete(id);
  customAssetIds.clear();
  registerCustomAssets(assets);
}
export function unregisterCustomAsset(id: string) {
  if (id.startsWith("custom_")) {
    customAssetIds.delete(id);
    ASSETS_BY_ID.delete(id);
  }
}
export function allOfficeAssets(): OfficeAsset[] {
  return [...ASSETS_BY_ID.values()];
}
export function objectAngle(direction: MapObject["direction"] = "down") {
  switch (direction) {
    case "left":
      return -Math.PI / 2;
    case "up":
      return Math.PI;
    case "right":
      return Math.PI / 2;
    default:
      return 0;
  }
}
function objectRotation(direction: MapObject["direction"] = "down") {
  switch (direction) {
    case "left":
      return { cos: 0, sin: -1 };
    case "up":
      return { cos: -1, sin: 0 };
    case "right":
      return { cos: 0, sin: 1 };
    default:
      return { cos: 1, sin: 0 };
  }
}
function rotateRectAround(
  rect: Rect,
  centerX: number,
  centerY: number,
  direction: MapObject["direction"],
): Rect {
  const { cos, sin } = objectRotation(direction);
  const dx = rect.x + rect.width / 2 - centerX;
  const dy = rect.y + rect.height / 2 - centerY;
  const rotatedCenterX = centerX + dx * cos - dy * sin;
  const rotatedCenterY = centerY + dx * sin + dy * cos;
  const width = Math.abs(cos) * rect.width + Math.abs(sin) * rect.height;
  const height = Math.abs(sin) * rect.width + Math.abs(cos) * rect.height;
  return {
    x: rotatedCenterX - width / 2,
    y: rotatedCenterY - height / 2,
    width,
    height,
  };
}
export function objectBounds(object: MapObject): Rect {
  const asset = ASSETS_BY_ID.get(object.asset)!;
  const width = (asset.width * object.scale) / 32;
  const height = (asset.height * object.scale) / 32;
  const { cos, sin } = objectRotation(object.direction);
  const rotatedWidth = Math.abs(cos) * width + Math.abs(sin) * height;
  const rotatedHeight = Math.abs(sin) * width + Math.abs(cos) * height;
  const centerY = object.y - height / 2;
  return {
    x: object.x - rotatedWidth / 2,
    y: centerY - rotatedHeight / 2,
    width: rotatedWidth,
    height: rotatedHeight,
  };
}
export function rebuildCollisions(map: MapDefinition): MapDefinition {
  const collisions = map.walls.map((wall) => ({ ...wall.bounds }));
  for (const object of map.objects) {
    const asset = ASSETS_BY_ID.get(object.asset);
    const f = asset?.footprint;
    const scale = object.scale / 2;
    if (asset && f) {
      const footprint = {
        x: object.x + (f.x - asset.width / 32) * scale,
        y: object.y + f.y * scale,
        width: f.width * scale,
        height: f.height * scale,
      };
      const spriteHeight = (asset.height * object.scale) / 32;
      collisions.push(
        rotateRectAround(
          footprint,
          object.x,
          object.y - spriteHeight / 2,
          object.direction,
        ),
      );
    }
  }
  return { ...map, collisions };
}
