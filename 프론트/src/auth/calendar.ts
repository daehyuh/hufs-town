import { apiGet, apiMutate } from "./client";

export interface GoogleCalendarConflict {
  sourceKind: "SCHEDULED_EVENT" | "ROOM_RESERVATION";
  sourceId: string;
  remoteEventId: string;
  detectedAt: string;
}

export interface GoogleCalendarStatus {
  enabled: boolean;
  connected: boolean;
  reconnectRequired: boolean;
  pendingCount: number;
  failedCount: number;
  conflicts: GoogleCalendarConflict[];
}

export function getGoogleCalendarStatus() {
  return apiGet<GoogleCalendarStatus>("me/calendar/google");
}

export async function startGoogleCalendarConnection() {
  return apiMutate<{ authorizationUrl: string }>("me/calendar/google/connect");
}

export function disconnectGoogleCalendar() {
  return apiMutate<{ connected: false }>(
    "me/calendar/google",
    undefined,
    "DELETE",
  );
}

export function applyHufsTownCalendarVersion(
  conflict: Pick<GoogleCalendarConflict, "sourceKind" | "sourceId">,
) {
  return apiMutate<{ queued: true }>(
    `me/calendar/google/conflicts/${conflict.sourceKind}/${encodeURIComponent(conflict.sourceId)}/apply-hufs-town`,
  );
}
