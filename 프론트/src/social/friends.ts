import { apiGet, apiMutate } from "../auth/client";

export interface FriendAccount {
  userId: string;
  displayName: string;
  since: string;
  online: boolean;
}

export interface FriendRequest {
  id: string;
  userId: string;
  displayName: string;
  requestedAt: string;
}

export interface FriendOverview {
  friends: FriendAccount[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export type FriendSearchRelationship =
  | "FRIEND"
  | "INCOMING"
  | "OUTGOING"
  | "COOLDOWN"
  | "AVAILABLE"
  | "UNAVAILABLE";

export interface FriendSearchResult {
  userId: string;
  displayName: string;
  relationship: FriendSearchRelationship;
}

export interface FriendPreferences {
  allowFriendRequests: boolean;
  allowFriendNotifications: boolean;
  sharePresenceWithFriends: boolean;
}

export type FriendRelationship =
  | { state: "FRIEND" }
  | { state: "INCOMING"; requestId: string }
  | { state: "OUTGOING" }
  | { state: "NONE" };

export function friendRelationship(
  overview: FriendOverview | null,
  userId: string,
): FriendRelationship {
  if (!overview) return { state: "NONE" };
  if (overview.friends.some((friend) => friend.userId === userId))
    return { state: "FRIEND" };
  const incoming = overview.incoming.find(
    (request) => request.userId === userId,
  );
  if (incoming) return { state: "INCOMING", requestId: incoming.id };
  if (overview.outgoing.some((request) => request.userId === userId))
    return { state: "OUTGOING" };
  return { state: "NONE" };
}

export const listFriends = () => apiGet<FriendOverview>("me/friends");
export const searchFriends = (query: string) =>
  apiGet<FriendSearchResult[]>(
    `me/friends/search?q=${encodeURIComponent(query.trim())}`,
  );
export const getFriendPreferences = () =>
  apiGet<FriendPreferences>("me/friends/preferences");
export const saveFriendPreferences = (preferences: FriendPreferences) =>
  apiMutate<FriendPreferences>("me/friends/preferences", preferences, "PUT");
export const createFriendRequest = (targetUserId: string) =>
  apiMutate<{ id: string; status: "PENDING" | "ACCEPTED" }>(
    "me/friends/requests",
    { targetUserId },
  );
export const respondToFriendRequest = (
  requestId: string,
  decision: "ACCEPT" | "DECLINE",
) =>
  apiMutate<{ status: "ACCEPTED" | "DECLINED" }>(
    `me/friends/requests/${encodeURIComponent(requestId)}/respond`,
    { decision },
  );
export const cancelFriendRequest = (requestId: string) =>
  apiMutate<{ cancelled: boolean }>(
    `me/friends/requests/${encodeURIComponent(requestId)}`,
    undefined,
    "DELETE",
  );
export const removeFriend = (userId: string) =>
  apiMutate<{ removed: boolean }>(
    `me/friends/${encodeURIComponent(userId)}`,
    undefined,
    "DELETE",
  );

export function isAccountId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
