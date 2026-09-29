import type { TranslationKey } from "../i18n/language";

const errorKeys: Record<string, TranslationKey> = {
  EVENT_STALE: "events.engagement.error.stateChanged",
  EVENT_INACTIVE: "events.engagement.error.inactive",
  EVENT_FORBIDDEN: "events.engagement.error.managerOnly",
  EVENT_ACTION: "events.engagement.error.invalidAction",
  QUESTION_RATE: "events.engagement.error.questionRate",
  QUESTION_EMPTY: "events.engagement.error.questionEmpty",
  QUESTION_LIMIT: "events.engagement.error.questionLimit",
  QUESTION_MISSING: "events.engagement.error.questionMissing",
  ANSWER_EMPTY: "events.engagement.error.answerEmpty",
  POLL_INVALID: "events.engagement.error.pollInvalid",
  POLL_ACTIVE: "events.engagement.error.pollActive",
  POLL_LIMIT: "events.engagement.error.pollLimit",
  POLL_INACTIVE: "events.engagement.error.pollInactive",
  POLL_OPTION: "events.engagement.error.pollOption",
  POLL_DUPLICATE: "events.engagement.error.pollDuplicate",
  SCAVENGER_ALREADY_STARTED: "events.engagement.error.huntAlreadyStarted",
  SCAVENGER_MAP_MISSING: "events.engagement.error.mapMissing",
  SCAVENGER_LAYOUT: "events.engagement.error.mapLayout",
  SCAVENGER_LIMIT: "events.engagement.error.huntLimit",
  SCAVENGER_INACTIVE: "events.engagement.error.huntInactive",
  SCAVENGER_MAP_CHANGED: "events.engagement.error.mapChanged",
  SCAVENGER_NPC_INVALID: "events.engagement.error.npcInvalid",
  SCAVENGER_TOO_FAR: "events.engagement.error.tooFar",
  SCAVENGER_LOCKED: "events.engagement.error.huntLocked",
  SCAVENGER_ITEM_INVALID: "events.engagement.error.itemInvalid",
  SCAVENGER_DUPLICATE: "events.engagement.error.itemCollected",
};

const successKeys: Record<string, TranslationKey> = {
  ASK_QUESTION: "events.engagement.success.questionAsked",
  ANSWER_QUESTION: "events.engagement.success.questionAnswered",
  CREATE_POLL: "events.engagement.success.pollStarted",
  CREATE_QUIZ: "events.engagement.success.pollStarted",
  VOTE_POLL: "events.engagement.success.voteRecorded",
  CLOSE_POLL: "events.engagement.success.pollClosed",
  START_SCAVENGER_HUNT: "events.engagement.success.huntStarted",
  STOP_SCAVENGER_HUNT: "events.engagement.success.huntStopped",
  SCAVENGER_TALK: "events.engagement.success.clueReceived",
  COLLECT_SCAVENGER_ITEM: "events.engagement.success.itemCollected",
};

export function eventEngagementMessageKey(ack: {
  accepted: boolean;
  action: string;
  code: string;
}): TranslationKey {
  return ack.accepted
    ? (successKeys[ack.action] ?? "events.engagement.success.generic")
    : (errorKeys[ack.code] ?? "events.engagement.error.generic");
}
