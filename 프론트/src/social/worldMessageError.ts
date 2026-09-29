import type { TranslationKey } from "../i18n/language";

const errorKeys: Record<string, TranslationKey> = {
  DM_STALE: "chat.error.spaceChanged",
  GROUP_STALE: "chat.error.spaceChanged",
  DM_UNAVAILABLE: "chat.error.loginRequired",
  DM_BLOCKS_LOADING: "chat.error.blockSettings",
  DM_RATE_LIMIT: "chat.error.rateLimited",
  DM_TARGET_UNAVAILABLE: "chat.error.targetUnavailable",
  GROUP_MEMBER_UNAVAILABLE: "chat.error.targetUnavailable",
  DM_BLOCKED: "chat.error.blocked",
  GROUP_BLOCKED: "chat.error.blocked",
  DM_BUSY: "chat.error.busy",
  DM_SELF: "chat.error.self",
  GROUP_INVITE_SELF: "chat.error.self",
  GROUP_INVALID: "group.error.invalid",
  GROUP_REQUEST_CONFLICT: "chat.error.requestConflict",
  GROUP_INVITE_REQUEST_CONFLICT: "chat.error.requestConflict",
  GROUP_NOT_MEMBER: "chat.error.notMember",
  GROUP_NOT_FOUND: "chat.error.notFound",
  GROUP_MEMBERS_CHANGED: "group.error.membersChanged",
  GROUP_ALREADY_MEMBER: "group.error.alreadyMember",
  GROUP_FULL: "group.error.full",
  GROUP_INVITE_PENDING: "group.error.pending",
  DM_STORAGE_UNAVAILABLE: "chat.error.storage",
  DM_NOT_MEMBER: "chat.error.notMember",
  DM_NOT_FOUND: "chat.error.notFound",
  DM_MEMBERS_CHANGED: "group.error.membersChanged",
  DM_MESSAGE_NOT_FOUND: "chat.message.changed",
  DM_NOT_AUTHOR: "chat.error.notAuthor",
  DM_MUTATION_REQUEST_CONFLICT: "chat.error.requestConflict",
  DM_MESSAGE_DELETED: "chat.message.deleted",
  DM_EDIT_EXPIRED: "chat.message.editExpired",
  DM_INVALID_TEXT: "chat.error.invalidMessage",
  DM_REVISION_LIMIT: "chat.error.generic",
  DM_INVALID_ACTION: "chat.error.generic",
};

export function worldMessageErrorKey(code: string): TranslationKey {
  if (code.startsWith("GROUP_"))
    return errorKeys[code] ?? "group.error.generic";
  return errorKeys[code] ?? "chat.error.generic";
}
