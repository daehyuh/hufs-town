import Ajv from "ajv";
import schema from "../../../백엔드/contracts/world.schema.json";
import type { MapDefinition, Rect } from "../generated/protocol";
import type { TranslationKey } from "../i18n/language";
import {
  ASSETS_BY_ID,
  objectBounds,
  rebuildCollisions,
} from "../game/officeAssets";

// Use the same contract as the API; only assets already approved/registered for this space are accepted.
const ajv = new Ajv({ strict: false });
ajv.addSchema(schema);
const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/MapDefinition` });

type MapImportErrorCode =
  | "bounds"
  | "limit"
  | "duplicateId"
  | "invalidRect"
  | "overlappingZones"
  | "invalidAsset"
  | "invalidLabel"
  | "invalidPortal"
  | "invalidSchema";

const mapImportErrorKeys: Record<MapImportErrorCode, TranslationKey> = {
  bounds: "editor.asset.error.importBounds",
  limit: "editor.asset.error.importLimit",
  duplicateId: "editor.asset.error.importDuplicateId",
  invalidRect: "editor.asset.error.importRect",
  overlappingZones: "editor.asset.error.importOverlappingZones",
  invalidAsset: "editor.asset.error.importAsset",
  invalidLabel: "editor.asset.error.importLabelBounds",
  invalidPortal: "editor.asset.error.importPortal",
  invalidSchema: "editor.asset.error.importSchema",
};

export class MapImportError extends Error {
  readonly translationKey: TranslationKey;

  constructor(readonly code: MapImportErrorCode) {
    super(code);
    this.name = "MapImportError";
    this.translationKey = mapImportErrorKeys[code];
  }
}

function validRect(rect: Rect, map: MapDefinition) {
  return (
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width >= 0.125 &&
    rect.height >= 0.125 &&
    rect.x + rect.width <= map.width &&
    rect.y + rect.height <= map.height
  );
}

function validateMapSemantics(map: MapDefinition) {
  if (
    map.width < 16 ||
    map.width > 96 ||
    map.height < 16 ||
    map.height > 96 ||
    map.spawnX <= 0.25 ||
    map.spawnY <= 0.25 ||
    map.spawnX >= map.width - 0.25 ||
    map.spawnY >= map.height - 0.25
  )
    throw new MapImportError("bounds");

  if (
    map.objects.length > 500 ||
    map.walls.length > 256 ||
    map.floors.length < 1 ||
    map.floors.length > 256 ||
    map.zones.length > 32 ||
    map.labels.length > 100 ||
    (map.portals?.length ?? 0) > 64
  )
    throw new MapImportError("limit");

  const ids = [
    ...map.floors.map((item) => item.id),
    ...map.walls.map((item) => item.id),
    ...map.objects.map((item) => item.id),
    ...map.zones.map((item) => item.id),
    ...map.labels.map((item) => item.id),
    ...(map.portals ?? []).map((item) => item.id),
  ];
  if (
    ids.some((id) => !/^[A-Za-z0-9_-]{1,80}$/.test(id)) ||
    new Set(ids).size !== ids.length
  )
    throw new MapImportError("duplicateId");

  const rectangles: Rect[] = [
    ...map.floors.map((item) => item.bounds),
    ...map.walls.map((item) => item.bounds),
    ...map.zones.map((item) => item.bounds),
    ...(map.portals ?? []).map((item) => item.bounds),
  ];
  if (rectangles.some((rect) => !validRect(rect, map)))
    throw new MapImportError("invalidRect");

  const zones = map.zones;
  for (let first = 0; first < zones.length; first++) {
    for (let second = first + 1; second < zones.length; second++) {
      const a = zones[first].bounds;
      const b = zones[second].bounds;
      if (
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y
      )
        throw new MapImportError("overlappingZones");
    }
  }

  if (
    map.objects.some((object) => {
      const asset = ASSETS_BY_ID.get(object.asset);
      if (!asset || ![1, 2, 3].includes(object.scale)) return true;
      const bounds = objectBounds(object);
      return (
        !Number.isFinite(object.x) ||
        !Number.isFinite(object.y) ||
        bounds.x < 0 ||
        bounds.y < 0 ||
        bounds.x + bounds.width > map.width ||
        bounds.y + bounds.height > map.height
      );
    })
  )
    throw new MapImportError("invalidAsset");

  if (
    map.labels.some(
      (label) =>
        !Number.isFinite(label.x) ||
        !Number.isFinite(label.y) ||
        label.x < 0 ||
        label.y < 0 ||
        label.x > map.width ||
        label.y > map.height,
    )
  )
    throw new MapImportError("invalidLabel");

  if (
    (map.portals ?? []).some((portal) => {
      const spawnX = portal.targetSpawnX ?? Number.NaN;
      const spawnY = portal.targetSpawnY ?? Number.NaN;
      return (
        !/^[A-Za-z0-9_-]{1,80}$/.test(portal.targetSpaceId) ||
        (portal.targetMapId != null &&
          portal.targetMapId !== "" &&
          !/^[A-Za-z0-9_-]{1,80}$/.test(portal.targetMapId)) ||
        !Number.isFinite(spawnX) ||
        !Number.isFinite(spawnY) ||
        spawnX < 0 ||
        spawnY < 0 ||
        spawnX > 96 ||
        spawnY > 96
      );
    })
  )
    throw new MapImportError("invalidPortal");
}

export function importMap(input: unknown): MapDefinition {
  if (!validate(input)) throw new MapImportError("invalidSchema");
  const map = input as MapDefinition;
  validateMapSemantics(map);
  return rebuildCollisions(structuredClone(map));
}
