import { apiGet, apiMutate } from "../auth/client";

export interface SpaceBoardPost {
  id: string;
  authorName: string;
  body: string;
  createdAt: number;
  own: boolean;
  deletable: boolean;
}

export interface WhiteboardPoint {
  x: number;
  y: number;
}

export interface WhiteboardStroke {
  id: string;
  color: string;
  width: number;
  points: WhiteboardPoint[];
}

export interface SpaceWhiteboard {
  revision: number;
  strokes: WhiteboardStroke[];
  updatedAt: number;
  canClear: boolean;
}

const path = (spaceId: string, boardId: string) =>
  `spaces/${encodeURIComponent(spaceId)}/boards/${encodeURIComponent(boardId)}/posts`;

export function listSpaceBoardPosts(spaceId: string, boardId: string) {
  return apiGet<SpaceBoardPost[]>(path(spaceId, boardId));
}

export function createSpaceBoardPost(
  spaceId: string,
  boardId: string,
  body: string,
) {
  return apiMutate<SpaceBoardPost>(path(spaceId, boardId), { body });
}

export function deleteSpaceBoardPost(
  spaceId: string,
  boardId: string,
  postId: string,
) {
  return apiMutate<{ deleted: boolean }>(
    `${path(spaceId, boardId)}/${encodeURIComponent(postId)}`,
    undefined,
    "DELETE",
  );
}

const whiteboardPath = (spaceId: string, boardId: string) =>
  `spaces/${encodeURIComponent(spaceId)}/boards/${encodeURIComponent(boardId)}/whiteboard`;

export function getSpaceWhiteboard(spaceId: string, boardId: string) {
  return apiGet<SpaceWhiteboard>(whiteboardPath(spaceId, boardId));
}

export function addWhiteboardStroke(
  spaceId: string,
  boardId: string,
  operationId: string,
  stroke: Omit<WhiteboardStroke, "id">,
  expectedRevision: number,
) {
  return apiMutate<SpaceWhiteboard>(
    `${whiteboardPath(spaceId, boardId)}/operations`,
    { operationId, kind: "ADD_STROKE", expectedRevision, stroke },
  );
}

export function clearSpaceWhiteboard(
  spaceId: string,
  boardId: string,
  operationId: string,
  expectedRevision: number,
) {
  return apiMutate<SpaceWhiteboard>(
    `${whiteboardPath(spaceId, boardId)}/operations`,
    { operationId, kind: "CLEAR", expectedRevision },
  );
}
