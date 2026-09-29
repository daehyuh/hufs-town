import { MediaError } from "../game/WorldConnection";
import type { TranslationKey } from "../i18n/language";

const mediaErrorKeys: Record<string, TranslationKey> = {
  MEDIA_BLOCKED: "media.error.blocked",
  MEDIA_BUSY: "media.error.busy",
  MEDIA_DENIED: "media.error.denied",
  MEDIA_DISABLED: "media.error.disabled",
  MEDIA_INVALID: "media.error.generic",
  MEDIA_MODERATION_LOADING: "media.error.moderationLoading",
  MEDIA_PRESENCE: "media.error.presence",
  MEDIA_STALE: "media.error.stale",
  MEDIA_TIMEOUT: "media.error.timeout",
  MEDIA_UNAVAILABLE: "media.error.unavailable",
};

const deviceErrorKeys: Record<string, TranslationKey> = {
  NotAllowedError: "media.preflight.error.denied",
  NotFoundError: "media.preflight.error.missing",
  NotReadableError: "media.preflight.error.busy",
  OverconstrainedError: "media.preflight.error.constraint",
};

export function mediaErrorMessage(
  rawMessage: string,
  key: TranslationKey | undefined,
  translate: (key: TranslationKey) => string,
) {
  return key ? translate(key) : rawMessage;
}

export function mediaErrorTranslationKey(
  error: unknown,
  context?: "screen",
): TranslationKey {
  if (error instanceof MediaError)
    return mediaErrorKeys[error.code] ?? "media.error.generic";
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    if (context === "screen" && error.name === "NotAllowedError")
      return "media.error.screenDenied";
    return deviceErrorKeys[error.name] ?? "media.error.generic";
  }
  return "media.error.generic";
}
