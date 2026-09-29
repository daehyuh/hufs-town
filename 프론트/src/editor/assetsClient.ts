import { apiGet, apiUpload, apiMutate } from "../auth/client";
import type { OfficeAsset } from "../game/officeAssets";

export interface UploadedSpaceAsset extends OfficeAsset {
  status: "PENDING" | "READY";
}

export interface PendingSpaceAsset {
  id: string;
  name: string;
  uploadedBy: string;
  width: number;
  height: number;
  uploadedAt: number;
  reviewContentUrl: string;
}

export function listSpaceAssets(spaceId: string) {
  return apiGet<OfficeAsset[]>(`spaces/${encodeURIComponent(spaceId)}/assets`);
}

export function uploadSpaceAsset(spaceId: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  return apiUpload<UploadedSpaceAsset>(`spaces/${encodeURIComponent(spaceId)}/assets`, form);
}

export function listPendingSpaceAssets(spaceId: string) {
  return apiGet<PendingSpaceAsset[]>(`spaces/${encodeURIComponent(spaceId)}/assets/review`);
}

export function approveSpaceAsset(spaceId: string, assetId: string) {
  return apiMutate<UploadedSpaceAsset>(
    `spaces/${encodeURIComponent(spaceId)}/assets/${encodeURIComponent(assetId)}/approve`,
  );
}

export function rejectSpaceAsset(spaceId: string, assetId: string) {
  return apiMutate<{ rejected: boolean }>(
    `spaces/${encodeURIComponent(spaceId)}/assets/${encodeURIComponent(assetId)}/reject`,
  );
}

export function deleteSpaceAsset(spaceId: string, assetId: string) {
  return apiMutate<{ deleted: boolean }>(
    `spaces/${encodeURIComponent(spaceId)}/assets/${encodeURIComponent(assetId)}`,
    undefined,
    "DELETE",
  );
}
