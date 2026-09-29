import type { MapDefinition } from "../generated/protocol";
import { rebuildCollisions } from "../game/officeAssets";
import type { MapEditAction, MapEditCollection, MapEditEntity } from "./client";

const collections: MapEditCollection[] = [
  "objects",
  "floors",
  "walls",
  "zones",
  "labels",
  "portals",
];

function cleanNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanNulls);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null && item !== undefined)
        .map(([key, item]) => [key, cleanNulls(item)]),
    );
  return value;
}

function entities(map: MapDefinition, collection: MapEditCollection) {
  const value = map[collection];
  return (value ?? []) as MapEditEntity[];
}

function actionEntityId(action: MapEditAction) {
  return "entity" in action
    ? action.entity.id
    : "entityId" in action
      ? action.entityId
      : "";
}

export function mapEditTouches(actions: MapEditAction[]) {
  const touches = new Set<string>();
  for (const action of actions) {
    if (action.kind === "MAP_FIELD_SET") {
      touches.add(`map:${action.field}`);
      continue;
    }
    const id = actionEntityId(action);
    touches.add(`entity:${id}`);
    if (
      action.kind === "ENTITY_REORDER" ||
      (action.kind === "ENTITY_ADD" && Object.hasOwn(action, "afterId"))
    ) {
      touches.add(`order:${action.collection}`);
      const afterId = action.afterId;
      if (afterId) touches.add(`ref:${afterId}`);
    }
  }
  return touches;
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(cleanNulls(left)) === JSON.stringify(cleanNulls(right));
}

function addAction(
  collection: MapEditCollection,
  entity: MapEditEntity,
  afterId: string | null | undefined,
): MapEditAction {
  const action: MapEditAction = {
    kind: "ENTITY_ADD",
    collection,
    entity: cleanNulls(entity) as MapEditEntity,
  };
  if (afterId !== undefined) action.afterId = afterId;
  return action;
}

export function diffMap(
  before: MapDefinition,
  after: MapDefinition,
): MapEditAction[] {
  const actions: MapEditAction[] = [];
  if (before.name !== after.name)
    actions.push({ kind: "MAP_FIELD_SET", field: "name", value: after.name });
  if (before.spawnX !== after.spawnX)
    actions.push({
      kind: "MAP_FIELD_SET",
      field: "spawnX",
      value: after.spawnX,
    });
  if (before.spawnY !== after.spawnY)
    actions.push({
      kind: "MAP_FIELD_SET",
      field: "spawnY",
      value: after.spawnY,
    });

  for (const collection of collections) {
    const oldItems = entities(before, collection);
    const newItems = entities(after, collection);
    const oldById = new Map(oldItems.map((item) => [item.id, item]));
    const newById = new Map(newItems.map((item) => [item.id, item]));
    const newIds = newItems.map((item) => item.id);

    for (const item of oldItems)
      if (!newById.has(item.id))
        actions.push({
          kind: "ENTITY_DELETE",
          collection,
          entityId: item.id,
        });

    const workingIds = oldItems
      .map((item) => item.id)
      .filter((id) => newById.has(id));
    for (let targetIndex = 0; targetIndex < newItems.length; targetIndex++) {
      const item = newItems[targetIndex];
      if (oldById.has(item.id)) continue;
      const previous = targetIndex === 0 ? null : newIds[targetIndex - 1];
      const anchorIndex = previous === null ? -1 : workingIds.indexOf(previous);
      if (previous !== null && anchorIndex < 0)
        throw new Error("Map edit order references a missing item.");
      const insertionIndex = anchorIndex + 1;
      const atEnd = insertionIndex === workingIds.length;
      actions.push(addAction(collection, item, atEnd ? undefined : previous));
      workingIds.splice(insertionIndex, 0, item.id);
    }

    for (const item of newItems) {
      const old = oldById.get(item.id);
      if (old && !same(old, item))
        actions.push({
          kind: "ENTITY_REPLACE",
          collection,
          entity: cleanNulls(item) as MapEditEntity,
        });
    }

    for (let targetIndex = 0; targetIndex < newIds.length; targetIndex++) {
      const id = newIds[targetIndex];
      if (workingIds[targetIndex] === id) continue;
      const currentIndex = workingIds.indexOf(id, targetIndex + 1);
      if (currentIndex < 0)
        throw new Error("Map edit order could not be resolved.");
      workingIds.splice(currentIndex, 1);
      const afterId = targetIndex === 0 ? null : newIds[targetIndex - 1];
      const anchorIndex = afterId === null ? -1 : workingIds.indexOf(afterId);
      if (afterId !== null && anchorIndex < 0)
        throw new Error("Map edit order references a missing item.");
      workingIds.splice(anchorIndex + 1, 0, id);
      actions.push({
        kind: "ENTITY_REORDER",
        collection,
        entityId: id,
        afterId,
      });
    }
  }
  return actions;
}

export function applyMapEditActions(
  source: MapDefinition,
  actions: MapEditAction[],
): MapDefinition {
  const map = structuredClone(source);
  for (const action of actions) {
    if (action.kind === "MAP_FIELD_SET") {
      if (action.field === "name") map.name = action.value;
      else if (action.field === "spawnX") map.spawnX = action.value;
      else map.spawnY = action.value;
      continue;
    }
    const items = entities(map, action.collection) as Array<MapEditEntity>;
    if (action.kind === "ENTITY_ADD") {
      const index = !Object.hasOwn(action, "afterId")
        ? items.length
        : action.afterId === null
          ? 0
          : items.findIndex((item) => item.id === action.afterId) + 1;
      if (index < 0 || items.some((item) => item.id === action.entity.id))
        throw new Error("Map edit add target is invalid.");
      items.splice(index, 0, structuredClone(action.entity));
    } else if (action.kind === "ENTITY_REPLACE") {
      const index = items.findIndex((item) => item.id === action.entity.id);
      if (index < 0) throw new Error("Map edit replace target is missing.");
      items[index] = structuredClone(action.entity);
    } else if (action.kind === "ENTITY_DELETE") {
      const index = items.findIndex((item) => item.id === action.entityId);
      if (index < 0) throw new Error("Map edit delete target is missing.");
      items.splice(index, 1);
    } else {
      if (action.entityId === action.afterId)
        throw new Error("Map edit cannot place an item after itself.");
      const index = items.findIndex((item) => item.id === action.entityId);
      if (index < 0) throw new Error("Map edit reorder target is missing.");
      const [item] = items.splice(index, 1);
      const anchor =
        action.afterId === null
          ? -1
          : items.findIndex((candidate) => candidate.id === action.afterId);
      if (action.afterId !== null && anchor < 0)
        throw new Error("Map edit reorder anchor is missing.");
      items.splice(anchor + 1, 0, item);
    }
  }
  return rebuildCollisions(map);
}
