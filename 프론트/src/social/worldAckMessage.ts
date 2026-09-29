import type {
  BlockAck,
  DirectConversationResult,
  JoinRequestAck,
  JoinResult,
  PokeAck,
  PresenceAck,
  RoomActionAck,
  RoomKnockResult,
} from "../generated/protocol";
import type { Language, TranslationKey } from "../i18n/language";
import { worldMessageErrorKey } from "./worldMessageError";

type WorldAck =
  | PresenceAck
  | JoinRequestAck
  | JoinResult
  | RoomActionAck
  | RoomKnockResult
  | PokeAck
  | BlockAck
  | DirectConversationResult;
type Translate = (
  key: TranslationKey,
  variables?: Record<string, string | number>,
) => string;

function ackKey(ack: WorldAck): TranslationKey {
  switch (ack.type) {
    case "presenceAck":
      if (!ack.accepted)
        return ack.code === "PRESENCE_COOLDOWN"
          ? "people.presence.result.rateLimited"
          : "people.presence.result.stale";
      return ack.status === "AWAY"
        ? "people.presence.result.away"
        : ack.status === "DND"
          ? "people.presence.result.dnd"
          : "people.presence.result.available";
    case "joinRequestAck":
      if (ack.accepted) return "people.join.result.requestSent";
      switch (ack.code) {
        case "JOIN_STALE":
          return "people.join.result.stale";
        case "JOIN_BLOCKS_LOADING":
          return "people.join.result.blocksLoading";
        case "JOIN_PRESENCE":
          return "people.join.result.presence";
        case "JOIN_COOLDOWN":
          return "people.join.result.rateLimited";
        case "JOIN_UNAVAILABLE":
          return "people.join.result.unavailable";
        case "JOIN_BLOCKED":
          return "people.join.result.blocked";
        case "JOIN_PRIVATE":
          return "people.join.result.privateDenied";
        case "JOIN_PENDING":
          return "people.join.result.pending";
        case "JOIN_BUSY":
          return "people.join.result.busy";
        default:
          return "world.ack.failed";
      }
    case "joinResult":
      if (ack.accepted)
        return ack.moved
          ? "people.join.result.approvedNear"
          : "people.join.result.approvedMap";
      switch (ack.code) {
        case "JOIN_EXPIRED":
          return "people.join.result.expired";
        case "JOIN_DECLINED":
          return "people.join.result.declined";
        case "JOIN_PRIVATE":
          return "people.join.result.private";
        case "JOIN_NO_SPACE":
          return "people.join.result.noSpace";
        default:
          return "world.ack.failed";
      }
    case "roomKnockResult":
      switch (ack.code) {
        case "ROOM_KNOCKED":
          return "room.result.knocked";
        case "ROOM_HOST_UNAVAILABLE":
          return "room.result.hostUnavailable";
        case "ROOM_FULL":
          return "room.result.full";
        case "ROOM_DECLINED":
          return "room.result.declined";
        case "ROOM_APPROVED":
          return "room.result.approved";
        case "ROOM_EJECTED":
          return "room.result.ejected";
        case "ROOM_KNOCK_EXPIRED":
          return "room.result.expired";
        default:
          return "world.ack.failed";
      }
    case "roomActionAck":
      switch (ack.code) {
        case "ROOM_NOT_FOUND":
          return "room.result.notFound";
        case "ROOM_FORBIDDEN":
          return "room.result.hostOnly";
        case "ROOM_CAPACITY_IN_USE":
          return "room.result.capacityInUse";
        case "ROOM_MEMBER_UNAVAILABLE":
          return "room.result.memberUnavailable";
        case "ROOM_NO_EXIT":
          return "room.result.noExit";
        default:
          return "world.ack.failed";
      }
    case "pokeAck":
      if (ack.accepted) return "people.poke.result.sent";
      switch (ack.code) {
        case "POKE_BLOCKS_LOADING":
          return "people.poke.result.blocksLoading";
        case "POKE_STALE":
          return "people.poke.result.stale";
        case "POKE_STATUS":
          return "people.poke.result.status";
        case "POKE_UNAVAILABLE":
          return "people.poke.result.unavailable";
        case "POKE_TOO_FAR":
          return "people.poke.result.tooFar";
        case "POKE_BLOCKED":
          return "people.poke.result.blocked";
        case "POKE_DISABLED":
          return "people.poke.result.disabled";
        default:
          return "world.ack.failed";
      }
    case "blockAck":
      if (ack.accepted)
        return ack.blocked
          ? "people.block.result.blocked"
          : "people.block.result.unblocked";
      switch (ack.code) {
        case "BLOCK_STALE":
          return "people.block.result.stale";
        case "BLOCK_UNAVAILABLE":
          return "people.block.result.loginRequired";
        case "BLOCK_TARGET_UNAVAILABLE":
          return "people.block.result.targetUnavailable";
        case "BLOCK_BUSY":
          return "people.block.result.busy";
        case "BLOCK_LIMIT":
          return "people.block.result.limit";
        case "BLOCK_STORAGE_UNAVAILABLE":
          return "people.block.result.storage";
        default:
          return "world.ack.failed";
      }
    case "directConversationResult":
      return worldMessageErrorKey(ack.code);
  }
}

export function worldAckMessage(
  ack: WorldAck,
  language: Language,
  t: Translate,
  targetName = "",
) {
  if (language === "ko" && ack.message) return ack.message;
  let key = ackKey(ack);
  if (!targetName) {
    if (ack.type === "joinResult" && ack.code === "JOIN_DECLINED")
      key = "people.join.result.declinedGeneric";
    else if (ack.type === "pokeAck" && ack.accepted)
      key = "people.poke.result.sentGeneric";
    else if (ack.type === "blockAck" && ack.accepted)
      key = ack.blocked
        ? "people.block.result.blockedGeneric"
        : "people.block.result.unblockedGeneric";
  }
  return t(key, { name: targetName });
}
