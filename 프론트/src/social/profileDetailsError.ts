import type { TranslationKey } from "../i18n/language";

const PROFILE_DETAILS_ERROR_KEYS: Record<string, TranslationKey> = {
  PROFILE_STALE: "people.profile.error.stale",
  PROFILE_COOLDOWN: "people.profile.error.cooldown",
  PROFILE_UNAVAILABLE: "people.profile.error.unavailable",
  PROFILE_BLOCKS_LOADING: "people.profile.error.blocksLoading",
  PROFILE_BLOCKED: "people.profile.error.blocked",
};

export function profileDetailsErrorKey(code: string): TranslationKey {
  return PROFILE_DETAILS_ERROR_KEYS[code] ?? "people.profile.error";
}
