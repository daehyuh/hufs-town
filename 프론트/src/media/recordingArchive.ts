import { apiGet, apiMutate } from "../auth/client";

export type RecordingArchiveSource =
  | "MICROPHONE"
  | "CAMERA"
  | "SCREEN"
  | "SCREEN_AUDIO";

export interface RecordingArchiveTrack {
  trackId: string;
  source: RecordingArchiveSource;
  bytes: number;
}

export interface RecordingArchiveEntry {
  recordingId: string;
  mapId: string;
  mapRevision: string;
  zoneId: string;
  startedAt: string | number;
  endedAt: string | number;
  retentionExpiresAt: string | number;
  sources: RecordingArchiveSource[];
  transcriptionStatus:
    | "NOT_REQUESTED"
    | "QUEUED"
    | "PROCESSING"
    | "READY"
    | "FAILED";
  tracks: RecordingArchiveTrack[];
  bytes: number;
  canDelete: boolean;
}

export interface RecordingArchiveResponse {
  recordings: RecordingArchiveEntry[];
  usedBytes: number;
  spaceUsedBytes?: number | null;
  spaceQuotaBytes?: number | null;
  transcriptionAvailable?: boolean;
}

export interface RecordingTranscriptSegment {
  startMs: number;
  endMs: number;
  speakerName: string;
  text: string;
}

export interface RecordingTranscript {
  recordingId: string;
  generatedAt: number;
  notice: string;
  segments: RecordingTranscriptSegment[];
}

export interface DeleteRecordingArchiveResponse {
  recordingId: string;
  deleted: boolean;
}

export function recordingArchivePath(spaceId: string) {
  return `spaces/${encodeURIComponent(spaceId)}/recordings`;
}

export function recordingTrackContentPath(
  spaceId: string,
  recordingId: string,
  trackId: string,
  download = false,
) {
  const path = `/api/v1/${recordingArchivePath(spaceId)}/${encodeURIComponent(recordingId)}/tracks/${encodeURIComponent(trackId)}/content`;
  return download ? `${path}?download=true` : path;
}

export function listRecordingArchive(spaceId: string) {
  return apiGet<RecordingArchiveResponse>(recordingArchivePath(spaceId));
}

export function getRecordingTranscript(spaceId: string, recordingId: string) {
  return apiGet<RecordingTranscript>(
    `${recordingArchivePath(spaceId)}/${encodeURIComponent(recordingId)}/transcript`,
  );
}

export function deleteRecordingArchiveEntry(
  spaceId: string,
  recordingId: string,
) {
  return apiMutate<DeleteRecordingArchiveResponse>(
    `${recordingArchivePath(spaceId)}/${encodeURIComponent(recordingId)}`,
    undefined,
    "DELETE",
  );
}
