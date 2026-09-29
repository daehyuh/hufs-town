import { apiGet, apiMutate } from "../auth/client";
import type {
  FloorPatch,
  MapDefinition,
  MapLabel,
  MapObject,
  Portal,
  Wall,
  Zone,
} from "../generated/protocol";
export interface EditorDocument {
  version: number;
  map: MapDefinition;
  publishedRevision: string;
  issues: string[];
  publication?: PublicationStatus | null;
}
export interface PublicationStatus {
  revisionId: string;
  sequence: number;
  state: "PUBLISHING" | "APPLYING" | "APPLIED" | "DEGRADED";
  targetNodes: number;
  appliedNodes: number;
  pendingNodes: number;
  offlineNodes: number;
}
export interface Lease {
  token: string;
  fence: number;
  expiresAt: string;
  editor: EditorDocument;
}
export interface Credentials {
  token: string;
  fence: number;
  clientId: string;
}
export interface Revision {
  id: string;
  sequence: number;
  createdAt: string;
  reason: string;
  name: string;
}
export interface MapSummary {
  mapId: string;
  name: string;
  sortOrder: number;
  entry: boolean;
  version: number;
  publishedRevision: string;
  updatedAt: string;
}
export interface EditMode {
  mode: "LEGACY" | "COLLABORATIVE";
  sequence: number;
  version: number;
}
export type MapEditCollection =
  | "objects"
  | "floors"
  | "walls"
  | "zones"
  | "labels"
  | "portals";
export type MapEditEntity =
  | MapObject
  | FloorPatch
  | Wall
  | Zone
  | MapLabel
  | Portal;
export type MapEditAction =
  | {
      kind: "ENTITY_ADD";
      collection: MapEditCollection;
      entity: MapEditEntity;
      afterId?: string | null;
    }
  | {
      kind: "ENTITY_REPLACE";
      collection: MapEditCollection;
      entity: MapEditEntity;
    }
  | {
      kind: "ENTITY_DELETE";
      collection: MapEditCollection;
      entityId: string;
    }
  | {
      kind: "ENTITY_REORDER";
      collection: MapEditCollection;
      entityId: string;
      afterId: string | null;
    }
  | { kind: "MAP_FIELD_SET"; field: "name"; value: string }
  | { kind: "MAP_FIELD_SET"; field: "spawnX" | "spawnY"; value: number };
export interface MapEditOperationEvent {
  mapId: string;
  sequence: number;
  actorId: string;
  actorName: string;
  clientId: string;
  operationId: string;
  baseSequence: number;
  undoOfSequence: number | null;
  actions: MapEditAction[];
  createdAt: string;
}
export interface CollaborativeSync {
  editor: EditorDocument;
  sequence: number;
  operations: MapEditOperationEvent[];
  hasMore: boolean;
}
export interface CollaborativeOperationResult {
  editor: EditorDocument;
  sequence: number;
  operation: MapEditOperationEvent;
  duplicate: boolean;
}
export interface CollaborativePublication {
  editor: EditorDocument;
  editSequence: number;
  publishedEditSequence: number;
  duplicate: boolean;
}
export interface MapEditCommand {
  protocolVersion: 1;
  mapId: string;
  clientId: string;
  operationId: string;
  baseSequence: number;
  actions: MapEditAction[];
}
export interface MapEditSelection {
  collection: MapEditCollection;
  entityId: string;
}
export interface MapEditParticipant {
  userId: string;
  displayName: string;
  clientId: string;
  selection: MapEditSelection[];
  updatedAt: number;
}
const root = (id: string, mapId = id) => `spaces/${id}/maps/${mapId}`;
export const listMaps = (id: string) =>
  apiGet<MapSummary[]>(`spaces/${id}/maps`);
export const createMap = (id: string, name: string, templateId: string) =>
  apiMutate<MapSummary>(`spaces/${id}/maps`, { name, templateId });
export const cloneMap = (id: string, mapId: string, name: string) =>
  apiMutate<MapSummary>(`spaces/${id}/maps/${mapId}/clone`, { name });
export const deleteMap = (id: string, mapId: string) =>
  apiMutate<{ deleted: boolean }>(
    `spaces/${id}/maps/${mapId}`,
    undefined,
    "DELETE",
  );
export const setEntryMap = (id: string, mapId: string) =>
  apiMutate<MapSummary[]>(`spaces/${id}/maps/${mapId}/entry`, undefined, "PUT");
export const reorderMaps = (id: string, mapIds: string[]) =>
  apiMutate<MapSummary[]>(`spaces/${id}/maps/order`, { mapIds }, "PUT");
export const getPublished = (id: string, mapId = id) =>
  apiGet<MapDefinition>(`${root(id, mapId)}/published`);
export const getEditor = (id: string, mapId = id) =>
  apiGet<EditorDocument>(`${root(id, mapId)}/editor`);
export const editMode = (id: string, mapId = id) =>
  apiGet<EditMode>(`${root(id, mapId)}/edit/mode`);
export const enableCollaborativeEditing = (
  id: string,
  mapId: string,
  baseVersion: number,
) =>
  apiMutate<CollaborativeSync>(`${root(id, mapId)}/edit/enable`, {
    baseVersion,
  });
export const collaborativeSync = (
  id: string,
  mapId: string,
  afterSequence: number,
  limit = 250,
) =>
  apiGet<CollaborativeSync>(
    `${root(id, mapId)}/edit?afterSequence=${afterSequence}&limit=${limit}`,
  );
export const applyCollaborativeEdit = (id: string, command: MapEditCommand) =>
  apiMutate<CollaborativeOperationResult>(
    `${root(id, command.mapId)}/edit/operations`,
    command,
  );
export const undoCollaborativeEdit = (
  id: string,
  mapId: string,
  request: {
    protocolVersion: 1;
    mapId: string;
    clientId: string;
    operationId: string;
    baseSequence: number;
    undoSequence: number;
  },
) =>
  apiMutate<CollaborativeOperationResult>(
    `${root(id, mapId)}/edit/undo`,
    request,
  );
export const publishCollaborative = (
  id: string,
  mapId: string,
  clientId: string,
  operationId: string,
  baseSequence: number,
  baseVersion: number,
  revisionId?: string,
) =>
  apiMutate<CollaborativePublication>(`${root(id, mapId)}/edit/publish`, {
    clientId,
    operationId,
    baseSequence,
    baseVersion,
    ...(revisionId ? { revisionId } : {}),
  });
export const updateCollaborativePresence = (
  id: string,
  mapId: string,
  clientId: string,
  selection: MapEditSelection[],
) =>
  apiMutate<{ updated: boolean }>(`${root(id, mapId)}/edit/presence`, {
    clientId,
    selection,
  });
export const collaborativePresence = (
  id: string,
  mapId: string,
  clientId: string,
) =>
  apiGet<{ participants: MapEditParticipant[] }>(
    `${root(id, mapId)}/edit/presence?clientId=${encodeURIComponent(clientId)}`,
  );
export const removeCollaborativePresence = (
  id: string,
  mapId: string,
  clientId: string,
) =>
  apiMutate<{ removed: boolean }>(
    `${root(id, mapId)}/edit/presence?clientId=${encodeURIComponent(clientId)}`,
    undefined,
    "DELETE",
  );
export const acquire = (
  id: string,
  clientId: string,
  takeover = false,
  mapId = id,
) => apiMutate<Lease>(`${root(id, mapId)}/lease`, { clientId, takeover });
export const renew = (id: string, lease: Credentials, mapId = id) =>
  apiMutate<{ expiresAt: string }>(`${root(id, mapId)}/lease/renew`, lease);
export const release = (id: string, lease: Credentials, mapId = id) =>
  apiMutate(`${root(id, mapId)}/lease/release`, lease);
export const saveDraft = (
  id: string,
  lease: Credentials,
  baseVersion: number,
  operationId: string,
  map: MapDefinition,
  mapId = id,
) =>
  apiMutate<EditorDocument>(`${root(id, mapId)}/draft`, {
    lease,
    baseVersion,
    operationId,
    map,
  });
export const publish = (
  id: string,
  lease: Credentials,
  baseVersion: number,
  mapId = id,
) =>
  apiMutate<EditorDocument>(`${root(id, mapId)}/publish`, {
    lease,
    baseVersion,
  });
export const history = (id: string, mapId = id) =>
  apiGet<Revision[]>(`${root(id, mapId)}/history`);
export const publicationStatus = (
  id: string,
  mapId: string,
  revisionId: string,
) => apiGet<PublicationStatus>(`${root(id, mapId)}/publication/${revisionId}`);
export const restore = (
  id: string,
  lease: Credentials,
  baseVersion: number,
  revisionId: string,
  mapId = id,
) =>
  apiMutate<EditorDocument>(`${root(id, mapId)}/restore`, {
    lease,
    baseVersion,
    revisionId,
  });
