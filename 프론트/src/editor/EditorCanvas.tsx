import { useEffect, useRef, useState } from "react";
import { createUuid } from "../ids";
import type { MapDefinition, MapObject, Rect } from "../generated/protocol";
import {
  FLOOR_CELLS_PER_TILE,
  gridCellCenterToMapCoordinate,
  gridCellCount,
  mapCoordinateToCell,
} from "../mapGrid";
import { ASSETS_BY_ID, objectAngle, objectBounds } from "../game/officeAssets";
import { loadOfficeImages, paintMap, TILE } from "../game/renderMap";
import { canStand } from "../game/movement";
import { EDITOR_GRID_STEP, snapCoordinate } from "./grid";
import { useLanguage, type TranslationKey } from "../i18n/language";

export type Tool =
  | "select"
  | "object"
  | "floor"
  | "brush"
  | "fill"
  | "wall"
  | "zone"
  | "portal"
  | "spawn"
  | "label"
  | "erase";
export type Selection = {
  kind: "objects" | "walls" | "floors" | "zones" | "labels" | "portals";
  id: string;
};
export type RemoteSelection = {
  userId: string;
  displayName: string;
  color: string;
  selection: Selection[];
};
const selectionLayerKeys: Record<Selection["kind"], TranslationKey> = {
  objects: "editor.properties.layer.objects",
  walls: "editor.properties.layer.walls",
  floors: "editor.properties.layer.floors",
  zones: "editor.properties.layer.zones",
  labels: "editor.properties.layer.labels",
  portals: "editor.properties.layer.portals",
};
export interface EditorOptions {
  tool: Tool;
  asset: string;
  direction: NonNullable<MapObject["direction"]>;
  floor: MapDefinition["floors"][number]["material"];
  wall: MapDefinition["walls"][number]["material"];
  zoom: number;
  grid: boolean;
  snapToGrid: boolean;
  collisions: boolean;
  zones: boolean;
  lockedLayers: Record<Selection["kind"], boolean>;
}
const contains = (r: Rect, x: number, y: number) =>
  x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
export function selectionBounds(
  map: MapDefinition,
  selected: Selection,
): Rect | undefined {
  if (selected.kind === "objects") {
    const o = map.objects.find((o) => o.id === selected.id);
    return o ? objectBounds(o) : undefined;
  }
  if (selected.kind === "labels") {
    const label = map.labels.find((l) => l.id === selected.id);
    return label
      ? { x: label.x - 2, y: label.y - 0.35, width: 4, height: 0.7 }
      : undefined;
  }
  if (selected.kind === "portals")
    return (map.portals ?? []).find((item) => item.id === selected.id)?.bounds;
  return map[selected.kind].find((item) => item.id === selected.id)?.bounds;
}
function hit(
  map: MapDefinition,
  x: number,
  y: number,
  showZones: boolean,
  lockedLayers: Readonly<Record<Selection["kind"], boolean>>,
): Selection | undefined {
  for (const o of [...map.objects].sort((a, b) => b.y - a.y)) {
    if (lockedLayers.objects) continue;
    if (
      ASSETS_BY_ID.get(o.asset)?.layer !== "GROUND" &&
      contains(objectBounds(o), x, y)
    )
      return { kind: "objects", id: o.id };
  }
  for (const label of map.labels) {
    if (lockedLayers.labels) continue;
    if (Math.abs(label.x - x) < 2 && Math.abs(label.y - y) < 0.4)
      return { kind: "labels", id: label.id };
  }
  for (const portal of map.portals ?? []) {
    if (lockedLayers.portals) continue;
    if (contains(portal.bounds, x, y))
      return { kind: "portals", id: portal.id };
  }
  for (const kind of ["walls", ...(showZones ? ["zones"] : [])] as Array<
    "walls" | "zones"
  >) {
    if (lockedLayers[kind]) continue;
    for (const item of [...map[kind]].reverse())
      if (contains(item.bounds, x, y)) return { kind, id: item.id };
  }
  for (const o of [...map.objects].reverse()) {
    if (lockedLayers.objects) continue;
    if (
      ASSETS_BY_ID.get(o.asset)?.layer === "GROUND" &&
      contains(objectBounds(o), x, y)
    )
      return { kind: "objects", id: o.id };
  }
  for (const item of [...map.floors].reverse()) {
    if (lockedLayers.floors) continue;
    if (contains(item.bounds, x, y)) return { kind: "floors", id: item.id };
  }
  return undefined;
}
export function EditorCanvas({
  map,
  options,
  selected,
  remoteSelections,
  select,
  edit,
  writable,
  assetRevision,
  onError,
}: {
  map: MapDefinition;
  options: EditorOptions;
  selected: Selection[];
  remoteSelections?: RemoteSelection[];
  select: (items: Selection[]) => void;
  edit: (f: (m: MapDefinition) => MapDefinition) => void;
  writable: boolean;
  assetRevision: number;
  onError: (message: string) => void;
}) {
  const { language, t } = useLanguage();
  const locale = language === "en" ? "en-US" : "ko-KR";
  const formatCoordinate = (value: number) =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  const formatCount = (value: number) =>
    new Intl.NumberFormat(locale).format(value);
  const layerName = (kind: Selection["kind"]) => t(selectionLayerKeys[kind]);
  const lockedLayerError = (kind: Selection["kind"]) =>
    t("editor.canvas.error.layerLocked", { layer: layerName(kind) });
  const canvas = useRef<HTMLCanvasElement>(null),
    images = useRef<Map<string, HTMLImageElement>>(new Map());
  const assetIds = [
    ...new Set([...map.objects.map((object) => object.asset), options.asset]),
  ];
  const assetKey = assetIds.slice().sort().join("|");
  const [loaded, setLoaded] = useState(false),
    [hover, setHover] = useState<{ x: number; y: number }>(),
    [keyboardCursor, setKeyboardCursor] = useState(() => ({
      x: map.spawnX,
      y: map.spawnY,
    })),
    [keyboardAnchor, setKeyboardAnchor] = useState<
      { x: number; y: number } | undefined
    >(),
    [canvasFocused, setCanvasFocused] = useState(false),
    [keyboardMessage, setKeyboardMessage] = useState("");
  const drag = useRef<
    | {
        start: { x: number; y: number };
        end: { x: number; y: number };
        selection: Selection[];
        moved: boolean;
        brushCells?: Set<number>;
      }
    | undefined
  >(undefined);
  const [, redraw] = useState(0);
  useEffect(() => {
    let live = true;
    loadOfficeImages(assetIds)
      .then((value) => {
        if (live) {
          images.current = value;
          setLoaded(true);
        }
      })
      .catch(() => onError(t("editor.canvas.error.assetLoad")));
    return () => {
      live = false;
    };
  }, [assetRevision, assetKey, t]);
  useEffect(() => {
    if (!["floor", "wall", "zone", "portal"].includes(options.tool))
      setKeyboardAnchor(undefined);
  }, [options.tool, map.id]);
  useEffect(() => {
    const node = canvas.current;
    if (!node || !loaded) return;
    const ctx = node.getContext("2d")!;
    paintMap(ctx, map, images.current);
    if (options.grid) {
      ctx.lineWidth = 1;
      for (let x = 0; x <= map.width / EDITOR_GRID_STEP; x++) {
        const majorLine = x % 2 === 0;
        ctx.strokeStyle = majorLine ? "#46624925" : "#46624912";
        const position = x * EDITOR_GRID_STEP * TILE;
        ctx.beginPath();
        ctx.moveTo(position, 0);
        ctx.lineTo(position, map.height * TILE);
        ctx.stroke();
      }
      for (let y = 0; y <= map.height / EDITOR_GRID_STEP; y++) {
        const majorLine = y % 2 === 0;
        ctx.strokeStyle = majorLine ? "#46624925" : "#46624912";
        const position = y * EDITOR_GRID_STEP * TILE;
        ctx.beginPath();
        ctx.moveTo(0, position);
        ctx.lineTo(map.width * TILE, position);
        ctx.stroke();
      }
    }
    if (options.collisions) {
      ctx.fillStyle = "#ce534a55";
      for (const r of map.collisions)
        ctx.fillRect(r.x * TILE, r.y * TILE, r.width * TILE, r.height * TILE);
    }
    if (options.zones) {
      for (const z of map.zones) {
        ctx.fillStyle =
          z.kind === "PRIVATE"
            ? "#6088cc30"
            : z.kind === "SILENT"
              ? "#b794da30"
              : z.kind === "STAGE"
                ? "#e2b84b35"
                : "#72b49130";
        ctx.fillRect(
          z.bounds.x * TILE,
          z.bounds.y * TILE,
          z.bounds.width * TILE,
          z.bounds.height * TILE,
        );
        ctx.strokeStyle = z.kind === "STAGE" ? "#b68128" : "#6179b2";
        ctx.setLineDash(z.kind === "STAGE" ? [8, 4] : []);
        ctx.strokeRect(
          z.bounds.x * TILE,
          z.bounds.y * TILE,
          z.bounds.width * TILE,
          z.bounds.height * TILE,
        );
        ctx.setLineDash([]);
        ctx.fillStyle = z.kind === "STAGE" ? "#765015" : "#354d72";
        ctx.font = "bold 12px sans-serif";
        ctx.fillText(z.name, z.bounds.x * TILE + 8, z.bounds.y * TILE + 16);
      }
    }
    const spawnValid = canStand(map, map.spawnX, map.spawnY);
    ctx.strokeStyle = spawnValid ? "#3c8a75" : "#c43d34";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(map.spawnX * TILE, map.spawnY * TILE, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = spawnValid ? "#326b55" : "#a82d27";
    ctx.font = "bold 10px sans-serif";
    ctx.fillText(
      spawnValid ? "START" : "START!",
      map.spawnX * TILE - 18,
      map.spawnY * TILE + 26,
    );
    const previewPoint = canvasFocused ? keyboardCursor : hover;
    if (previewPoint && options.tool === "spawn" && writable) {
      const x = Math.max(0.5, Math.min(map.width - 0.5, previewPoint.x)),
        y = Math.max(0.5, Math.min(map.height - 0.5, previewPoint.y)),
        valid = canStand(map, x, y);
      ctx.strokeStyle = valid ? "#1c8a50" : "#c43d34";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(x * TILE, y * TILE, 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const item of selected) {
      const b = selectionBounds(map, item);
      if (b) {
        ctx.strokeStyle = "#4285f4";
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(
          b.x * TILE - 2,
          b.y * TILE - 2,
          b.width * TILE + 4,
          b.height * TILE + 4,
        );
        ctx.setLineDash([]);
      }
    }
    for (const editor of remoteSelections ?? []) {
      let labelPlaced = false;
      ctx.strokeStyle = editor.color;
      ctx.fillStyle = editor.color;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      for (const item of editor.selection) {
        const bounds = selectionBounds(map, {
          kind: item.kind,
          id: item.id,
        });
        if (!bounds) continue;
        ctx.strokeRect(
          bounds.x * TILE - 4,
          bounds.y * TILE - 4,
          bounds.width * TILE + 8,
          bounds.height * TILE + 8,
        );
        if (!labelPlaced) {
          ctx.setLineDash([]);
          ctx.font = "bold 11px sans-serif";
          ctx.fillText(
            editor.displayName,
            bounds.x * TILE,
            Math.max(12, bounds.y * TILE - 8),
          );
          ctx.setLineDash([4, 3]);
          labelPlaced = true;
        }
      }
      ctx.setLineDash([]);
    }
    const d = drag.current;
    if (d && ["floor", "wall", "zone", "portal"].includes(options.tool)) {
      const b = rectangle(d.start, d.end, options.tool === "wall");
      ctx.fillStyle = "#4285f440";
      ctx.fillRect(b.x * TILE, b.y * TILE, b.width * TILE, b.height * TILE);
      ctx.strokeStyle = "#4285f4";
      ctx.strokeRect(b.x * TILE, b.y * TILE, b.width * TILE, b.height * TILE);
    }
    if (
      keyboardAnchor &&
      canvasFocused &&
      ["floor", "wall", "zone", "portal"].includes(options.tool)
    ) {
      const b = rectangle(
        keyboardAnchor,
        keyboardCursor,
        options.tool === "wall",
      );
      ctx.fillStyle = "#4285f440";
      ctx.fillRect(b.x * TILE, b.y * TILE, b.width * TILE, b.height * TILE);
      ctx.strokeStyle = "#235fb7";
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x * TILE, b.y * TILE, b.width * TILE, b.height * TILE);
    }
    if (d?.brushCells && options.tool === "brush") {
      const columns = gridCellCount(map.width, FLOOR_CELLS_PER_TILE);
      ctx.fillStyle = "#4285f440";
      ctx.strokeStyle = "#4285f4";
      for (const index of d.brushCells) {
        const x = (index % columns) / FLOOR_CELLS_PER_TILE,
          y = Math.floor(index / columns) / FLOOR_CELLS_PER_TILE;
        ctx.fillRect(x * TILE, y * TILE, TILE / 2, TILE / 2);
        ctx.strokeRect(x * TILE, y * TILE, TILE / 2, TILE / 2);
      }
    }
    if (previewPoint && options.tool === "object" && writable) {
      const a = ASSETS_BY_ID.get(options.asset),
        img = images.current.get(options.asset);
      if (a && img) {
        const position = objectPosition(
          map,
          a.id,
          options.direction,
          previewPoint,
        );
        const width = (a.width * 2) / 32,
          height = (a.height * 2) / 32;
        ctx.globalAlpha = 0.6;
        ctx.save();
        ctx.translate(position.x * TILE, (position.y - height / 2) * TILE);
        ctx.rotate(objectAngle(options.direction));
        ctx.drawImage(
          img,
          (-width * TILE) / 2,
          (-height * TILE) / 2,
          width * TILE,
          height * TILE,
        );
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }
    if (canvasFocused && options.tool !== "object") {
      ctx.strokeStyle = "#174ea6";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(keyboardCursor.x * TILE - 8, keyboardCursor.y * TILE);
      ctx.lineTo(keyboardCursor.x * TILE + 8, keyboardCursor.y * TILE);
      ctx.moveTo(keyboardCursor.x * TILE, keyboardCursor.y * TILE - 8);
      ctx.lineTo(keyboardCursor.x * TILE, keyboardCursor.y * TILE + 8);
      ctx.stroke();
    }
    if (d?.moved && options.tool === "select") {
      ctx.strokeStyle = "#4285f4";
      ctx.setLineDash([8, 5]);
      for (const item of d.selection) {
        const b = selectionBounds(map, item);
        if (b)
          ctx.strokeRect(
            (b.x + d.end.x - d.start.x) * TILE,
            (b.y + d.end.y - d.start.y) * TILE,
            b.width * TILE,
            b.height * TILE,
          );
      }
      ctx.setLineDash([]);
    }
  });
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const r = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          map.width,
          snapCoordinate(
            ((event.clientX - r.left) / r.width) * map.width,
            options.snapToGrid,
          ),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          map.height,
          snapCoordinate(
            ((event.clientY - r.top) / r.height) * map.height,
            options.snapToGrid,
          ),
        ),
      ),
    };
  }
  function down(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    event.currentTarget.focus();
    const p = point(event);
    const item = hit(map, p.x, p.y, options.zones, options.lockedLayers);
    let selection = selected;
    if (options.tool === "select") {
      selection = item
        ? event.shiftKey
          ? selected.some((s) => s.id === item.id)
            ? selected.filter((s) => s.id !== item.id)
            : [...selected, item]
          : selected.some((s) => s.id === item.id)
            ? selected
            : [item]
        : [];
      select(selection);
    }
    setKeyboardCursor(p);
    if (!writable) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const brushCells = options.tool === "brush" ? new Set<number>() : undefined;
    if (brushCells) brushCells.add(floorCellIndex(p, map.width, map.height));
    drag.current = { start: p, end: p, selection, moved: false, brushCells };
    setHover(p);
  }
  function up(event: React.PointerEvent<HTMLCanvasElement>) {
    const d = drag.current;
    if (!d) return;
    drag.current = undefined;
    const p = point(event);
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (!writable) return;
    if (options.tool === "brush") {
      if (options.lockedLayers.floors) {
        onError(lockedLayerError("floors"));
        return;
      }
      const columns = gridCellCount(map.width, FLOOR_CELLS_PER_TILE),
        rows = gridCellCount(map.height, FLOOR_CELLS_PER_TILE),
        cells = new Uint8Array(columns * rows);
      if (d.brushCells)
        addBrushCells(d.brushCells, d.end, p, map.width, map.height);
      for (const cell of d.brushCells ?? [
        floorCellIndex(p, map.width, map.height),
      ])
        cells[cell] = 1;
      const bounds = compressFloorCells(cells, columns, rows);
      if (!bounds.length) return;
      if (map.floors.length + bounds.length > 256) {
        onError(
          t("editor.canvas.error.brushFloorLimit", { max: formatCount(256) }),
        );
        return;
      }
      const floors = bounds.map((rect) => ({
        id: createUuid(),
        material: options.floor,
        bounds: rect,
      }));
      edit((m) => ({ ...m, floors: [...m.floors, ...floors] }));
      select(
        floors.map((floor) => ({ kind: "floors" as const, id: floor.id })),
      );
      return;
    }
    if (options.tool === "fill") {
      if (options.lockedLayers.floors) {
        onError(lockedLayerError("floors"));
        return;
      }
      const bounds = floodFillFloor(map, p, options.floor);
      if (!bounds.length) return;
      if (map.floors.length + bounds.length > 256) {
        onError(
          t("editor.canvas.error.fillFloorLimit", { max: formatCount(256) }),
        );
        return;
      }
      const floors = bounds.map((rect) => ({
        id: createUuid(),
        material: options.floor,
        bounds: rect,
      }));
      edit((m) => ({ ...m, floors: [...m.floors, ...floors] }));
      select(
        floors.map((floor) => ({ kind: "floors" as const, id: floor.id })),
      );
      return;
    }
    const id = createUuid();
    if (options.tool === "object") {
      if (options.lockedLayers.objects) {
        onError(lockedLayerError("objects"));
        return;
      }
      const a = ASSETS_BY_ID.get(options.asset);
      if (!a) return;
      const { x, y } = objectPosition(map, a.id, options.direction, p);
      edit((m) => ({
        ...m,
        objects: [
          ...m.objects,
          { id, asset: a.id, x, y, scale: 2, direction: options.direction },
        ],
      }));
      select([{ kind: "objects", id }]);
    } else if (
      options.tool === "floor" ||
      options.tool === "wall" ||
      options.tool === "zone" ||
      options.tool === "portal"
    ) {
      const b = rectangle(d.start, p, options.tool === "wall");
      if (b.x + b.width > map.width || b.y + b.height > map.height) return;
      if (options.tool === "floor") {
        if (options.lockedLayers.floors) {
          onError(lockedLayerError("floors"));
          return;
        }
        edit((m) => ({
          ...m,
          floors: [...m.floors, { id, material: options.floor, bounds: b }],
        }));
        select([{ kind: "floors", id }]);
      }
      if (options.tool === "wall") {
        if (options.lockedLayers.walls) {
          onError(lockedLayerError("walls"));
          return;
        }
        edit((m) => ({
          ...m,
          walls: [...m.walls, { id, material: options.wall, bounds: b }],
        }));
        select([{ kind: "walls", id }]);
      }
      if (options.tool === "zone") {
        if (options.lockedLayers.zones) {
          onError(lockedLayerError("zones"));
          return;
        }
        edit((m) => ({
          ...m,
          zones: [
            ...m.zones,
            {
              id,
              name: t("editor.canvas.default.zone"),
              kind: "PRIVATE",
              bounds: b,
            },
          ],
        }));
        select([{ kind: "zones", id }]);
      }
      if (options.tool === "portal") {
        if (options.lockedLayers.portals) {
          onError(lockedLayerError("portals"));
          return;
        }
        edit((m) => ({
          ...m,
          portals: [
            ...(m.portals ?? []),
            {
              id,
              name: t("editor.canvas.default.portal"),
              bounds: b,
              targetSpaceId: m.id,
              targetMapId: m.id,
              targetSpawnX: 0,
              targetSpawnY: 0,
            },
          ],
        }));
        select([{ kind: "portals", id }]);
      }
    } else if (options.tool === "spawn") {
      edit((m) => ({
        ...m,
        spawnX: Math.max(0.5, Math.min(m.width - 0.5, p.x)),
        spawnY: Math.max(0.5, Math.min(m.height - 0.5, p.y)),
      }));
      select([]);
    } else if (options.tool === "label") {
      if (options.lockedLayers.labels) {
        onError(lockedLayerError("labels"));
        return;
      }
      edit((m) => ({
        ...m,
        labels: [
          ...m.labels,
          {
            id,
            text: t("editor.canvas.default.label"),
            x: p.x,
            y: p.y,
            link: "",
          },
        ],
      }));
      select([{ kind: "labels", id }]);
    } else if (options.tool === "erase") {
      const item = hit(map, p.x, p.y, options.zones, options.lockedLayers);
      if (item) {
        if (item.kind === "floors" && map.floors.length === 1) {
          onError(t("editor.error.floorRequired"));
          return;
        }
        edit((m) => ({
          ...m,
          [item.kind]: (m[item.kind] ?? []).filter((o) => o.id !== item.id),
        }));
        select([]);
      }
    } else if (options.tool === "select" && d.moved) {
      const dx = p.x - d.start.x,
        dy = p.y - d.start.y;
      const movableSelection = d.selection.filter(
        (selection) => !options.lockedLayers[selection.kind],
      );
      const bounds = movableSelection
        .map((s) => selectionBounds(map, s))
        .filter(Boolean) as Rect[];
      if (
        bounds.some(
          (b) =>
            b.x + dx < 0 ||
            b.y + dy < 0 ||
            b.x + b.width + dx > map.width ||
            b.y + b.height + dy > map.height,
        )
      ) {
        onError(t("editor.canvas.error.outOfBounds"));
        return;
      }
      edit((m) => {
        for (const s of movableSelection) {
          if (s.kind === "objects" || s.kind === "labels") {
            const item = (m[s.kind] ?? []).find((o) => o.id === s.id);
            if (item) {
              item.x += dx;
              item.y += dy;
            }
          } else {
            const item = (m[s.kind] ?? []).find((o) => o.id === s.id);
            if (item) {
              item.bounds.x += dx;
              item.bounds.y += dy;
            }
          }
        }
        return m;
      });
    }
    redraw((n) => n + 1);
  }
  function handleCanvasKeyDown(event: React.KeyboardEvent<HTMLCanvasElement>) {
    const placementLabel =
      options.tool === "floor"
        ? t("editor.inspector.kind.floor")
        : options.tool === "wall"
          ? t("editor.inspector.kind.wall")
          : options.tool === "zone"
            ? t("editor.inspector.kind.zone")
            : options.tool === "portal"
              ? t("editor.inspector.kind.portal")
              : t("editor.inspector.kind.zone");
    const rectangularTool = ["floor", "wall", "zone", "portal"].includes(
      options.tool,
    );
    if (event.key === "Escape" && rectangularTool && keyboardAnchor) {
      event.preventDefault();
      setKeyboardAnchor(undefined);
      setKeyboardMessage(
        t("editor.canvas.status.cancelPlacement", {
          placement: placementLabel,
        }),
      );
      return;
    }
    if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const step = event.shiftKey ? 0.1 : 0.5;
      const dx =
        event.key === "ArrowLeft"
          ? -step
          : event.key === "ArrowRight"
            ? step
            : 0;
      const dy =
        event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      if (options.tool === "select" && selected.length) {
        const movable = selected.filter(
          (item) => !options.lockedLayers[item.kind],
        );
        if (!movable.length) {
          onError(t("editor.canvas.error.noMovableSelection"));
          return;
        }
        const bounds = movable
          .map((item) => selectionBounds(map, item))
          .filter(Boolean) as Rect[];
        if (
          bounds.some(
            (item) =>
              item.x + dx < 0 ||
              item.y + dy < 0 ||
              item.x + item.width + dx > map.width ||
              item.y + item.height + dy > map.height,
          )
        ) {
          onError(t("editor.canvas.error.outOfBounds"));
          return;
        }
        edit((next) => {
          for (const selection of movable) {
            const item = (next[selection.kind] ?? []).find(
              (candidate) => candidate.id === selection.id,
            );
            if (!item) continue;
            if ("bounds" in item) {
              item.bounds.x += dx;
              item.bounds.y += dy;
            } else {
              item.x += dx;
              item.y += dy;
            }
          }
          return next;
        });
        setKeyboardMessage(
          t("editor.canvas.status.selectionMoved", {
            count: formatCount(movable.length),
            step: formatCoordinate(step),
          }),
        );
        return;
      }
      const next = {
        x: Math.max(
          0,
          Math.min(map.width, Math.round((keyboardCursor.x + dx) * 10) / 10),
        ),
        y: Math.max(
          0,
          Math.min(map.height, Math.round((keyboardCursor.y + dy) * 10) / 10),
        ),
      };
      setKeyboardCursor(next);
      if (rectangularTool && keyboardAnchor) {
        const bounds = rectangle(keyboardAnchor, next, options.tool === "wall");
        setKeyboardMessage(
          t("editor.canvas.status.resize", {
            placement: placementLabel,
            x: formatCoordinate(next.x),
            y: formatCoordinate(next.y),
            width: formatCoordinate(bounds.width),
            height: formatCoordinate(bounds.height),
          }),
        );
      } else {
        setKeyboardMessage(
          t("editor.canvas.status.cursor", {
            x: formatCoordinate(next.x),
            y: formatCoordinate(next.y),
          }),
        );
      }
      return;
    }
    if (event.key === "Enter" && rectangularTool) {
      event.preventDefault();
      if (!writable) return;
      const layer =
        options.tool === "floor"
          ? "floors"
          : options.tool === "wall"
            ? "walls"
            : options.tool === "portal"
              ? "portals"
              : "zones";
      const layerLabel =
        options.tool === "floor"
          ? layerName("floors")
          : options.tool === "wall"
            ? layerName("walls")
            : options.tool === "portal"
              ? layerName("portals")
              : layerName("zones");
      if (options.lockedLayers[layer]) {
        onError(lockedLayerError(layer));
        return;
      }
      if (!keyboardAnchor) {
        const anchor = {
          x: Math.max(0, Math.min(map.width - 0.5, keyboardCursor.x)),
          y: Math.max(0, Math.min(map.height - 0.5, keyboardCursor.y)),
        };
        setKeyboardAnchor(anchor);
        setKeyboardMessage(
          t("editor.canvas.status.anchor", {
            placement: placementLabel,
            x: formatCoordinate(anchor.x),
            y: formatCoordinate(anchor.y),
          }),
        );
        return;
      }
      const bounds = rectangle(
        keyboardAnchor,
        keyboardCursor,
        options.tool === "wall",
      );
      if (
        bounds.x + bounds.width > map.width ||
        bounds.y + bounds.height > map.height
      ) {
        onError(t("editor.canvas.error.outOfBounds"));
        return;
      }
      const id = createUuid();
      if (options.tool === "floor") {
        if (map.floors.length >= 256) {
          onError(
            t("editor.canvas.error.floorLimit", { max: formatCount(256) }),
          );
          return;
        }
        edit((next) => ({
          ...next,
          floors: [...next.floors, { id, material: options.floor, bounds }],
        }));
        select([{ kind: "floors", id }]);
      } else if (options.tool === "wall") {
        edit((next) => ({
          ...next,
          walls: [...next.walls, { id, material: options.wall, bounds }],
        }));
        select([{ kind: "walls", id }]);
      } else if (options.tool === "portal") {
        edit((next) => ({
          ...next,
          portals: [
            ...(next.portals ?? []),
            {
              id,
              name: t("editor.canvas.default.portal"),
              bounds,
              targetSpaceId: next.id,
              targetMapId: next.id,
              targetSpawnX: 0,
              targetSpawnY: 0,
            },
          ],
        }));
        select([{ kind: "portals", id }]);
      } else {
        edit((next) => ({
          ...next,
          zones: [
            ...next.zones,
            {
              id,
              name: t("editor.canvas.default.zone"),
              kind: "PRIVATE",
              bounds,
            },
          ],
        }));
        select([{ kind: "zones", id }]);
      }
      setKeyboardAnchor(undefined);
      setKeyboardMessage(
        t("editor.canvas.status.placed", {
          layer: layerLabel,
          x: formatCoordinate(bounds.x),
          y: formatCoordinate(bounds.y),
        }),
      );
      return;
    }
    if (event.key === "Enter" && options.tool === "spawn") {
      event.preventDefault();
      if (!writable) return;
      const x = Math.max(0.5, Math.min(map.width - 0.5, keyboardCursor.x)),
        y = Math.max(0.5, Math.min(map.height - 0.5, keyboardCursor.y));
      edit((next) => ({ ...next, spawnX: x, spawnY: y }));
      setKeyboardMessage(
        t(
          canStand(map, x, y)
            ? "editor.canvas.status.spawnAvailable"
            : "editor.canvas.status.spawnBlocked",
          { x: formatCoordinate(x), y: formatCoordinate(y) },
        ),
      );
      return;
    }
    if (event.key === "Enter" && options.tool === "label") {
      event.preventDefault();
      if (!writable) return;
      if (options.lockedLayers.labels) {
        onError(lockedLayerError("labels"));
        return;
      }
      const id = createUuid();
      const { x, y } = keyboardCursor;
      edit((next) => ({
        ...next,
        labels: [
          ...next.labels,
          { id, text: t("editor.canvas.default.label"), x, y, link: "" },
        ],
      }));
      select([{ kind: "labels", id }]);
      setKeyboardMessage(
        t("editor.canvas.status.labelPlaced", {
          x: formatCoordinate(x),
          y: formatCoordinate(y),
        }),
      );
      return;
    }
    if (event.key === "Enter" && options.tool === "erase") {
      event.preventDefault();
      if (!writable) return;
      const item = hit(
        map,
        keyboardCursor.x,
        keyboardCursor.y,
        options.zones,
        options.lockedLayers,
      );
      if (!item) {
        setKeyboardMessage(
          t("editor.canvas.status.nothingToErase", {
            x: formatCoordinate(keyboardCursor.x),
            y: formatCoordinate(keyboardCursor.y),
          }),
        );
        return;
      }
      if (item.kind === "floors" && map.floors.length === 1) {
        onError(t("editor.error.floorRequired"));
        return;
      }
      edit((next) => ({
        ...next,
        [item.kind]: (next[item.kind] ?? []).filter(
          (candidate) => candidate.id !== item.id,
        ),
      }));
      select([]);
      setKeyboardMessage(
        t("editor.canvas.status.deleted", { layer: layerName(item.kind) }),
      );
      return;
    }
    if (event.key !== "Enter" || options.tool !== "object") return;
    event.preventDefault();
    if (!writable) return;
    if (options.lockedLayers.objects) {
      onError(lockedLayerError("objects"));
      return;
    }
    const asset = ASSETS_BY_ID.get(options.asset);
    if (!asset) return;
    const id = createUuid();
    const { x, y } = objectPosition(
      map,
      asset.id,
      options.direction,
      keyboardCursor,
    );
    edit((next) => ({
      ...next,
      objects: [
        ...next.objects,
        { id, asset: asset.id, x, y, scale: 2, direction: options.direction },
      ],
    }));
    const selection = { kind: "objects" as const, id };
    select([selection]);
    setKeyboardMessage(
      t("editor.canvas.status.objectPlaced", {
        name: asset.name,
        x: formatCoordinate(x),
        y: formatCoordinate(y),
      }),
    );
  }
  return (
    <div className="editor-canvas-wrap">
      <p id="map-canvas-keyboard-help" className="sr-only">
        {t("editor.canvas.help")}
      </p>
      <canvas
        ref={canvas}
        width={map.width * TILE}
        height={map.height * TILE}
        style={{
          width: map.width * TILE * options.zoom,
          height: map.height * TILE * options.zoom,
          cursor: options.tool === "select" ? "default" : "crosshair",
        }}
        tabIndex={0}
        role="application"
        id="map-editor-canvas"
        aria-label={t("editor.canvas.aria")}
        aria-describedby="map-canvas-keyboard-help"
        data-testid="map-editor-canvas"
        onFocus={() => setCanvasFocused(true)}
        onBlur={() => setCanvasFocused(false)}
        onKeyDown={handleCanvasKeyDown}
        onPointerDown={down}
        onPointerMove={(event) => {
          const p = point(event);
          setHover(p);
          if (drag.current) {
            if (drag.current.brushCells && options.tool === "brush") {
              addBrushCells(
                drag.current.brushCells,
                drag.current.end,
                p,
                map.width,
                map.height,
              );
            }
            drag.current.end = p;
            drag.current.moved =
              drag.current.moved ||
              p.x !== drag.current.start.x ||
              p.y !== drag.current.start.y;
          }
        }}
        onPointerUp={up}
        onPointerCancel={() => {
          drag.current = undefined;
          redraw((n) => n + 1);
        }}
        onPointerLeave={() => {
          if (!drag.current) setHover(undefined);
        }}
      />
      <div className="editor-coordinate">
        {canvasFocused
          ? t("editor.canvas.cursor", {
              x: formatCoordinate(keyboardCursor.x),
              y: formatCoordinate(keyboardCursor.y),
            })
          : hover
            ? `${formatCoordinate(hover.x)}, ${formatCoordinate(hover.y)}`
            : options.snapToGrid
              ? t("editor.canvas.snap")
              : t("editor.canvas.precision")}{" "}
        · {formatCount(map.width)} × {formatCount(map.height)}
      </div>
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {keyboardMessage}
      </p>
    </div>
  );
}
function objectPosition(
  map: MapDefinition,
  asset: string,
  direction: NonNullable<MapObject["direction"]>,
  point: { x: number; y: number },
) {
  const bounds = objectBounds({
    id: "preview",
    asset,
    x: 0,
    y: 0,
    scale: 2,
    direction,
  });
  return {
    x: Math.max(
      -bounds.x,
      Math.min(map.width - bounds.x - bounds.width, point.x),
    ),
    y: Math.max(
      -bounds.y,
      Math.min(map.height - bounds.y - bounds.height, point.y),
    ),
  };
}
function rectangle(
  a: { x: number; y: number },
  b: { x: number; y: number },
  wall: boolean,
): Rect {
  const dx = Math.abs(b.x - a.x),
    dy = Math.abs(b.y - a.y);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: wall && dy > dx ? 0.5 : Math.max(0.5, dx),
    height: wall && dx >= dy ? 0.5 : Math.max(0.5, dy),
  };
}

function floodFillFloor(
  map: MapDefinition,
  point: { x: number; y: number },
  material: MapDefinition["floors"][number]["material"],
): Rect[] {
  const columns = gridCellCount(map.width, FLOOR_CELLS_PER_TILE),
    rows = gridCellCount(map.height, FLOOR_CELLS_PER_TILE),
    total = columns * rows;
  if (columns <= 0 || rows <= 0 || total > 40_000) return [];

  // Sample the visible, topmost floor at half-tile resolution. This keeps fill
  // behavior aligned with the editor's placement grid and the rendered layer order.
  const surfaces: Array<string | undefined> = new Array(total);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const centerX = gridCellCenterToMapCoordinate(x, FLOOR_CELLS_PER_TILE),
        centerY = gridCellCenterToMapCoordinate(y, FLOOR_CELLS_PER_TILE);
      for (let index = map.floors.length - 1; index >= 0; index--) {
        const floor = map.floors[index];
        if (contains(floor.bounds, centerX, centerY)) {
          surfaces[y * columns + x] = floor.material;
          break;
        }
      }
    }
  }

  const startX = Math.max(
      0,
      Math.min(columns - 1, mapCoordinateToCell(point.x, FLOOR_CELLS_PER_TILE)),
    ),
    startY = Math.max(
      0,
      Math.min(rows - 1, mapCoordinateToCell(point.y, FLOOR_CELLS_PER_TILE)),
    ),
    start = startY * columns + startX,
    source = surfaces[start];
  if (source === material) return [];

  const region = new Uint8Array(total),
    queue = new Int32Array(total);
  let head = 0,
    tail = 0;
  region[start] = 1;
  queue[tail++] = start;

  function blockedByWall(x: number, y: number, nextX: number, nextY: number) {
    const fromX = gridCellCenterToMapCoordinate(x, FLOOR_CELLS_PER_TILE),
      fromY = gridCellCenterToMapCoordinate(y, FLOOR_CELLS_PER_TILE),
      toX = gridCellCenterToMapCoordinate(nextX, FLOOR_CELLS_PER_TILE),
      toY = gridCellCenterToMapCoordinate(nextY, FLOOR_CELLS_PER_TILE),
      crossX = (fromX + toX) / 2,
      crossY = (fromY + toY) / 2;
    return map.walls.some(({ bounds }) =>
      nextX !== x
        ? bounds.x <= crossX &&
          bounds.x + bounds.width >= crossX &&
          fromY > bounds.y &&
          fromY < bounds.y + bounds.height
        : bounds.y <= crossY &&
          bounds.y + bounds.height >= crossY &&
          fromX > bounds.x &&
          fromX < bounds.x + bounds.width,
    );
  }

  while (head < tail) {
    const index = queue[head++],
      x = index % columns,
      y = Math.floor(index / columns);
    for (const [nextX, nextY] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ]) {
      if (nextX < 0 || nextY < 0 || nextX >= columns || nextY >= rows) continue;
      const next = nextY * columns + nextX;
      if (
        region[next] ||
        surfaces[next] !== source ||
        blockedByWall(x, y, nextX, nextY)
      )
        continue;
      region[next] = 1;
      queue[tail++] = next;
    }
  }

  return compressFloorCells(region, columns, rows);
}

function floorCellIndex(
  point: { x: number; y: number },
  width: number,
  height: number,
) {
  const columns = gridCellCount(width, FLOOR_CELLS_PER_TILE),
    rows = gridCellCount(height, FLOOR_CELLS_PER_TILE),
    x = Math.max(
      0,
      Math.min(columns - 1, mapCoordinateToCell(point.x, FLOOR_CELLS_PER_TILE)),
    ),
    y = Math.max(
      0,
      Math.min(rows - 1, mapCoordinateToCell(point.y, FLOOR_CELLS_PER_TILE)),
    );
  return y * columns + x;
}

function addBrushCells(
  cells: Set<number>,
  from: { x: number; y: number },
  to: { x: number; y: number },
  width: number,
  height: number,
) {
  const columns = gridCellCount(width, FLOOR_CELLS_PER_TILE),
    rows = gridCellCount(height, FLOOR_CELLS_PER_TILE),
    startX = Math.max(
      0,
      Math.min(columns - 1, mapCoordinateToCell(from.x, FLOOR_CELLS_PER_TILE)),
    ),
    startY = Math.max(
      0,
      Math.min(rows - 1, mapCoordinateToCell(from.y, FLOOR_CELLS_PER_TILE)),
    ),
    endX = Math.max(
      0,
      Math.min(columns - 1, mapCoordinateToCell(to.x, FLOOR_CELLS_PER_TILE)),
    ),
    endY = Math.max(
      0,
      Math.min(rows - 1, mapCoordinateToCell(to.y, FLOOR_CELLS_PER_TILE)),
    ),
    steps = Math.max(Math.abs(endX - startX), Math.abs(endY - startY), 1);
  let previousX = startX,
    previousY = startY;
  for (let step = 0; step <= steps; step++) {
    const ratio = step / steps,
      x = Math.round(startX + (endX - startX) * ratio),
      y = Math.round(startY + (endY - startY) * ratio);
    if (step > 0 && x !== previousX && y !== previousY)
      cells.add(previousY * columns + x);
    cells.add(y * columns + x);
    previousX = x;
    previousY = y;
  }
}

function compressFloorCells(
  cells: Uint8Array,
  columns: number,
  rows: number,
): Rect[] {
  const rectangles: Rect[] = [];
  let previous = new Map<string, Rect>();
  for (let y = 0; y < rows; y++) {
    const current = new Map<string, Rect>();
    for (let x = 0; x < columns; ) {
      if (!cells[y * columns + x]) {
        x++;
        continue;
      }
      const startX = x;
      while (x < columns && cells[y * columns + x]) x++;
      const key = `${startX}:${x - startX}`,
        existing = previous.get(key);
      if (existing && existing.y + existing.height === y / 2) {
        existing.height += 0.5;
        current.set(key, existing);
      } else {
        const rect = {
          x: startX / 2,
          y: y / 2,
          width: (x - startX) / 2,
          height: 0.5,
        };
        rectangles.push(rect);
        current.set(key, rect);
      }
    }
    previous = current;
  }
  return rectangles;
}
