import { useEffect, useState } from "react";
import { Archive, Download, Play, Radio, Square, Trash2 } from "lucide-react";
import type {
  RoomRecordingAck,
  RoomRecordingRequest,
  RoomRecordingState,
} from "../generated/protocol";
import { Dialog } from "../components/Dialog";
import type { WorldConnection } from "../game/WorldConnection";
import { formatDate, useLanguage, type TranslationKey } from "../i18n/language";
import { AuthError } from "../auth/client";
import {
  deleteRecordingArchiveEntry,
  listRecordingArchive,
  recordingTrackContentPath,
  getRecordingTranscript,
  type RecordingArchiveEntry,
  type RecordingArchiveTrack,
  type RecordingTranscript,
} from "./recordingArchive";
import "./recording.css";

export const ROOM_RECORDING_SOURCES: Array<{
  id: RoomRecordingRequest["sources"][number];
  label: TranslationKey;
  detail: TranslationKey;
}> = [
  {
    id: "MICROPHONE",
    label: "recording.source.microphone",
    detail: "recording.source.microphoneDetail",
  },
  {
    id: "CAMERA",
    label: "recording.source.camera",
    detail: "recording.source.cameraDetail",
  },
  {
    id: "SCREEN",
    label: "recording.source.screen",
    detail: "recording.source.screenDetail",
  },
  {
    id: "SCREEN_AUDIO",
    label: "recording.source.screenAudio",
    detail: "recording.source.screenAudioDetail",
  },
];
export const DEFAULT_ROOM_RECORDING_SOURCES: RoomRecordingRequest["sources"] =
  [];

const liveStatuses: RoomRecordingState["status"][] = [
  "AWAITING_CONSENT",
  "STARTING",
  "RECORDING",
  "STOPPING",
];

export function isRoomRecordingLive(status: RoomRecordingState["status"]) {
  return liveStatuses.includes(status);
}

function sourceLabel(
  source: RoomRecordingRequest["sources"][number],
  t: (key: TranslationKey) => string,
) {
  const item = ROOM_RECORDING_SOURCES.find(
    (candidate) => candidate.id === source,
  );
  return item ? t(item.label) : source;
}

function statusLabel(
  status: RoomRecordingState["status"],
  t: (key: TranslationKey) => string,
) {
  const key: Record<RoomRecordingState["status"], TranslationKey> = {
    AWAITING_CONSENT: "recording.status.awaitingConsent",
    STARTING: "recording.status.starting",
    RECORDING: "recording.status.recording",
    STOPPING: "recording.status.stopping",
    STOPPED: "recording.status.stopped",
    DECLINED: "recording.status.declined",
    FAILED: "recording.status.failed",
    EXPIRED: "recording.status.expired",
  };
  return t(key[status]);
}

function decisionLabel(
  decision: RoomRecordingState["participants"][number]["decision"],
  t: (key: TranslationKey) => string,
) {
  const key: Record<
    RoomRecordingState["participants"][number]["decision"],
    TranslationKey
  > = {
    PENDING: "recording.decision.pending",
    ACCEPTED: "recording.decision.accepted",
    DECLINED: "recording.decision.declined",
    WITHDRAWN: "recording.decision.withdrawn",
  };
  return t(key[decision]);
}

function recordingErrorKey(code: string): TranslationKey {
  const keys: Record<string, TranslationKey> = {
    ROOM_RECORDING_FORBIDDEN: "recording.error.forbidden",
    ROOM_RECORDING_UNAVAILABLE: "recording.error.unavailable",
    ROOM_RECORDING_HOST_REQUIRED: "recording.error.hostRequired",
    ROOM_RECORDING_ACTIVE: "recording.error.active",
    ROOM_RECORDING_SOURCE_INVALID: "recording.error.sourceInvalid",
    ROOM_RECORDING_ROSTER_INVALID: "recording.error.rosterInvalid",
    ROOM_RECORDING_MEDIA_BLOCKED: "recording.error.mediaBlocked",
    ROOM_RECORDING_DOMAIN_CHANGED: "recording.error.domainChanged",
    ROOM_RECORDING_REQUEST_EXPIRED: "recording.error.requestExpired",
    ROOM_RECORDING_NOT_ACTIVE: "recording.error.notActive",
    ROOM_RECORDING_STALE: "recording.error.stale",
    ROOM_RECORDING_ACTION_INVALID: "recording.error.actionInvalid",
    RECORDING_SPACE_QUOTA: "recording.error.spaceQuota",
  };
  return keys[code] ?? "recording.error.generic";
}

function successNoticeKey(
  action: RoomRecordingRequest["action"] | "",
): TranslationKey {
  if (action === "START") return "recording.notice.startSent";
  if (action === "STOP") return "recording.notice.stopSent";
  if (action === "CONSENT") return "recording.notice.consentSaved";
  if (action === "WITHDRAW") return "recording.notice.withdrawSent";
  return "recording.notice.fallback";
}

function formatBytes(language: "ko" | "en", bytes: number) {
  const safeBytes = Math.max(0, bytes);
  if (safeBytes < 1024)
    return `${new Intl.NumberFormat(language === "en" ? "en-US" : "ko-KR").format(safeBytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = safeBytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${new Intl.NumberFormat(language === "en" ? "en-US" : "ko-KR", { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

function transcriptionStatusLabel(
  status: RecordingArchiveEntry["transcriptionStatus"],
  t: (key: TranslationKey) => string,
) {
  if (status === "QUEUED" || status === "PROCESSING")
    return t("recording.transcription.processing");
  if (status === "FAILED") return t("recording.transcription.failed");
  return "";
}

function trackIsAudio(track: RecordingArchiveTrack) {
  return track.source === "MICROPHONE" || track.source === "SCREEN_AUDIO";
}

export function RoomRecordingControls({
  connection,
  zoneId,
  roomName,
  isHost,
  selfId,
  online,
  recording,
  ack,
  spaceId = "",
  canViewArchive = false,
}: {
  connection: WorldConnection;
  zoneId: string;
  roomName: string;
  isHost: boolean;
  selfId: string;
  online: boolean;
  recording: RoomRecordingState | null;
  ack: RoomRecordingAck | null;
  spaceId?: string;
  canViewArchive?: boolean;
}) {
  const { language, t } = useLanguage();
  const [requestOpen, setRequestOpen] = useState(false);
  const [selectedSources, setSelectedSources] = useState<
    RoomRecordingRequest["sources"]
  >(DEFAULT_ROOM_RECORDING_SOURCES);
  const [transcribe, setTranscribe] = useState(false);
  const [transcriptionAvailable, setTranscriptionAvailable] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState("");
  const [pendingAction, setPendingAction] = useState<
    RoomRecordingRequest["action"] | ""
  >("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveLoadError, setArchiveLoadError] = useState(false);
  const [archiveActionError, setArchiveActionError] = useState<
    TranslationKey | ""
  >("");
  const [archiveEntries, setArchiveEntries] = useState<RecordingArchiveEntry[]>(
    [],
  );
  const [archiveUsedBytes, setArchiveUsedBytes] = useState(0);
  const [archiveSpaceUsedBytes, setArchiveSpaceUsedBytes] = useState<
    number | null
  >(null);
  const [archiveSpaceQuotaBytes, setArchiveSpaceQuotaBytes] = useState<
    number | null
  >(null);
  const [archiveRevision, setArchiveRevision] = useState(0);
  const [playingTrackId, setPlayingTrackId] = useState("");
  const [playbackErrorTrackId, setPlaybackErrorTrackId] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [transcript, setTranscript] = useState<RecordingTranscript | null>(
    null,
  );
  const [transcriptLoadingId, setTranscriptLoadingId] = useState("");
  const [transcriptErrorId, setTranscriptErrorId] = useState("");
  const [openTranscriptId, setOpenTranscriptId] = useState("");
  const current = recording?.zoneId === zoneId ? recording : null;
  const selfParticipant = current?.participants.find(
    (participant) => participant.playerId === selfId,
  );
  const consentNeeded =
    current?.status === "AWAITING_CONSENT" &&
    selfParticipant?.decision === "PENDING";
  const live = current ? isRoomRecordingLive(current.status) : false;
  const showRequestButton = isHost && !live;
  const archiveSpaceUsageWarning =
    archiveSpaceQuotaBytes !== null &&
    archiveSpaceQuotaBytes > 0 &&
    (archiveSpaceUsedBytes ?? 0) / archiveSpaceQuotaBytes >= 0.8;

  useEffect(() => {
    if (ack?.requestId !== pendingRequestId || !pendingRequestId) return;
    setPendingRequestId("");
    setPendingAction("");
    if (ack.accepted) {
      setError("");
      setNotice(t(successNoticeKey(pendingAction || "")));
      if (pendingAction === "START") setRequestOpen(false);
    } else {
      setNotice("");
      setError(t(recordingErrorKey(ack.code)));
    }
  }, [ack, pendingAction, pendingRequestId, t]);

  useEffect(() => {
    if (
      current &&
      isRoomRecordingLive(current.status) &&
      pendingAction === "START"
    )
      setRequestOpen(false);
    if (current?.status === "RECORDING") setNotice("");
    if (!current) {
      setRequestOpen(false);
      setSelectedSources([]);
      setNotice("");
      setError("");
    }
  }, [current, pendingAction]);

  useEffect(() => {
    if (!spaceId) {
      setTranscriptionAvailable(false);
      return;
    }
    let cancelled = false;
    void listRecordingArchive(spaceId)
      .then((result) => {
        if (!cancelled)
          setTranscriptionAvailable(result.transcriptionAvailable === true);
      })
      .catch(() => {
        if (!cancelled) setTranscriptionAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  useEffect(() => {
    if (!archiveOpen || !spaceId) return;
    let cancelled = false;
    let poll: number | undefined;
    setArchiveLoading(true);
    setArchiveLoadError(false);
    setArchiveActionError("");
    void listRecordingArchive(spaceId)
      .then((result) => {
        if (cancelled) return;
        setArchiveEntries(result.recordings);
        setArchiveUsedBytes(result.usedBytes);
        setArchiveSpaceUsedBytes(result.spaceUsedBytes ?? null);
        setArchiveSpaceQuotaBytes(result.spaceQuotaBytes ?? null);
        setTranscriptionAvailable(result.transcriptionAvailable === true);
        if (
          result.recordings.some((entry) =>
            ["QUEUED", "PROCESSING"].includes(entry.transcriptionStatus),
          )
        ) {
          poll = window.setTimeout(
            () => setArchiveRevision((revision) => revision + 1),
            4_000,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setArchiveLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setArchiveLoading(false);
      });
    return () => {
      cancelled = true;
      if (poll !== undefined) window.clearTimeout(poll);
    };
  }, [archiveOpen, archiveRevision, spaceId]);

  async function toggleTranscript(entry: RecordingArchiveEntry) {
    if (openTranscriptId === entry.recordingId) {
      setOpenTranscriptId("");
      return;
    }
    setOpenTranscriptId(entry.recordingId);
    setTranscriptLoadingId(entry.recordingId);
    setTranscriptErrorId("");
    try {
      setTranscript(await getRecordingTranscript(spaceId, entry.recordingId));
    } catch {
      setTranscriptErrorId(entry.recordingId);
    } finally {
      setTranscriptLoadingId("");
    }
  }

  async function deleteArchiveEntry(entry: RecordingArchiveEntry) {
    if (!entry.canDelete || deletingId) return;
    setDeletingId(entry.recordingId);
    setArchiveActionError("");
    try {
      const result = await deleteRecordingArchiveEntry(
        spaceId,
        entry.recordingId,
      );
      if (!result.deleted) throw new Error("delete-not-confirmed");
      setConfirmDeleteId("");
      setPlayingTrackId("");
      setArchiveRevision((revision) => revision + 1);
    } catch (caught) {
      setArchiveActionError(
        caught instanceof AuthError && caught.status === 403
          ? "recording.archive.deleteForbidden"
          : "recording.archive.error",
      );
    } finally {
      setDeletingId("");
    }
  }

  function archiveDate(value: string | number) {
    return formatDate(language, value, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  function send(
    action: RoomRecordingRequest["action"],
    recordingId = "",
    sources: RoomRecordingRequest["sources"] = [],
    accepted = false,
    shouldTranscribe = false,
  ) {
    if (pendingRequestId) return;
    const requestId = connection.requestRoomRecording(
      zoneId,
      action,
      recordingId,
      sources,
      accepted,
      shouldTranscribe,
    );
    if (!requestId) {
      setError(t("recording.error.connection"));
      setNotice("");
      return;
    }
    setPendingRequestId(requestId);
    setPendingAction(action);
    setError("");
    setNotice("");
  }

  function toggleSource(source: RoomRecordingRequest["sources"][number]) {
    setSelectedSources((selected) =>
      selected.includes(source)
        ? selected.filter((item) => item !== source)
        : [...selected, source],
    );
  }

  function toggleTranscription(enabled: boolean) {
    setTranscribe(enabled);
    if (enabled) {
      setSelectedSources((sources) =>
        sources.includes("MICROPHONE") ? sources : [...sources, "MICROPHONE"],
      );
    }
  }

  function transcriptTime(milliseconds: number) {
    const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainder = String(seconds % 60).padStart(2, "0");
    if (minutes < 60) return `${minutes}:${remainder}`;
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remainder}`;
  }

  return (
    <section
      className="room-recording-controls"
      aria-label={t("recording.label")}
    >
      {current && (
        <div
          className={"room-recording-status " + current.status.toLowerCase()}
          role="status"
          aria-live="polite"
        >
          <div className="room-recording-status-heading">
            <span
              className="room-recording-dot"
              aria-hidden="true"
              data-live={current.status === "RECORDING"}
            />
            <strong>{statusLabel(current.status, t)}</strong>
            {current.status === "RECORDING" && (
              <span className="room-recording-live-label">
                {t("recording.liveBadge")}
              </span>
            )}
          </div>
          <p>
            {current.sources
              .map((source) => sourceLabel(source, t))
              .join(" · ")}{" "}
            · {t("recording.retentionDays", { days: current.retentionDays })}
          </p>
          {current.transcribe && <p>{t("recording.transcription.notice")}</p>}
          {current.status === "FAILED" &&
            current.failureCode === "RECORDING_SPACE_QUOTA" && (
              <p className="room-recording-error" role="alert">
                {t("recording.error.spaceQuota")}
              </p>
            )}
          {current.status === "RECORDING" && current.startedAt > 0 && (
            <small>
              {t("recording.startedAt", {
                date: formatDate(language, current.startedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </small>
          )}
          {(current.status === "AWAITING_CONSENT" || live) && (
            <ul
              className="room-recording-participants"
              aria-label={t("recording.participants")}
            >
              {current.participants.map((participant) => (
                <li key={participant.playerId}>
                  <span>{participant.name}</span>
                  <span>{decisionLabel(participant.decision, t)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="room-recording-actions">
            {isHost && live && current.status !== "STOPPING" && (
              <button
                type="button"
                className="room-recording-stop"
                disabled={!online || !!pendingRequestId}
                onClick={() => send("STOP", current.recordingId, [], false)}
              >
                <Square size={14} aria-hidden="true" />
                {pendingAction === "STOP"
                  ? t("recording.action.stopPending")
                  : t("recording.action.stop")}
              </button>
            )}
            {live &&
              selfParticipant?.decision === "ACCEPTED" &&
              current.status !== "STOPPING" && (
                <button
                  type="button"
                  className="room-recording-withdraw"
                  disabled={!online || !!pendingRequestId}
                  onClick={() =>
                    send("WITHDRAW", current.recordingId, [], false)
                  }
                >
                  {pendingAction === "WITHDRAW"
                    ? t("recording.action.withdrawPending")
                    : t("recording.action.withdraw")}
                </button>
              )}
          </div>
        </div>
      )}
      {showRequestButton && (
        <button
          type="button"
          className="room-recording-request-open"
          aria-haspopup="dialog"
          disabled={!online}
          onClick={() => {
            setSelectedSources([]);
            setTranscribe(false);
            setError("");
            setNotice("");
            setRequestOpen(true);
          }}
        >
          <Radio size={14} aria-hidden="true" /> {t("recording.request.open")}
        </button>
      )}
      {canViewArchive && spaceId && (
        <button
          type="button"
          className="room-recording-archive-open"
          aria-haspopup="dialog"
          onClick={() => {
            setArchiveOpen(true);
            setArchiveLoadError(false);
            setArchiveActionError("");
            setPlayingTrackId("");
            setTranscript(null);
            setOpenTranscriptId("");
            setTranscriptErrorId("");
          }}
        >
          <Archive size={14} aria-hidden="true" /> {t("recording.archive.open")}
        </button>
      )}
      {notice && (
        <p className="room-recording-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="room-recording-error" role="alert">
          {error}
        </p>
      )}

      {requestOpen && (
        <Dialog
          title={t("recording.request.title", { roomName })}
          close={() => setRequestOpen(false)}
        >
          <div className="room-recording-dialog">
            <p>{t("recording.request.description")}</p>
            <fieldset>
              <legend>{t("recording.request.items")}</legend>
              {ROOM_RECORDING_SOURCES.map((source) => (
                <label key={source.id} className="room-recording-source-option">
                  <input
                    type="checkbox"
                    checked={selectedSources.includes(source.id)}
                    onChange={() => toggleSource(source.id)}
                    disabled={!online || !!pendingRequestId}
                  />
                  <span>
                    <strong>{t(source.label)}</strong>
                    <small>{t(source.detail)}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            {transcriptionAvailable ? (
              <label className="room-recording-source-option">
                <input
                  type="checkbox"
                  checked={transcribe}
                  onChange={(event) =>
                    toggleTranscription(event.target.checked)
                  }
                  disabled={!online || !!pendingRequestId}
                />
                <span>
                  <strong>{t("recording.transcription.option")}</strong>
                  <small>{t("recording.transcription.detail")}</small>
                </span>
              </label>
            ) : (
              <p className="room-recording-archive-state">
                {t("recording.transcription.notAvailable")}
              </p>
            )}
            {transcribe && (
              <p className="room-recording-transcript-notice">
                {t("recording.transcription.notice")}
              </p>
            )}
            <p className="room-recording-retention">
              {t("recording.request.retention", {
                days: current?.retentionDays ?? 30,
              })}
            </p>
            {error && (
              <p className="room-recording-error" role="alert">
                {error}
              </p>
            )}
            <div className="room-recording-dialog-actions">
              <button type="button" onClick={() => setRequestOpen(false)}>
                {t("recording.request.cancel")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  !online || !!pendingRequestId || selectedSources.length === 0
                }
                onClick={() =>
                  send("START", "", selectedSources, false, transcribe)
                }
              >
                {pendingAction === "START"
                  ? t("recording.request.pending")
                  : t("recording.request.send")}
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {consentNeeded && current && !requestOpen && (
        <Dialog
          title={t("recording.consent.title", { roomName })}
          close={() => setNotice(t("recording.consent.responseBefore"))}
        >
          <div className="room-recording-dialog room-recording-consent">
            <p>
              {t("recording.consent.description", {
                name: current.requestedByName,
                days: current.retentionDays,
              })}
            </p>
            {current.transcribe && (
              <p className="room-recording-transcript-notice">
                {t("recording.transcription.notice")}
              </p>
            )}
            <ul aria-label={t("recording.consent.items")}>
              {current.sources.map((source) => (
                <li key={source}>{sourceLabel(source, t)}</li>
              ))}
            </ul>
            <p>{t("recording.consent.wait")}</p>
            {error && (
              <p className="room-recording-error" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="room-recording-notice" role="status">
                {notice}
              </p>
            )}
            <div className="room-recording-dialog-actions">
              <button
                type="button"
                className="room-recording-decline"
                disabled={!online || !!pendingRequestId}
                onClick={() => send("CONSENT", current.recordingId, [], false)}
              >
                {pendingAction === "CONSENT"
                  ? t("recording.consent.pending")
                  : t("recording.consent.decline")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!online || !!pendingRequestId}
                onClick={() => send("CONSENT", current.recordingId, [], true)}
              >
                {t("recording.consent.allow")}
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {archiveOpen && (
        <Dialog
          title={t("recording.archive.title")}
          closeLabel={t("dialog.close")}
          close={() => {
            setArchiveOpen(false);
            setPlayingTrackId("");
            setPlaybackErrorTrackId("");
            setConfirmDeleteId("");
            setTranscript(null);
            setOpenTranscriptId("");
            setTranscriptErrorId("");
          }}
        >
          <div className="room-recording-dialog room-recording-archive-dialog">
            <p>{t("recording.archive.description")}</p>
            {archiveActionError && (
              <p className="room-recording-error" role="alert">
                {t(archiveActionError)}
              </p>
            )}
            {!archiveLoading &&
              !archiveLoadError &&
              archiveSpaceQuotaBytes === null &&
              archiveEntries.length > 0 && (
                <p className="room-recording-archive-usage">
                  {t("recording.archive.size", {
                    size: formatBytes(language, archiveUsedBytes),
                  })}
                </p>
              )}
            {!archiveLoading &&
              !archiveLoadError &&
              archiveSpaceQuotaBytes !== null &&
              archiveSpaceQuotaBytes > 0 && (
                <p
                  className={`room-recording-archive-usage${archiveSpaceUsageWarning ? " warning" : ""}`}
                  role={archiveSpaceUsageWarning ? "status" : undefined}
                >
                  {t("recording.archive.spaceUsage", {
                    used: formatBytes(language, archiveSpaceUsedBytes ?? 0),
                    quota: formatBytes(language, archiveSpaceQuotaBytes),
                  })}
                  {archiveSpaceUsageWarning && (
                    <strong>{t("recording.archive.spaceWarning")}</strong>
                  )}
                </p>
              )}
            {archiveLoading && (
              <p
                className="room-recording-archive-state"
                role="status"
                aria-live="polite"
              >
                {t("recording.archive.loading")}
              </p>
            )}
            {archiveLoadError && (
              <div className="room-recording-archive-state" role="alert">
                <p className="room-recording-error">
                  {t("recording.archive.error")}
                </p>
                <button
                  type="button"
                  onClick={() => setArchiveRevision((revision) => revision + 1)}
                >
                  {t("recording.archive.retry")}
                </button>
              </div>
            )}
            {!archiveLoading &&
              !archiveLoadError &&
              archiveEntries.length === 0 && (
                <p className="room-recording-archive-state" role="status">
                  {t("recording.archive.empty")}
                </p>
              )}
            {!archiveLoading &&
              !archiveLoadError &&
              archiveEntries.length > 0 && (
                <ul
                  className="room-recording-archive-list"
                  aria-label={t("recording.archive.title")}
                >
                  {archiveEntries.map((entry) => (
                    <li
                      className="room-recording-archive-entry"
                      key={entry.recordingId}
                    >
                      <div className="room-recording-archive-heading">
                        <strong>
                          {entry.sources
                            .map((source) => sourceLabel(source, t))
                            .join(" · ")}
                        </strong>
                        <span>
                          {t("recording.archive.size", {
                            size: formatBytes(language, entry.bytes),
                          })}
                        </span>
                      </div>
                      <small>
                        {t("recording.archive.room", { zoneId: entry.zoneId })}
                      </small>
                      <small>
                        {t("recording.archive.started", {
                          date: archiveDate(entry.startedAt),
                        })}
                      </small>
                      <small>
                        {t("recording.archive.expires", {
                          date: archiveDate(entry.retentionExpiresAt),
                        })}
                      </small>
                      {entry.transcriptionStatus !== "NOT_REQUESTED" && (
                        <div className="room-recording-transcript-actions">
                          {entry.transcriptionStatus === "READY" ? (
                            <button
                              type="button"
                              onClick={() => void toggleTranscript(entry)}
                            >
                              {openTranscriptId === entry.recordingId
                                ? t("recording.transcription.close")
                                : t("recording.transcription.ready")}
                            </button>
                          ) : (
                            <small role="status">
                              {transcriptionStatusLabel(
                                entry.transcriptionStatus,
                                t,
                              )}
                            </small>
                          )}
                          {transcriptLoadingId === entry.recordingId && (
                            <small role="status">
                              {t("recording.archive.loading")}
                            </small>
                          )}
                          {transcriptErrorId === entry.recordingId && (
                            <small
                              className="room-recording-error"
                              role="alert"
                            >
                              {t("recording.archive.error")}
                            </small>
                          )}
                        </div>
                      )}
                      {openTranscriptId === entry.recordingId &&
                        transcript?.recordingId === entry.recordingId && (
                          <section
                            className="room-recording-transcript"
                            aria-label={t("recording.transcription.ready")}
                          >
                            <p>{transcript.notice}</p>
                            {transcript.segments.length === 0 ? (
                              <p>{t("recording.transcription.empty")}</p>
                            ) : (
                              <ol>
                                {transcript.segments.map((segment, index) => (
                                  <li key={`${segment.startMs}-${index}`}>
                                    <time>
                                      {transcriptTime(segment.startMs)}
                                    </time>
                                    <strong>{segment.speakerName}</strong>
                                    <span>{segment.text}</span>
                                  </li>
                                ))}
                              </ol>
                            )}
                          </section>
                        )}
                      <ul className="room-recording-archive-tracks">
                        {entry.tracks.map((track) => {
                          const contentPath = recordingTrackContentPath(
                            spaceId,
                            entry.recordingId,
                            track.trackId,
                          );
                          const audio = trackIsAudio(track);
                          const isPlaying = playingTrackId === track.trackId;
                          return (
                            <li key={track.trackId}>
                              <div className="room-recording-archive-track-row">
                                <span>
                                  {sourceLabel(track.source, t)} ·{" "}
                                  {formatBytes(language, track.bytes)}
                                </span>
                                <div>
                                  <button
                                    type="button"
                                    aria-label={`${t("recording.archive.play")} ${sourceLabel(track.source, t)}`}
                                    onClick={() => {
                                      setPlaybackErrorTrackId("");
                                      setPlayingTrackId(
                                        isPlaying ? "" : track.trackId,
                                      );
                                    }}
                                  >
                                    <Play size={13} aria-hidden="true" />{" "}
                                    {t("recording.archive.play")}
                                  </button>
                                  <a
                                    href={recordingTrackContentPath(
                                      spaceId,
                                      entry.recordingId,
                                      track.trackId,
                                      true,
                                    )}
                                    download={`${entry.recordingId}-${track.source.toLowerCase()}.webm`}
                                    aria-label={`${t("recording.archive.download")} ${sourceLabel(track.source, t)}`}
                                  >
                                    <Download size={13} aria-hidden="true" />{" "}
                                    {t("recording.archive.download")}
                                  </a>
                                </div>
                              </div>
                              {isPlaying &&
                                (audio ? (
                                  <audio
                                    controls
                                    autoPlay
                                    preload="metadata"
                                    src={contentPath}
                                    onError={() =>
                                      setPlaybackErrorTrackId(track.trackId)
                                    }
                                  />
                                ) : (
                                  <video
                                    controls
                                    autoPlay
                                    playsInline
                                    preload="metadata"
                                    src={contentPath}
                                    onError={() =>
                                      setPlaybackErrorTrackId(track.trackId)
                                    }
                                  />
                                ))}
                              {playbackErrorTrackId === track.trackId && (
                                <p
                                  className="room-recording-error"
                                  role="alert"
                                >
                                  {t("recording.archive.playbackError")}
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                      {entry.canDelete &&
                        (confirmDeleteId === entry.recordingId ? (
                          <div
                            className="room-recording-archive-delete-confirm"
                            role="group"
                            aria-label={t("recording.archive.deleteConfirm")}
                          >
                            <p>{t("recording.archive.deleteConfirm")}</p>
                            <button
                              type="button"
                              disabled={!!deletingId}
                              onClick={() => setConfirmDeleteId("")}
                            >
                              {t("recording.archive.deleteCancel")}
                            </button>
                            <button
                              type="button"
                              className="danger"
                              disabled={!!deletingId}
                              onClick={() => void deleteArchiveEntry(entry)}
                            >
                              <Trash2 size={13} aria-hidden="true" />
                              {deletingId === entry.recordingId
                                ? t("recording.archive.deletePending")
                                : t("recording.archive.deleteApprove")}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="room-recording-archive-delete"
                            disabled={!!deletingId}
                            onClick={() =>
                              setConfirmDeleteId(entry.recordingId)
                            }
                          >
                            <Trash2 size={13} aria-hidden="true" />{" "}
                            {t("recording.archive.delete")}
                          </button>
                        ))}
                    </li>
                  ))}
                </ul>
              )}
          </div>
        </Dialog>
      )}
    </section>
  );
}
