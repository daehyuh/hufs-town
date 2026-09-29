import { apiGet, apiMutate } from "../auth/client";

export interface BlockedAccount {
  id: string;
  displayName: string;
  createdAt: string;
}

export const listBlockedAccounts = () =>
  apiGet<BlockedAccount[]>("me/blocks");

export const removeBlockedAccount = (id: string) =>
  apiMutate<{ removed: boolean }>(
    `me/blocks/${encodeURIComponent(id)}`,
    undefined,
    "DELETE",
  );
