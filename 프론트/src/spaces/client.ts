import { apiGet, apiMutate } from "../auth/client";
export type Visibility = "PUBLIC" | "UNLISTED" | "PRIVATE";
export type SpaceTemplateId =
  | "OFFICE"
  | "CAMPUS_SQUARE"
  | "STUDY_SPACE"
  | "MEETUP_HALL";
export interface Space {
  id: string;
  name: string;
  description: string;
  visibility: Visibility;
  capacity: number;
  templateId: SpaceTemplateId;
  role: "OWNER" | "ADMIN" | "MEMBER" | "";
  approvalRequired: boolean;
  allowedEmailDomains: string[];
  guestEntryEnabled: boolean;
  joinRequestStatus: "PENDING" | "APPROVED" | "REJECTED" | "";
  favorite: boolean;
  archived: boolean;
}
export interface GuestSpace {
  id: string;
  name: string;
  description: string;
  capacity: number;
}
export interface AdmissionTicket {
  ticket: string;
  expiresInSeconds: number;
  worldUrl?: string;
}
export type SpaceListView = "browse" | "mine" | "favorites" | "archived";
export interface SpacePage {
  items: Space[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}
export interface Invite {
  id: string;
  expiresAt: string;
  maxUses: number;
  useCount: number;
  revoked: boolean;
  targetUserId: string | null;
  targetDisplayName: string | null;
}
export interface SpaceMember {
  userId: string;
  displayName: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  joinedAt: number;
  lastVisitedAt: number | null;
}
export interface SpaceAccessBlock {
  userId: string;
  displayName: string;
  blockedAt: number;
}
export interface SpaceJoinRequest {
  id: string;
  userId: string;
  displayName: string;
  requestedAt: number;
}
export interface SpaceJoinRequestPage {
  items: SpaceJoinRequest[];
  nextCursor: string | null;
  hasMore: boolean;
}
export interface IncomingSpaceJoinRequest {
  spaceId: string;
  spaceName: string;
  request: SpaceJoinRequest;
}
export interface IncomingSpaceJoinRequestPage {
  items: IncomingSpaceJoinRequest[];
  nextCursor: string | null;
  hasMore: boolean;
}
export interface SpaceOwnershipTransfer {
  spaceId: string;
  targetUserId: string;
  targetDisplayName: string;
  requestedAt: number;
  expiresAt: number;
}
export interface IncomingOwnershipTransfer {
  spaceId: string;
  spaceName: string;
  ownerDisplayName: string;
  requestedAt: number;
  expiresAt: number;
}
export interface IncomingSpaceInvite {
  inviteId: string;
  spaceId: string;
  spaceName: string;
  inviterDisplayName: string;
  ownerDisplayName: string;
  createdAt: number;
  expiresAt: number;
}
export const visibilityLabels: Record<Visibility, string> = {
  PUBLIC: "공개",
  UNLISTED: "링크 공개",
  PRIVATE: "비공개",
};
export const listSpaces = (options: {
  query: string;
  view: SpaceListView;
  page: number;
  pageSize: number;
}) => {
  const params = new URLSearchParams({
    q: options.query,
    view: options.view,
    page: String(options.page),
    pageSize: String(options.pageSize),
  });
  return apiGet<SpacePage>(`spaces?${params}`);
};
export const getSpace = (id: string) =>
  apiGet<Space>(`spaces/${encodeURIComponent(id)}`);
export const setSpaceFavorite = (id: string, favorite: boolean) =>
  apiMutate<{ favorite: boolean }>(
    `spaces/${encodeURIComponent(id)}/favorite`,
    undefined,
    favorite ? "PUT" : "DELETE",
  );
export const createSpace = (draft: {
  name: string;
  description: string;
  visibility: Visibility;
  capacity: number;
  approvalRequired: boolean;
  allowedEmailDomains?: string[];
  guestEntryEnabled?: boolean;
  templateId: SpaceTemplateId;
}) => apiMutate<Space>("spaces", draft);
export const editSpace = (
  id: string,
  draft: {
    name: string;
    description: string;
    visibility: Visibility;
    approvalRequired: boolean;
    allowedEmailDomains: string[];
    guestEntryEnabled: boolean;
  },
) => apiMutate<Space>(`spaces/${id}`, draft, "PATCH");
export const archiveSpace = (id: string) =>
  apiMutate<{ archived: boolean }>(`spaces/${encodeURIComponent(id)}/archive`);
export const restoreSpace = (id: string) =>
  apiMutate<{ archived: boolean }>(`spaces/${encodeURIComponent(id)}/restore`);
export const cloneSpace = (id: string, name: string) =>
  apiMutate<Space>(`spaces/${encodeURIComponent(id)}/clone`, { name });
export const listInvites = (id: string) =>
  apiGet<Invite[]>(`spaces/${id}/invites`);
export const createInvite = (
  id: string,
  hours: number,
  maxUses: number,
  targetUserId?: string,
) =>
  apiMutate<{ invite: Invite; code: string }>(`spaces/${id}/invites`, {
    hours,
    maxUses,
    ...(targetUserId ? { targetUserId } : {}),
  });
export const revokeInvite = (id: string, inviteId: string) =>
  apiMutate(`spaces/${id}/invites/${inviteId}/revoke`);
export const listMembers = (id: string) =>
  apiGet<SpaceMember[]>(`spaces/${id}/members`);
export const setMemberRole = (
  id: string,
  userId: string,
  role: "ADMIN" | "MEMBER",
) =>
  apiMutate<{ role: "ADMIN" | "MEMBER" }>(
    `spaces/${id}/members/${encodeURIComponent(userId)}/role`,
    { role },
    "PATCH",
  );
export const listAccessBlocks = (id: string) =>
  apiGet<SpaceAccessBlock[]>(`spaces/${id}/access-blocks`);
export const kickMember = (id: string, userId: string) =>
  apiMutate<{ removed: boolean; accessBlocked: boolean }>(
    `spaces/${id}/members/${encodeURIComponent(userId)}`,
    undefined,
    "DELETE",
  );
export const unblockMember = (id: string, userId: string) =>
  apiMutate<{ unblocked: boolean }>(
    `spaces/${id}/access-blocks/${encodeURIComponent(userId)}`,
    undefined,
    "DELETE",
  );
export const listJoinRequests = (id: string, cursor?: string) =>
  apiGet<SpaceJoinRequestPage>(
    `spaces/${id}/join-requests${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
export const listIncomingJoinRequests = (cursor?: string) =>
  apiGet<IncomingSpaceJoinRequestPage>(
    `spaces/join-requests/incoming${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
export const requestJoin = (id: string) =>
  apiMutate<{ status: "PENDING" | "MEMBER"; requestedAt: number }>(
    `spaces/${id}/join-requests`,
  );
export const resolveJoinRequest = (
  id: string,
  requestId: string,
  decision: "APPROVE" | "REJECT",
) =>
  apiMutate<{ resolved: boolean }>(
    `spaces/${id}/join-requests/${encodeURIComponent(requestId)}/resolve`,
    { decision },
  );
export const listOwnershipTransfer = (id: string) =>
  apiGet<SpaceOwnershipTransfer[]>(
    `spaces/${encodeURIComponent(id)}/ownership-transfer`,
  );
export const requestOwnershipTransfer = (id: string, targetUserId: string) =>
  apiMutate<SpaceOwnershipTransfer>(
    `spaces/${encodeURIComponent(id)}/ownership-transfer`,
    { targetUserId },
  );
export const cancelOwnershipTransfer = (id: string) =>
  apiMutate<{ cancelled: boolean }>(
    `spaces/${encodeURIComponent(id)}/ownership-transfer`,
    undefined,
    "DELETE",
  );
export const listIncomingOwnershipTransfers = () =>
  apiGet<IncomingOwnershipTransfer[]>("spaces/ownership-transfers/incoming");
export const listIncomingSpaceInvites = () =>
  apiGet<IncomingSpaceInvite[]>("spaces/invitations/incoming");
export const acceptSpaceInvite = (inviteId: string) =>
  apiMutate<Space>(`spaces/invitations/${encodeURIComponent(inviteId)}/accept`);
export const declineSpaceInvite = (inviteId: string) =>
  apiMutate<{ declined: boolean }>(
    `spaces/invitations/${encodeURIComponent(inviteId)}/decline`,
  );
export const respondOwnershipTransfer = (
  id: string,
  decision: "ACCEPT" | "DECLINE",
) =>
  apiMutate<{ status: "ACCEPTED" | "DECLINED" | "EXPIRED" | "UNAVAILABLE" }>(
    `spaces/${encodeURIComponent(id)}/ownership-transfer/respond`,
    { decision },
  );
export const redeemInvite = (code: string) =>
  apiMutate<Space>("spaces/redeem", { code });
export async function requestAdmission(
  id: string,
  mapId?: string,
  portalSource?: {
    sourceSpaceId: string;
    sourceMapId: string;
    portalId: string;
  },
  resumeToken = "",
  reservationId = "",
) {
  return await apiMutate<{ ticket: string; worldUrl?: string }>(
    `spaces/${id}/admission`,
    {
      ...(mapId ? { mapId } : {}),
      ...(portalSource ?? {}),
      ...(resumeToken ? { resumeToken } : {}),
      ...(reservationId ? { reservationId } : {}),
    },
  );
}
export const getGuestSpace = (id: string) =>
  apiGet<GuestSpace>(`guest/spaces/${encodeURIComponent(id)}`);
export const requestGuestAdmission = (
  id: string,
  body: {
    name?: string;
    avatar?: number;
    skin?: string;
    clothing?: string;
    hair?: string;
    resumeToken?: string;
  },
) =>
  apiMutate<AdmissionTicket>(
    `guest/spaces/${encodeURIComponent(id)}/admission`,
    body,
  );
export const clearGuestSession = () =>
  apiMutate<{ cleared: boolean }>("guest/session", undefined, "DELETE");

// Fragments aren't sent to HTTP servers. Keep pending destinations only for this tab's SSO round-trip.
const fragment = new URLSearchParams(location.hash.slice(1));
for (const key of ["invite", "space"] as const) {
  const value = fragment.get(key);
  if (value && /^[A-Za-z0-9_-]{1,64}$/.test(value))
    sessionStorage.setItem(`hufs.pending.${key}`, value);
}
if (fragment.has("invite") || fragment.has("space"))
  history.replaceState(null, "", location.pathname + location.search);
export function pending(key: "invite" | "space") {
  return sessionStorage.getItem(`hufs.pending.${key}`) ?? "";
}
export function setPending(key: "invite" | "space", value: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value))
    throw new Error("잘못된 공간 이동 정보예요.");
  sessionStorage.setItem(`hufs.pending.${key}`, value);
}
export function clearPending(key: "invite" | "space") {
  sessionStorage.removeItem(`hufs.pending.${key}`);
}
export function inviteCode(input: string) {
  const value = input.trim();
  if (!value.includes("://")) return value;
  try {
    const url = new URL(value);
    return url.origin === location.origin
      ? (new URLSearchParams(url.hash.slice(1)).get("invite") ?? "")
      : "";
  } catch {
    return "";
  }
}
