import type { ChatEvent } from "../generated/protocol";
import { apiGet, apiMutate } from "../auth/client";

export interface DirectConversation {
  conversationId: string;
  kind: "DIRECT" | "GROUP";
  displayName: string;
  participantCount: number;
  avatar: number | null;
  skin: string | null;
  clothing: string | null;
  hair: string | null;
  lastMessage: string | null;
  lastMessageAt: number | null;
  unreadCount: number;
  owner: boolean;
}

export interface GroupMember {
  memberId: string;
  displayName: string;
  avatar: number;
  skin: string;
  clothing: string;
  hair: string;
  owner: boolean;
  self: boolean;
  joinedAt: number;
}

export interface GroupInvitation {
  invitationId: string;
  conversationId: string;
  groupName: string;
  inviterName: string;
  createdAt: number;
  expiresAt: number;
}

export interface GroupInvitationChange {
  changed: boolean;
  accepted: boolean;
  conversationId: string;
  message: string;
}

export type DirectMessageEntry = Omit<ChatEvent, "type"> & {
  own: boolean;
  readByCount: number;
};

export interface DirectMessageRevision {
  revision: number;
  text: string;
  versionAt: number;
}

export const listDirectConversations = () =>
  apiGet<DirectConversation[]>("dms");

export const leaveGroupConversation = (conversationId: string) =>
  apiMutate<{ changed: boolean }>(
    `dms/${encodeURIComponent(conversationId)}/membership`,
    undefined,
    "DELETE",
  );

export const listGroupInvitations = () =>
  apiGet<GroupInvitation[]>("dms/group-invitations");

export const respondToGroupInvitation = (invitationId: string, accepted: boolean) =>
  apiMutate<GroupInvitationChange>(
    `dms/group-invitations/${encodeURIComponent(invitationId)}`,
    { accepted },
  );

export const listGroupMembers = (conversationId: string) =>
  apiGet<GroupMember[]>(`dms/${encodeURIComponent(conversationId)}/members`);

export const renameGroupConversation = (conversationId: string, name: string) =>
  apiMutate<{ changed: boolean; name: string }>(
    `dms/${encodeURIComponent(conversationId)}`,
    { name },
    "PATCH",
  );

export const removeGroupMember = (conversationId: string, memberId: string) =>
  apiMutate<{ changed: boolean }>(
    `dms/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(memberId)}`,
    undefined,
    "DELETE",
  );

export function listDirectMessages(conversationId: string, limit = 50, beforeId?: string) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (beforeId) query.set("beforeId", beforeId);
  return apiGet<DirectMessageEntry[]>(
    `dms/${encodeURIComponent(conversationId)}/messages?${query}`,
  );
}

export function listDirectMessageRevisions(conversationId: string, messageId: string) {
  return apiGet<DirectMessageRevision[]>(
    `dms/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/revisions`,
  );
}
