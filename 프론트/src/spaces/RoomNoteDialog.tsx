import { useEffect, useId, useRef, useState } from "react";
import type { RoomNoteAck, RoomNoteState } from "../generated/protocol";
import { WorldConnection } from "../game/WorldConnection";
import {
  formatDate,
  formatNumber,
  useLanguage,
  type TranslationKey,
} from "../i18n/language";
import { Dialog } from "../components/Dialog";

export const ROOM_NOTE_MAX_CHARACTERS = 4000;

const ROOM_NOTE_ACK_TRANSLATIONS: Record<string, TranslationKey> = {
  ROOM_NOTE_ACCOUNT_UNAVAILABLE: "roomNote.error.account",
  ROOM_NOTE_BUSY: "roomNote.error.busy",
  ROOM_NOTE_CONFLICT: "roomNote.error.conflict",
  ROOM_NOTE_FORBIDDEN: "roomNote.error.forbidden",
  ROOM_NOTE_IDEMPOTENCY_CONFLICT: "roomNote.error.requestConflict",
  ROOM_NOTE_INVALID: "roomNote.error.invalid",
  ROOM_NOTE_MEETING_ENDED: "roomNote.error.meetingEnded",
  ROOM_NOTE_RATE_LIMIT: "roomNote.error.rateLimit",
  ROOM_NOTE_STORAGE_UNAVAILABLE: "roomNote.error.unavailable",
  ROOM_NOTE_UNAVAILABLE: "roomNote.error.unavailable",
};

export function roomNoteCharacterCount(value: string) {
  return Array.from(value).length;
}

export function truncateRoomNote(value: string) {
  return Array.from(value).slice(0, ROOM_NOTE_MAX_CHARACTERS).join("");
}

function formatRoomNoteDate(timestamp: number, language: "ko" | "en") {
  if (timestamp <= 0) return "";
  return formatDate(language, timestamp, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function RoomNoteDialog({
  roomName,
  roomNote,
  ack,
  connection,
  online,
  close,
}: {
  roomName: string;
  roomNote: RoomNoteState | null;
  ack: RoomNoteAck | null;
  connection: WorldConnection;
  online: boolean;
  close: () => void;
}) {
  const { language, t } = useLanguage();
  const countId = useId();
  const loadAttempted = useRef(false);
  const [draft, setDraft] = useState(() => roomNote?.body ?? "");
  const [dirty, setDirty] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState("");
  const [pendingAction, setPendingAction] = useState<"LOAD" | "SAVE" | null>(
    null,
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<TranslationKey | "">("");
  const [error, setError] = useState<TranslationKey | "">("");
  const matchingAck = ack?.requestId === pendingRequestId ? ack : undefined;

  useEffect(() => {
    if (!online) {
      loadAttempted.current = false;
      return;
    }
    if (roomNote || loadAttempted.current) return;
    loadAttempted.current = true;
    const requestId = connection.loadRoomNote();
    if (requestId) {
      setPendingRequestId(requestId);
      setPendingAction("LOAD");
      setLoadFailed(false);
      setError("");
    } else {
      setLoadFailed(true);
      setError("roomNote.error.connection");
    }
  }, [connection, online, roomNote]);

  useEffect(() => {
    if (!roomNote || dirty) return;
    setDraft(roomNote.body);
  }, [dirty, roomNote]);

  useEffect(() => {
    if (!matchingAck || !pendingAction) return;
    setPendingRequestId("");
    setPendingAction(null);
    if (pendingAction === "LOAD") {
      if (!matchingAck.accepted) {
        setLoadFailed(true);
        setError(
          ROOM_NOTE_ACK_TRANSLATIONS[matchingAck.code] ??
            "roomNote.error.access",
        );
      }
      return;
    }
    if (matchingAck.accepted) {
      setConflict(false);
      setDirty(false);
      setNotice("roomNote.notice.saved");
      setError("");
    } else if (matchingAck.code === "ROOM_NOTE_CONFLICT") {
      setConflict(true);
      setError("roomNote.error.conflict");
      setNotice("");
    } else {
      setError(
        ROOM_NOTE_ACK_TRANSLATIONS[matchingAck.code] ?? "roomNote.error.save",
      );
      setNotice("");
    }
  }, [matchingAck, pendingAction]);

  const busy = pendingAction !== null;
  const noteReady = Boolean(roomNote);
  const count = roomNoteCharacterCount(draft);

  function loadLatest() {
    if (!roomNote) return;
    setDraft(roomNote.body);
    setDirty(false);
    setConflict(false);
    setError("");
    setNotice("roomNote.notice.latest");
  }

  function submitDraft(retryConflict = false) {
    if (!roomNote || busy || (!retryConflict && conflict)) return;
    const requestId = connection.saveRoomNote(draft, roomNote.revision);
    if (!requestId) {
      setError("roomNote.error.cannotSave");
      return;
    }
    setPendingRequestId(requestId);
    setPendingAction("SAVE");
    setNotice("");
    setError("");
    if (retryConflict) setConflict(false);
  }

  const statusMessage = !noteReady
    ? !online
      ? t("roomNote.loadingOffline")
      : loadFailed
        ? t("roomNote.loadingFailed")
        : t("roomNote.loading")
    : t("roomNote.collaborative");

  return (
    <Dialog
      title={t("roomNote.title", { roomName })}
      close={close}
      closeLabel={t("dialog.close")}
    >
      <section
        className="room-note-dialog"
        aria-label={t("roomNote.description")}
      >
        <p className="room-note-access" role="status">
          {statusMessage}
        </p>
        {error && (
          <p className="room-note-error" role="alert">
            {t(error)}
          </p>
        )}
        {notice && (
          <p className="room-note-notice" role="status">
            {t(notice)}
          </p>
        )}
        {roomNote && (
          <>
            <label className="room-note-editor-label" htmlFor="room-note-body">
              {t("roomNote.label")}
            </label>
            <textarea
              id="room-note-body"
              className="room-note-editor"
              aria-describedby={countId}
              value={draft}
              disabled={!online}
              onChange={(event) => {
                const next = truncateRoomNote(event.currentTarget.value);
                setDraft(next);
                setDirty(true);
                setNotice("");
                setError("");
              }}
              placeholder={t("roomNote.placeholder")}
            />
            <div className="room-note-editor-footer">
              <small id={countId}>
                {t("roomNote.count", {
                  count: formatNumber(language, count),
                  max: formatNumber(language, ROOM_NOTE_MAX_CHARACTERS),
                })}
              </small>
              <button
                type="button"
                className="room-note-save"
                disabled={
                  busy ||
                  conflict ||
                  !dirty ||
                  count > ROOM_NOTE_MAX_CHARACTERS ||
                  !online
                }
                onClick={() => submitDraft()}
              >
                {pendingAction === "SAVE"
                  ? t("roomNote.action.saving")
                  : t("roomNote.action.save")}
              </button>
            </div>
            {conflict && (
              <div
                className="room-note-conflict"
                aria-label={t("roomNote.conflict.label")}
              >
                <p>{t("roomNote.notice.conflictHelp")}</p>
                <div>
                  <button type="button" onClick={loadLatest}>
                    {t("roomNote.notice.loadLatest")}
                  </button>
                  <button
                    type="button"
                    className="room-note-save"
                    disabled={busy}
                    onClick={() => submitDraft(true)}
                  >
                    {t("roomNote.notice.retryDraft")}
                  </button>
                </div>
              </div>
            )}
            {conflict && (
              <details className="room-note-latest">
                <summary>{t("roomNote.notice.latestSaved")}</summary>
                <p>{roomNote.body || t("roomNote.notice.empty")}</p>
              </details>
            )}
            <div className="room-note-metadata">
              <p>
                {roomNote.revision > 0
                  ? t("roomNote.metadata.version", {
                      revision: roomNote.revision,
                      name: roomNote.updatedBy,
                      date: formatRoomNoteDate(roomNote.updatedAt, language),
                    })
                  : t("roomNote.notice.unsaved")}
              </p>
              {roomNote.meetingEndedAt > 0 && (
                <p>
                  {t("roomNote.notice.meetingEnded", {
                    date: formatRoomNoteDate(roomNote.meetingEndedAt, language),
                  })}
                </p>
              )}
              {roomNote.retentionExpiresAt > 0 && (
                <p>
                  {t("roomNote.notice.retention", {
                    date: formatRoomNoteDate(
                      roomNote.retentionExpiresAt,
                      language,
                    ),
                  })}
                </p>
              )}
            </div>
            <section
              className="room-note-history"
              aria-labelledby="room-note-history-heading"
            >
              <h3 id="room-note-history-heading">
                {t("roomNote.history.title")}
              </h3>
              {roomNote.history.length ? (
                <ol>
                  {[...roomNote.history]
                    .sort((left, right) => right.revision - left.revision)
                    .slice(0, 10)
                    .map((entry) => (
                      <li key={entry.revision}>
                        <strong>v{entry.revision}</strong>
                        <span>{entry.authorName}</span>
                        <time dateTime={new Date(entry.editedAt).toISOString()}>
                          {formatRoomNoteDate(entry.editedAt, language)}
                        </time>
                      </li>
                    ))}
                </ol>
              ) : (
                <p>{t("roomNote.history.empty")}</p>
              )}
            </section>
          </>
        )}
        {!roomNote && loadFailed && (
          <button
            type="button"
            className="room-note-reload"
            onClick={() => {
              const requestId = connection.loadRoomNote();
              if (requestId) {
                loadAttempted.current = true;
                setPendingRequestId(requestId);
                setPendingAction("LOAD");
                setLoadFailed(false);
                setError("");
              }
            }}
          >
            {t("roomNote.loading.retry")}
          </button>
        )}
      </section>
    </Dialog>
  );
}
