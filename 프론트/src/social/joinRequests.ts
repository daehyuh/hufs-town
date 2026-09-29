import { apiGet, apiMutate } from "../auth/client";

export type SocialJoinRequestStatus =
  | "PENDING"
  | "APPROVED"
  | "DECLINED"
  | "CANCELLED"
  | "EXPIRED";

export interface SocialJoinRequest {
  id: string;
  displayName: string;
  message: string;
  status: SocialJoinRequestStatus;
  requestedAt: number;
  expiresAt: number;
  destinationSpaceId: string | null;
  destinationSpaceName: string | null;
}

export interface SocialJoinRequestState {
  id: string;
  status: "PENDING";
  requestedAt: number;
  expiresAt: number;
}

export const listIncomingSocialJoinRequests = () =>
  apiGet<SocialJoinRequest[]>("me/join-requests");

export const listOutgoingSocialJoinRequests = () =>
  apiGet<SocialJoinRequest[]>("me/join-requests/outgoing");

export const createSocialJoinRequest = (
  conversationId: string,
  destinationSpaceId: string,
) =>
  apiMutate<SocialJoinRequestState>("me/join-requests", {
    conversationId,
    destinationSpaceId,
  });

export const respondToSocialJoinRequest = (
  requestId: string,
  decision: "APPROVE" | "DECLINE",
) =>
  apiMutate<{ status: "APPROVED" | "DECLINED" | "EXPIRED" }>(
    `me/join-requests/${encodeURIComponent(requestId)}/respond`,
    { decision },
  );

export const cancelSocialJoinRequest = (requestId: string) =>
  apiMutate<{ cancelled: true }>(
    `me/join-requests/${encodeURIComponent(requestId)}/cancel`,
  );
