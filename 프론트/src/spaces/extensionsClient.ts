import { apiGet, apiMutate } from "../auth/client";

export type SpaceExtensionPermission = "SPACE_SUMMARY_READ";

export interface SpaceExtensionApp {
  id: string;
  name: string;
  launchUrl: string;
  origin: string;
  requestedPermissions: SpaceExtensionPermission[];
  approvedPermissions: SpaceExtensionPermission[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceExtensionContext {
  extensionId: string;
  space: {
    id: string;
    name: string;
    description: string;
    visibility: "PUBLIC" | "UNLISTED" | "PRIVATE";
    capacity: number;
    templateId: string;
  } | null;
  permissions: SpaceExtensionPermission[];
}

export interface SpaceExtensionDraft {
  name: string;
  launchUrl: string;
  requestedPermissions: SpaceExtensionPermission[];
}

function path(spaceId: string) {
  return `spaces/${encodeURIComponent(spaceId)}/extensions`;
}

export function listSpaceExtensions(spaceId: string) {
  return apiGet<SpaceExtensionApp[]>(path(spaceId));
}

export function registerSpaceExtension(
  spaceId: string,
  draft: SpaceExtensionDraft,
) {
  return apiMutate<SpaceExtensionApp>(path(spaceId), draft);
}

export function approveSpaceExtensionPermissions(
  spaceId: string,
  extensionId: string,
  approvedPermissions: SpaceExtensionPermission[],
) {
  return apiMutate<SpaceExtensionApp>(
    `${path(spaceId)}/${encodeURIComponent(extensionId)}/permissions`,
    { approvedPermissions },
    "PUT",
  );
}

export function setSpaceExtensionEnabled(
  spaceId: string,
  extensionId: string,
  enabled: boolean,
) {
  return apiMutate<SpaceExtensionApp>(
    `${path(spaceId)}/${encodeURIComponent(extensionId)}/${enabled ? "enable" : "disable"}`,
  );
}

export function getSpaceExtensionContext(spaceId: string, extensionId: string) {
  return apiGet<SpaceExtensionContext>(
    `${path(spaceId)}/${encodeURIComponent(extensionId)}/context`,
  );
}
