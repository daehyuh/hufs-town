import type { TranslationKey } from "../i18n/language";

const errorKeys: Record<string, TranslationKey> = {
  EVENT_STALE: "events.action.error.stateChanged",
  EVENT_INACTIVE: "events.action.error.inactive",
  EVENT_FORBIDDEN: "events.action.error.managerOnly",
  EVENT_TARGET_MISSING: "events.action.error.participantMissing",
  EVENT_SPEAKER_LIMIT: "events.action.error.speakerLimit",
  EVENT_ACTION: "events.action.error.invalidAction",
};

const successKeys: Record<string, TranslationKey> = {
  START: "events.action.success.started",
  STOP: "events.action.success.stopped",
  RAISE_HAND: "events.action.success.handRaised",
  LOWER_HAND: "events.action.success.handLowered",
  GRANT_SPEAKER: "events.action.success.speakerGranted",
  REVOKE_SPEAKER: "events.action.success.speakerRevoked",
};

export function eventActionMessageKey(ack: {
  accepted: boolean;
  action: string;
  code: string;
}): TranslationKey {
  return ack.accepted
    ? (successKeys[ack.action] ?? "events.action.success.generic")
    : (errorKeys[ack.code] ?? "events.action.error.generic");
}
