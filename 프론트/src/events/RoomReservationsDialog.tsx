import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createUuid } from "../ids";
import {
  ArrowRight,
  CalendarClock,
  Clock3,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { Dialog } from "../components/Dialog";
import { useDialogActions } from "../components/DialogActions";
import { formatDate, formatNumber, useLanguage } from "../i18n/language";
import {
  cancelRoomReservation,
  createRoomReservation,
  listRoomReservations,
  normalizeRoomReservationDraft,
  RoomReservationDraftError,
  updateRoomReservation,
  type ReservableRoom,
  type RoomReservation,
  type RoomReservationDraft,
  type RoomReservationSnapshot,
} from "./roomReservations";
import "./schedule.css";

function localDateTime(value?: string) {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function blankDraft(room?: ReservableRoom): RoomReservationDraft {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    requestId: createUuid(),
    mapId: room?.mapId ?? "",
    zoneId: room?.zoneId ?? "",
    title: "",
    startsAt: localDateTime(start.toISOString()),
    endsAt: localDateTime(end.toISOString()),
  };
}

function roomKey(mapId: string, zoneId: string) {
  return `${mapId}|${zoneId}`;
}

function localLabel(value: string, language: "ko" | "en") {
  return formatDate(language, value, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function isEntryOpen(reservation: RoomReservation) {
  const now = Date.now();
  return (
    !reservation.cancelledAt &&
    reservation.roomAvailable &&
    now >= new Date(reservation.startsAt).getTime() - 15 * 60_000 &&
    now < new Date(reservation.endsAt).getTime()
  );
}

export function RoomReservationsDialog({
  space,
  close,
  enter,
  canEditMap,
  editMap,
}: {
  space: { id: string; name: string };
  close: () => void;
  enter: (mapId: string, reservationId: string) => void;
  canEditMap: boolean;
  editMap: () => void;
}) {
  const { language, t } = useLanguage();
  const { confirm } = useDialogActions();
  const [snapshot, setSnapshot] = useState<RoomReservationSnapshot>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<RoomReservation>();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<RoomReservationDraft>(() => blankDraft());

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void listRoomReservations(space.id)
        .then((value) => {
          if (!active) return;
          setSnapshot(value);
          setDraft((current) => {
            if (editing) return current;
            if (
              value.rooms.some(
                (room) =>
                  roomKey(room.mapId, room.zoneId) ===
                  roomKey(current.mapId, current.zoneId),
              )
            )
              return current;
            return blankDraft(value.rooms[0]);
          });
          setError("");
        })
        .catch((cause) => {
          if (active)
            setError(
              language === "ko" && cause instanceof Error
                ? cause.message
                : t("reservations.error.load"),
            );
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    };
    setLoading(true);
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [space.id, revision, editing, language]);

  const roomsByKey = useMemo(
    () =>
      new Map(
        (snapshot?.rooms ?? []).map((room) => [
          roomKey(room.mapId, room.zoneId),
          room,
        ]),
      ),
    [snapshot?.rooms],
  );

  function beginEdit(reservation: RoomReservation) {
    setCreating(false);
    setEditing(reservation);
    setDraft({
      requestId: createUuid(),
      mapId: reservation.mapId,
      zoneId: reservation.zoneId,
      title: reservation.title,
      startsAt: localDateTime(reservation.startsAt),
      endsAt: localDateTime(reservation.endsAt),
      expectedUpdatedAt: reservation.updatedAt,
    });
    setError("");
    setNotice("");
  }

  function resetForm() {
    setEditing(undefined);
    setCreating(false);
    setDraft(blankDraft(snapshot?.rooms[0]));
    setError("");
  }

  function changeDraft(patch: Partial<RoomReservationDraft>) {
    setDraft((current) => ({
      ...current,
      ...patch,
      // A changed payload is a new operation; retries of an unchanged draft keep its key.
      requestId: createUuid(),
    }));
    setError("");
    setNotice("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !draft.mapId || !draft.zoneId) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const normalized = normalizeRoomReservationDraft(draft);
      if (editing) {
        await updateRoomReservation(space.id, editing.id, normalized);
      } else {
        await createRoomReservation(space.id, normalized);
      }
      resetForm();
      setNotice(
        t(
          editing
            ? "reservations.notice.updated"
            : "reservations.notice.created",
        ),
      );
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(
        cause instanceof RoomReservationDraftError
          ? t(cause.translationKey)
          : language === "ko" && cause instanceof Error
            ? cause.message
            : t("reservations.error.save"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function cancelReservation(reservation: RoomReservation) {
    if (saving) return;
    if (
      !(await confirm(
        t("reservations.cancelConfirm", { title: reservation.title }),
      ))
    )
      return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await cancelRoomReservation(space.id, reservation.id);
      setNotice(t("reservations.notice.cancelled"));
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(
        language === "ko" && cause instanceof Error
          ? cause.message
          : t("reservations.error.cancel"),
      );
    } finally {
      setSaving(false);
    }
  }

  const timeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    t("reservations.localTime");
  const rooms = snapshot?.rooms ?? [];
  const reservations = snapshot?.reservations ?? [];

  return (
    <Dialog
      title={t("reservations.dialog.title", { spaceName: space.name })}
      closeLabel={t("dialog.close")}
      close={() => {
        if (!saving) close();
      }}
    >
      <div className="room-reservations">
        <p className="room-reservations-intro">
          {t("reservations.intro", { timeZone })}
        </p>
        {error && (
          <p className="scheduled-events-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="scheduled-events-success" role="status">
            {notice}
          </p>
        )}

        {snapshot?.canReserve && !editing && !creating && (
          <button
            type="button"
            className="scheduled-events-add"
            disabled={!rooms.length || saving}
            onClick={() => {
              setCreating(true);
              setDraft(blankDraft(rooms[0]));
              setError("");
              setNotice("");
            }}
          >
            <Plus size={16} /> {t("reservations.add")}
          </button>
        )}

        {snapshot?.canReserve && (editing || creating) && (
          <form
            className="room-reservation-form"
            onSubmit={(event) => void submit(event)}
          >
            <div className="scheduled-events-form-heading">
              <strong>
                {t(
                  editing ? "reservations.form.edit" : "reservations.form.new",
                )}
              </strong>
              <button
                type="button"
                className="icon-button"
                aria-label={t("reservations.closeEditor")}
                disabled={saving}
                onClick={resetForm}
              >
                <X size={15} />
              </button>
            </div>
            <label>
              {t("reservations.field.room")}
              <select
                required
                disabled={saving}
                value={roomKey(draft.mapId, draft.zoneId)}
                onChange={(event) => {
                  const room = roomsByKey.get(event.target.value);
                  if (room)
                    changeDraft({ mapId: room.mapId, zoneId: room.zoneId });
                }}
              >
                <option value="" disabled>
                  {t("reservations.field.roomPlaceholder")}
                </option>
                {rooms.map((room) => (
                  <option
                    key={roomKey(room.mapId, room.zoneId)}
                    value={roomKey(room.mapId, room.zoneId)}
                  >
                    {room.mapName} · {room.zoneName}
                    {room.capacity
                      ? ` · ${t("reservations.roomCapacity", { count: formatNumber(language, room.capacity) })}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("reservations.field.title")}
              <input
                required
                disabled={saving}
                maxLength={80}
                value={draft.title}
                onChange={(event) => changeDraft({ title: event.target.value })}
              />
            </label>
            <label>
              {t("reservations.field.startsAt")}
              <input
                required
                disabled={saving}
                type="datetime-local"
                value={draft.startsAt}
                onChange={(event) =>
                  changeDraft({ startsAt: event.target.value })
                }
              />
            </label>
            <label>
              {t("reservations.field.endsAt")}{" "}
              <small>{t("reservations.duration")}</small>
              <input
                required
                disabled={saving}
                type="datetime-local"
                value={draft.endsAt}
                onChange={(event) =>
                  changeDraft({ endsAt: event.target.value })
                }
              />
            </label>
            <div className="scheduled-events-form-actions">
              <button type="button" onClick={resetForm}>
                {t("reservations.close")}
              </button>
              <button
                type="submit"
                disabled={
                  saving || !draft.title.trim() || !draft.mapId || !draft.zoneId
                }
              >
                {saving
                  ? t("reservations.saving")
                  : editing
                    ? t("reservations.save")
                    : t("reservations.submit")}
              </button>
            </div>
          </form>
        )}

        {!loading && rooms.length === 0 && (
          <div className="room-reservations-empty">
            <MapPin size={22} />
            <p>{t("reservations.empty.noRooms")}</p>
            {canEditMap ? (
              <button type="button" onClick={editMap}>
                {t("reservations.empty.editMap")}
              </button>
            ) : (
              <p>{t("reservations.empty.askAdmin")}</p>
            )}
          </div>
        )}

        {loading ? (
          <p className="scheduled-events-empty" role="status">
            {t("reservations.loading")}
          </p>
        ) : reservations.length === 0 ? (
          <p className="scheduled-events-empty">
            {t("reservations.empty.upcoming")}
          </p>
        ) : (
          <div className="room-reservation-list">
            {reservations.map((reservation) => (
              <article
                className={`room-reservation-card${reservation.cancelledAt ? " cancelled" : ""}`}
                key={reservation.id}
              >
                <div className="room-reservation-title">
                  <div>
                    <CalendarClock size={17} />
                    <h3>{reservation.title}</h3>
                  </div>
                  {reservation.cancelledAt && (
                    <span className="scheduled-event-cancelled">
                      {t("reservations.cancelled")}
                    </span>
                  )}
                </div>
                <p className="room-reservation-room">
                  <MapPin size={14} />
                  {reservation.mapName} · {reservation.zoneName}
                </p>
                <p className="scheduled-event-time">
                  <Clock3 size={14} />
                  {localLabel(reservation.startsAt, language)} –{" "}
                  {localLabel(reservation.endsAt, language)}
                </p>
                <p className="room-reservation-owner">
                  {t("reservations.organizer", {
                    name: reservation.organizerName,
                  })}
                </p>
                {!reservation.roomAvailable && (
                  <p className="room-reservation-unavailable" role="status">
                    {t("reservations.roomUnavailable")}
                  </p>
                )}
                <div className="scheduled-event-actions">
                  {isEntryOpen(reservation) && (
                    <button
                      type="button"
                      onClick={() => enter(reservation.mapId, reservation.id)}
                    >
                      {t("reservations.enter")} <ArrowRight size={15} />
                    </button>
                  )}
                  {reservation.canEdit &&
                    !reservation.cancelledAt &&
                    new Date(reservation.startsAt).getTime() > Date.now() && (
                      <>
                        <button
                          type="button"
                          disabled={saving || !reservation.roomAvailable}
                          onClick={() => beginEdit(reservation)}
                        >
                          <Pencil size={14} /> {t("reservations.edit")}
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void cancelReservation(reservation)}
                        >
                          <Trash2 size={14} /> {t("reservations.cancel")}
                        </button>
                      </>
                    )}
                </div>
              </article>
            ))}
          </div>
        )}
        <button
          className="scheduled-events-refresh"
          type="button"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={15} /> {t("reservations.refresh")}
        </button>
      </div>
    </Dialog>
  );
}
