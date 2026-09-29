import { expect, it, vi } from "vitest";

vi.stubGlobal("location", { pathname: "/", search: "" });
const {
  canEditReservationMap,
  normalizeRoomReservationDraft,
  RoomReservationDraftError,
} = await import("../../src/events/roomReservations");
type RoomReservationDraft =
  import("../../src/events/roomReservations").RoomReservationDraft;

const draft: RoomReservationDraft = {
  requestId: "same-logical-request",
  mapId: "main",
  zoneId: "meeting-room-a",
  title: "  팀 회의  ",
  startsAt: "2026-09-25T10:00",
  endsAt: "2026-09-25T11:00",
};

it("limits map editing actions to space owners and administrators", () => {
  expect(canEditReservationMap("OWNER")).toBe(true);
  expect(canEditReservationMap("ADMIN")).toBe(true);
  expect(canEditReservationMap("MEMBER")).toBe(false);
  expect(canEditReservationMap(undefined)).toBe(false);
});

it("keeps a reservation's idempotency key stable when retrying the same draft", () => {
  const first = normalizeRoomReservationDraft(draft);
  const retry = normalizeRoomReservationDraft(draft);

  expect(first.requestId).toBe("same-logical-request");
  expect(retry.requestId).toBe(first.requestId);
  expect(retry).toEqual(first);
  expect(first.title).toBe("팀 회의");
});

it("rejects invalid reservation duration before sending a request", () => {
  let thrown: unknown;
  try {
    normalizeRoomReservationDraft({
      ...draft,
      endsAt: "2026-09-25T10:10",
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(RoomReservationDraftError);
  expect(thrown).toMatchObject({
    code: "duration",
    translationKey: "reservations.validation.duration",
  });
});

it.each([
  ["invalidTime", { ...draft, startsAt: "not-a-time" }],
  ["endBeforeStart", { ...draft, endsAt: "2026-09-25T09:00" }],
] as const)("localizes the %s reservation validation error", (code, value) => {
  let thrown: unknown;
  try {
    normalizeRoomReservationDraft(value);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(RoomReservationDraftError);
  expect(thrown).toMatchObject({ code });
});
