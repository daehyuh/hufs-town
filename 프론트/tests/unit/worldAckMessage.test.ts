import { expect, it } from "vitest";
import type {
  BlockAck,
  JoinRequestAck,
  JoinResult,
  PokeAck,
  PresenceAck,
  RoomActionAck,
  RoomKnockResult,
} from "../../src/generated/protocol";
import { translate } from "../../src/i18n/language";
import { worldAckMessage } from "../../src/social/worldAckMessage";

const english = (ack: Parameters<typeof worldAckMessage>[0]) =>
  worldAckMessage(
    ack,
    "en",
    (key, variables) => translate("en", key, variables),
    "Mina",
  );

it("localizes World acknowledgement messages instead of exposing Korean server text", () => {
  const acknowledgements: Array<Parameters<typeof worldAckMessage>[0]> = [
    ...[
      { status: "AVAILABLE", code: "" },
      { status: "AWAY", code: "" },
      { status: "DND", code: "" },
      { status: "AVAILABLE", code: "PRESENCE_STALE" },
      { status: "AVAILABLE", code: "PRESENCE_COOLDOWN" },
    ].map(
      ({ status, code }) =>
        ({
          type: "presenceAck",
          requestId: "presence",
          status: status as PresenceAck["status"],
          accepted: !code,
          code,
          message: "온라인 상태로 설정했어요.",
        }) satisfies PresenceAck,
    ),
    ...[
      "JOIN_STALE",
      "JOIN_BLOCKS_LOADING",
      "JOIN_PRESENCE",
      "JOIN_COOLDOWN",
      "JOIN_UNAVAILABLE",
      "JOIN_BLOCKED",
      "JOIN_PRIVATE",
      "JOIN_PENDING",
      "JOIN_BUSY",
    ].map(
      (code) =>
        ({
          type: "joinRequestAck",
          requestId: "join-request",
          targetId: "target",
          accepted: false,
          code,
          message: "같은 공간에서 합류 가능한 참가자를 찾지 못했어요.",
        }) satisfies JoinRequestAck,
    ),
    ...["JOIN_EXPIRED", "JOIN_DECLINED", "JOIN_PRIVATE", "JOIN_NO_SPACE"].map(
      (code) =>
        ({
          type: "joinResult",
          requestId: "join-result",
          targetId: "target",
          accepted: false,
          moved: false,
          destinationMapId: "",
          code,
          message: "합류 요청이 만료되었어요.",
        }) satisfies JoinResult,
    ),
    ...[
      "ROOM_KNOCKED",
      "ROOM_HOST_UNAVAILABLE",
      "ROOM_FULL",
      "ROOM_DECLINED",
      "ROOM_APPROVED",
      "ROOM_EJECTED",
      "ROOM_KNOCK_EXPIRED",
    ].map(
      (code) =>
        ({
          type: "roomKnockResult",
          requestId: "knock",
          zoneId: "meeting-room",
          accepted: code === "ROOM_APPROVED",
          code,
          message: "회의실 입장 노크가 만료됐어요.",
        }) satisfies RoomKnockResult,
    ),
    ...[
      "ROOM_NOT_FOUND",
      "ROOM_FORBIDDEN",
      "ROOM_CAPACITY_IN_USE",
      "ROOM_MEMBER_UNAVAILABLE",
      "ROOM_NO_EXIT",
    ].map(
      (code) =>
        ({
          type: "roomActionAck",
          requestId: "room-action",
          zoneId: "meeting-room",
          accepted: false,
          locked: false,
          capacity: 8,
          code,
          message: "회의실을 찾을 수 없어요.",
        }) satisfies RoomActionAck,
    ),
    ...[
      "POKE_BLOCKS_LOADING",
      "POKE_STALE",
      "POKE_STATUS",
      "POKE_COOLDOWN",
      "POKE_UNAVAILABLE",
      "POKE_TOO_FAR",
      "POKE_BLOCKED",
      "POKE_DISABLED",
      "POKE_TARGET_BUSY",
    ].map(
      (code) =>
        ({
          type: "pokeAck",
          requestId: "poke",
          targetId: "target",
          accepted: false,
          code,
          message: "지금은 그 사람을 찌를 수 없어요.",
        }) satisfies PokeAck,
    ),
    ...[
      "BLOCK_STALE",
      "BLOCK_UNAVAILABLE",
      "BLOCK_TARGET_UNAVAILABLE",
      "BLOCK_BUSY",
      "BLOCK_LIMIT",
      "BLOCK_STORAGE_UNAVAILABLE",
    ].map(
      (code) =>
        ({
          type: "blockAck",
          requestId: "block",
          targetId: "target",
          blocked: true,
          accepted: false,
          code,
          message: "차단 설정을 저장하지 못했어요.",
        }) satisfies BlockAck,
    ),
  ];

  for (const ack of acknowledgements)
    expect(english(ack), ack.type).not.toMatch(/[가-힣]/);

  expect(
    english({
      type: "pokeAck",
      requestId: "poke",
      targetId: "target",
      accepted: true,
      code: "",
      message: "Mina님을 콕 찔렀어요.",
    }),
  ).toContain("Mina");
  expect(
    worldAckMessage(
      {
        type: "pokeAck",
        requestId: "poke",
        targetId: "departed",
        accepted: true,
        code: "",
        message: "참가자를 찔렀어요.",
      },
      "en",
      (key, variables) => translate("en", key, variables),
    ),
  ).toBe("Poke sent.");
  expect(
    worldAckMessage(
      {
        type: "blockAck",
        requestId: "block",
        targetId: "departed",
        blocked: true,
        accepted: true,
        code: "",
        message: "차단했어요.",
      },
      "en",
      (key, variables) => translate("en", key, variables),
    ),
  ).toContain("Participant blocked");
});

it("keeps the original Korean detail for Korean users", () => {
  expect(
    worldAckMessage(
      {
        type: "roomKnockResult",
        requestId: "knock",
        zoneId: "meeting-room",
        accepted: false,
        code: "ROOM_FULL",
        message: "회의실 정원이 가득 찼어요.",
      },
      "ko",
      (key, variables) => translate("ko", key, variables),
    ),
  ).toBe("회의실 정원이 가득 찼어요.");
});
