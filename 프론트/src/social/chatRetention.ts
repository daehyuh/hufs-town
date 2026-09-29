import { apiGet, apiMutate } from "../auth/client";

export interface ChatRetentionPolicy {
  retentionDays: number;
  source: "ENVIRONMENT" | "DATABASE";
  updatedAt: number | null;
  updatedBy: string | null;
}

export const getChatRetentionPolicy = () =>
  apiGet<ChatRetentionPolicy>("admin/settings/chat-retention");

export const updateChatRetentionPolicy = (retentionDays: number) =>
  apiMutate<ChatRetentionPolicy>(
    "admin/settings/chat-retention",
    { retentionDays },
    "PUT",
  );
