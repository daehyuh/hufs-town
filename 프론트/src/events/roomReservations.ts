import { apiGet, apiMutate } from "../auth/client";
import { createUuid } from "../ids";
import type { TranslationKey } from "../i18n/language";

export interface ReservableRoom {
  mapId: string;
  mapName: string;
  zoneId: string;
  zoneName: string;
  capacity: number | null;
}

export interface RoomReservation {
  id: string;
  mapId: string;
  zoneId: string;
  mapName: string;
  zoneName: string;
  roomAvailable: boolean;
  title: string;
  organizerName: string;
  mine: boolean;
  canEdit: boolean;
  startsAt: string;
  endsAt: string;
  cancelledAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoomReservationSnapshot {
  rooms: ReservableRoom[];
  reservations: RoomReservation[];
  canReserve: boolean;
}

export interface RoomReservationDraft {
  requestId: string;
  mapId: string;
  zoneId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  expectedUpdatedAt?: string;
}

type RoomReservationDraftErrorCode =
  | "invalidTime"
  | "endBeforeStart"
  | "duration";

const roomReservationDraftErrorKeys: Record<
  RoomReservationDraftErrorCode,
  TranslationKey
> = {
  invalidTime: "reservations.validation.time",
  endBeforeStart: "reservations.validation.order",
  duration: "reservations.validation.duration",
};

export class RoomReservationDraftError extends Error {
  readonly translationKey: TranslationKey;

  constructor(readonly code: RoomReservationDraftErrorCode) {
    super(code);
    this.name = "RoomReservationDraftError";
    this.translationKey = roomReservationDraftErrorKeys[code];
  }
}

export function canEditReservationMap(role?: string) {
  return role === "OWNER" || role === "ADMIN";
}

export function normalizeRoomReservationDraft(draft: RoomReservationDraft) {
  const start = new Date(draft.startsAt).getTime();
  const end = new Date(draft.endsAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end))
    throw new RoomReservationDraftError("invalidTime");
  if (end <= start) throw new RoomReservationDraftError("endBeforeStart");
  const duration = end - start;
  if (duration < 15 * 60_000 || duration > 8 * 60 * 60_000)
    throw new RoomReservationDraftError("duration");

  return {
    ...draft,
    requestId: draft.requestId || createUuid(),
    title: draft.title.trim(),
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
  };
}

const root = (spaceId: string) =>
  `spaces/${encodeURIComponent(spaceId)}/room-reservations`;

export const listRoomReservations = (spaceId: string) =>
  apiGet<RoomReservationSnapshot>(root(spaceId));

export const createRoomReservation = (
  spaceId: string,
  draft: RoomReservationDraft,
) => apiMutate<RoomReservation>(root(spaceId), draft);

export const updateRoomReservation = (
  spaceId: string,
  reservationId: string,
  draft: RoomReservationDraft,
) =>
  apiMutate<RoomReservation>(
    `${root(spaceId)}/${encodeURIComponent(reservationId)}`,
    draft,
    "PATCH",
  );

export const cancelRoomReservation = (spaceId: string, reservationId: string) =>
  apiMutate<RoomReservation>(
    `${root(spaceId)}/${encodeURIComponent(reservationId)}`,
    undefined,
    "DELETE",
  );
