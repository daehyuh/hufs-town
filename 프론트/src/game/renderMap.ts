import type { MapDefinition, Wall } from "../generated/protocol";
import {
  ASSETS_BY_ID,
  allOfficeAssets,
  objectAngle,
  objectBounds,
} from "./officeAssets";
export const TILE = 32;
export const MAP_RENDER_CHUNK_TILES = 16;
export type MapRenderChunk = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function mapRenderChunks(
  width: number,
  height: number,
  chunkTiles = MAP_RENDER_CHUNK_TILES,
): MapRenderChunk[] {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isInteger(chunkTiles) ||
    width < 1 ||
    height < 1 ||
    chunkTiles < 1
  )
    throw new RangeError("맵과 렌더 청크 크기는 양의 정수여야 합니다.");

  const chunks: MapRenderChunk[] = [];
  for (let y = 0; y < height; y += chunkTiles)
    for (let x = 0; x < width; x += chunkTiles)
      chunks.push({
        x,
        y,
        width: Math.min(chunkTiles, width - x),
        height: Math.min(chunkTiles, height - y),
      });
  return chunks;
}
export const FLOOR_LABELS = {
  OAK: "밝은 오크",
  WOOD: "우드",
  CARPET_BLUE: "블루 카펫",
  CARPET_SAGE: "세이지 카펫",
  TILE: "화이트 타일",
  CONCRETE: "스톤",
  GRASS: "잔디",
  PAVERS: "보도 블록",
} as const;
export const WALL_LABELS = {
  CREAM: "크림 벽",
  SAGE: "세이지 벽",
  GLASS: "유리 파티션",
} as const;
const palettes = {
  OAK: ["#d9cbae", "#c8b793"],
  WOOD: ["#c4b393", "#ad9977"],
  CARPET_BLUE: ["#b6c7cc", "#a8bdc3"],
  CARPET_SAGE: ["#c3c9b2", "#b4bda1"],
  TILE: ["#e2e2d8", "#c8cdc3"],
  CONCRETE: ["#d4d8d1", "#c8cec5"],
  GRASS: ["#91ad73", "#829f65"],
  PAVERS: ["#c9c5b2", "#aaa795"],
} as const;
export function paintFloor(
  ctx: CanvasRenderingContext2D,
  map: MapDefinition,
  region: MapRenderChunk = {
    x: 0,
    y: 0,
    width: map.width,
    height: map.height,
  },
) {
  const regionRight = region.x + region.width;
  const regionBottom = region.y + region.height;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#67796e";
  ctx.fillRect(
    region.x * TILE,
    region.y * TILE,
    region.width * TILE,
    region.height * TILE,
  );
  ctx.fillStyle = "#34483f";
  ctx.fillRect(24, 36, (map.width - 1.4) * TILE, (map.height - 1.4) * TILE);
  for (const floor of map.floors) {
    const b = floor.bounds,
      [fill, seam] = palettes[floor.material];
    const left = Math.max(b.x, region.x);
    const top = Math.max(b.y, region.y);
    const right = Math.min(b.x + b.width, regionRight);
    const bottom = Math.min(b.y + b.height, regionBottom);
    if (left >= right || top >= bottom) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      left * TILE,
      top * TILE,
      (right - left) * TILE,
      (bottom - top) * TILE,
    );
    ctx.clip();
    ctx.fillStyle = fill;
    ctx.fillRect(b.x * TILE, b.y * TILE, b.width * TILE, b.height * TILE);
    ctx.fillStyle = seam;
    if (floor.material === "OAK" || floor.material === "WOOD") {
      for (let y = Math.floor(top); y < bottom; y++) {
        ctx.fillRect(b.x * TILE, y * TILE, b.width * TILE, 2);
        for (let x = Math.floor(b.x) - 3; x < b.x + b.width; x += 3) {
          ctx.fillRect((x + (y % 2 ? 1.5 : 0)) * TILE, y * TILE, 2, TILE);
          ctx.globalAlpha = 0.25;
          ctx.fillRect((x + 1) * TILE, y * TILE + 12, TILE, 2);
          ctx.globalAlpha = 1;
        }
      }
    } else if (floor.material === "PAVERS") {
      const step = TILE / 2;
      for (
        let y = Math.floor((top * TILE) / step);
        y * step < bottom * TILE;
        y++
      )
        for (
          let x = Math.floor((left * TILE) / step);
          x * step < right * TILE;
          x++
        ) {
          const px = x * step,
            py = y * step;
          ctx.fillStyle = (x + y) % 2 ? fill : seam;
          ctx.fillRect(px + 1, py + 1, step - 2, step - 2);
        }
    } else if (floor.material === "TILE") {
      for (let x = Math.floor(left); x < right; x++)
        ctx.fillRect(x * TILE, b.y * TILE, 2, b.height * TILE);
      for (let y = Math.floor(top); y < bottom; y++)
        ctx.fillRect(b.x * TILE, y * TILE, b.width * TILE, 2);
    } else {
      ctx.globalAlpha = 0.4;
      const firstY =
        b.y * TILE + Math.max(0, Math.ceil((top * TILE - b.y * TILE) / 8)) * 8;
      const firstX =
        b.x * TILE + Math.max(0, Math.ceil((left * TILE - b.x * TILE) / 8)) * 8;
      for (let y = firstY; y < bottom * TILE; y += 8)
        for (let x = firstX; x < right * TILE; x += 8)
          ctx.fillRect(x + 2, y + 2, 2, 2);
    }
    ctx.restore();
  }
}
export function paintStageZones(
  ctx: CanvasRenderingContext2D,
  map: MapDefinition,
  stageLabel = "무대",
  includeLabels = true,
) {
  ctx.save();
  for (const zone of map.zones) {
    if (zone.kind !== "STAGE") continue;
    const { x, y, width, height } = zone.bounds;
    ctx.fillStyle = "#e2b84b24";
    ctx.fillRect(x * TILE, y * TILE, width * TILE, height * TILE);
    ctx.strokeStyle = "#b68128dd";
    ctx.lineWidth = 3;
    ctx.setLineDash([9, 5]);
    ctx.strokeRect(
      x * TILE + 2,
      y * TILE + 2,
      width * TILE - 4,
      height * TILE - 4,
    );
    ctx.setLineDash([]);
  }
  ctx.restore();
  if (includeLabels) paintStageZoneLabels(ctx, map, stageLabel);
}

export function paintStageZoneLabels(
  ctx: CanvasRenderingContext2D,
  map: MapDefinition,
  stageLabel = "무대",
) {
  ctx.save();
  for (const zone of map.zones) {
    if (zone.kind !== "STAGE") continue;
    const { x, y, width, height } = zone.bounds;
    const label = `▶ ${zone.name} · ${stageLabel}`;
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const labelWidth = Math.min(
      width * TILE - 8,
      ctx.measureText(label).width + 14,
    );
    const centerX = (x + width / 2) * TILE;
    const labelY = (y + Math.min(height / 2, 0.7)) * TILE;
    ctx.fillStyle = "#fff8e9e8";
    ctx.fillRect(centerX - labelWidth / 2, labelY - 10, labelWidth, 20);
    ctx.fillStyle = "#765015";
    ctx.fillText(label, centerX, labelY, Math.max(0, labelWidth - 10));
  }
  ctx.restore();
}
export function paintWall(
  ctx: CanvasRenderingContext2D,
  wall: Wall,
  offsetX = 0,
  offsetY = 0,
) {
  const b = wall.bounds,
    x = b.x * TILE - offsetX,
    y = b.y * TILE - offsetY,
    w = b.width * TILE,
    h = b.height * TILE;
  const glass = wall.material === "GLASS";
  ctx.fillStyle = "#384c4230";
  ctx.fillRect(x + 4, y + 9, w, h + 4);
  ctx.fillStyle = glass ? "#8ba6a0" : "#526555";
  ctx.fillRect(x, y - 12, w, h + 12);
  ctx.fillStyle = glass
    ? "#d0e4dcbf"
    : wall.material === "SAGE"
      ? "#8fa38b"
      : "#e8e5d6";
  ctx.fillRect(x + 2, y - 10, Math.max(w - 4, 2), h + 8);
  ctx.fillStyle = glass ? "#ecf4e8" : "#f7f1df";
  ctx.fillRect(x, y - 14, w, 4);
  ctx.fillStyle = glass ? "#718e85" : "#74836a";
  ctx.fillRect(x, y + h - 2, w, 3);
  if (glass) {
    ctx.fillStyle = "#92b0a5";
    if (w > h)
      for (let dx = 0; dx < w; dx += TILE * 2)
        ctx.fillRect(x + dx, y - 12, 3, h + 14);
    else for (let dy = 0; dy < h; dy += TILE * 2) ctx.fillRect(x, y + dy, w, 2);
  }
}
export function paintLabels(ctx: CanvasRenderingContext2D, map: MapDefinition) {
  ctx.save();
  ctx.font = "600 12px Manrope, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const label of map.labels) {
    const text = label.link ? `${label.text} ↗` : label.text;
    ctx.fillStyle = label.link ? "#315d70e8" : "#445c52bb";
    ctx.fillText(text, label.x * TILE, label.y * TILE);
    if (label.link) {
      const width = ctx.measureText(text).width;
      ctx.strokeStyle = "#315d70aa";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(label.x * TILE - width / 2, label.y * TILE + 8);
      ctx.lineTo(label.x * TILE + width / 2, label.y * TILE + 8);
      ctx.stroke();
    }
  }
  ctx.restore();
}
export function paintPortals(
  ctx: CanvasRenderingContext2D,
  map: MapDefinition,
) {
  for (const portal of map.portals ?? []) {
    const b = portal.bounds;
    ctx.fillStyle = "#4c91a344";
    ctx.fillRect(b.x * TILE, b.y * TILE, b.width * TILE, b.height * TILE);
    ctx.strokeStyle = "#2b7185cc";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(b.x * TILE, b.y * TILE, b.width * TILE, b.height * TILE);
    ctx.setLineDash([]);
    ctx.fillStyle = "#245c6c";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("↗", (b.x + b.width / 2) * TILE, (b.y + b.height / 2) * TILE);
  }
}
export function paintObjectInteractions(
  ctx: CanvasRenderingContext2D,
  map: MapDefinition,
) {
  for (const object of map.objects) {
    const interaction = object.interaction;
    if (!interaction) continue;
    const b = objectBounds(object);
    const x = (b.x + b.width - 0.2) * TILE;
    const y = (b.y + 0.2) * TILE;
    const color =
      interaction.kind === "NOTICE"
        ? "#8a6a31"
        : interaction.kind === "VIDEO"
          ? "#7c4e78"
          : interaction.kind === "IMAGE"
            ? "#a15c36"
            : interaction.kind === "BOARD"
              ? "#47754b"
              : interaction.kind === "NPC"
                ? "#4c6a9a"
                : interaction.kind === "SOUND"
                  ? "#8a5a95"
                  : "#2b7185";
    ctx.fillStyle = "#fffdf0e8";
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      interaction.kind === "NOTICE"
        ? "i"
        : interaction.kind === "VIDEO"
          ? "▶"
          : interaction.kind === "IMAGE"
            ? "▧"
            : interaction.kind === "BOARD"
              ? "≡"
              : interaction.kind === "NPC"
                ? "N"
                : interaction.kind === "SOUND"
                  ? "♫"
                  : "↗",
      x,
      y,
    );
  }
}
let loaded = new Map<string, HTMLImageElement>();
let loading: Promise<Map<string, HTMLImageElement>> | undefined;
export function loadOfficeImages(
  assetIds?: readonly string[],
): Promise<Map<string, HTMLImageElement>> {
  if (loading) return loading.then(() => loadOfficeImages(assetIds));
  const requested = assetIds
    ? [...new Set(assetIds)].flatMap((id) => {
        const asset = ASSETS_BY_ID.get(id);
        return asset ? [asset] : [];
      })
    : allOfficeAssets();
  const missing = requested.filter((asset) => !loaded.has(asset.id));
  if (!missing.length) return Promise.resolve(new Map(loaded));
  const batch = Promise.all(
    missing.map(
      (asset) =>
        new Promise<[string, HTMLImageElement]>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve([asset.id, img]);
          img.onerror = () =>
            reject(new Error(`에셋을 불러오지 못했어요: ${asset.name}`));
          img.src = asset.url;
        }),
    ),
  )
    .then((items) => {
      for (const [id, image] of items) loaded.set(id, image);
      return new Map(loaded);
    })
    .catch((error: unknown) => {
      throw error;
    });
  loading = batch.finally(() => {
    loading = undefined;
  });
  return loading;
}
export function paintMap(
  ctx: CanvasRenderingContext2D,
  map: MapDefinition,
  images: Map<string, HTMLImageElement>,
) {
  paintFloor(ctx, map);
  const objects = map.objects
    .map((object, index) => ({ object, index }))
    .sort((a, b) => {
      const ag = ASSETS_BY_ID.get(a.object.asset)?.layer === "GROUND",
        bg = ASSETS_BY_ID.get(b.object.asset)?.layer === "GROUND";
      return ag !== bg
        ? ag
          ? -1
          : 1
        : a.object.y - b.object.y || a.index - b.index;
    })
    .map(({ object }) => object);
  for (const object of objects.filter(
    (o) => ASSETS_BY_ID.get(o.asset)?.layer === "GROUND",
  ))
    draw(object);
  for (const wall of map.walls) paintWall(ctx, wall);
  for (const object of objects.filter(
    (o) => ASSETS_BY_ID.get(o.asset)?.layer !== "GROUND",
  ))
    draw(object);
  paintLabels(ctx, map);
  paintPortals(ctx, map);
  paintObjectInteractions(ctx, map);
  function draw(object: MapDefinition["objects"][number]) {
    const img = images.get(object.asset);
    if (!img) return;
    const asset = ASSETS_BY_ID.get(object.asset);
    if (!asset) return;
    const angle = objectAngle(object.direction);
    const width = (asset.width * object.scale) / 32;
    const height = (asset.height * object.scale) / 32;
    if (angle === 0) {
      const b = objectBounds(object);
      ctx.drawImage(
        img,
        b.x * TILE,
        b.y * TILE,
        b.width * TILE,
        b.height * TILE,
      );
      return;
    }
    ctx.save();
    ctx.translate(object.x * TILE, (object.y - height / 2) * TILE);
    ctx.rotate(angle);
    ctx.drawImage(
      img,
      (-width * TILE) / 2,
      (-height * TILE) / 2,
      width * TILE,
      height * TILE,
    );
    ctx.restore();
  }
}
