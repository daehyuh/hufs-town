import { useEffect, useState, type FormEvent } from "react";
import {
  CalendarDays,
  Clock3,
  ExternalLink,
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
  cancelScheduledEvent,
  clearScheduledEventResponse,
  listScheduledEvents,
  respondToScheduledEvent,
  saveScheduledEvent,
  type ScheduledEvent,
  type ScheduledEventDraft,
  type ScheduledEventResponse,
} from "./client";
import "./schedule.css";

function localDateTime(value: string) {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function blankDraft(): ScheduledEventDraft {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    title: "",
    description: "",
    instructions: "",
    resourceUrl: "",
    startsAt: localDateTime(start.toISOString()),
    endsAt: localDateTime(end.toISOString()),
  };
}

export function ScheduledEventsDialog({
  space,
  canManage,
  close,
  enter,
}: {
  space: { id: string; name: string };
  canManage: boolean;
  close: () => void;
  enter: () => void;
}) {
  const { language, t } = useLanguage();
  const { confirm } = useDialogActions();
  const [events, setEvents] = useState<ScheduledEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingRsvpId, setSavingRsvpId] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState(blankDraft);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void listScheduledEvents(space.id)
        .then((items) => {
          if (active) {
            setEvents(items);
            setError("");
          }
        })
        .catch((cause) => {
          if (active)
            setError(
              language === "ko" && cause instanceof Error
                ? cause.message
                : t("events.schedule.error.load"),
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
  }, [space.id, revision, language]);

  function edit(event: ScheduledEvent) {
    setEditingId(event.id);
    setDraft({
      title: event.title,
      description: event.description,
      instructions: event.instructions,
      resourceUrl: event.resourceUrl,
      startsAt: localDateTime(event.startsAt),
      endsAt: event.endsAt ? localDateTime(event.endsAt) : "",
    });
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const resourceUrl = draft.resourceUrl.trim();
    if (resourceUrl && !/^https:\/\/[^\s]+$/i.test(resourceUrl)) {
      setError(t("events.schedule.error.resourceUrl"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await saveScheduledEvent(
        space.id,
        {
          ...draft,
          title: draft.title.trim(),
          description: draft.description.trim(),
          instructions: draft.instructions.trim(),
          resourceUrl,
          startsAt: new Date(draft.startsAt).toISOString(),
          endsAt: draft.endsAt ? new Date(draft.endsAt).toISOString() : "",
        },
        editingId && editingId !== "new" ? editingId : undefined,
      );
      setEditingId("");
      setDraft(blankDraft());
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(
        language === "ko" && cause instanceof Error
          ? cause.message
          : t("events.schedule.error.save"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function cancelEvent(event: ScheduledEvent) {
    if (saving) return;
    if (
      !(await confirm(
        t("events.schedule.cancelConfirm", { title: event.title }),
      ))
    )
      return;
    setSaving(true);
    setError("");
    try {
      await cancelScheduledEvent(space.id, event.id);
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(
        language === "ko" && cause instanceof Error
          ? cause.message
          : t("events.schedule.error.cancel"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function respond(
    event: ScheduledEvent,
    response?: ScheduledEventResponse,
  ) {
    if (saving || savingRsvpId) return;
    setSavingRsvpId(event.id);
    setError("");
    try {
      const updated = response
        ? await respondToScheduledEvent(space.id, event.id, response)
        : await clearScheduledEventResponse(space.id, event.id);
      setEvents((items) =>
        items.map((item) => (item.id === event.id ? updated : item)),
      );
    } catch (cause) {
      setError(
        language === "ko" && cause instanceof Error
          ? cause.message
          : t("events.schedule.error.response"),
      );
    } finally {
      setSavingRsvpId("");
    }
  }

  return (
    <Dialog
      title={t("events.schedule.title", { spaceName: space.name })}
      close={close}
      closeLabel={t("dialog.close")}
    >
      <div className="scheduled-events">
        <p className="scheduled-events-intro">{t("events.schedule.intro")}</p>
        {error && (
          <p className="scheduled-events-error" role="alert">
            {error}
          </p>
        )}
        {canManage && !editingId && (
          <button
            type="button"
            className="scheduled-events-add"
            onClick={() => {
              setDraft(blankDraft());
              setEditingId("new");
              setError("");
            }}
          >
            <Plus size={16} /> {t("events.schedule.add")}
          </button>
        )}
        {canManage && editingId && (
          <form
            className="scheduled-events-form"
            onSubmit={(event) => void submit(event)}
          >
            <div className="scheduled-events-form-heading">
              <strong>
                {t(
                  editingId === "new"
                    ? "events.schedule.new"
                    : "events.schedule.edit",
                )}
              </strong>
              <button
                type="button"
                className="icon-button"
                aria-label={t("events.schedule.closeEditor")}
                onClick={() => {
                  setEditingId("");
                  setError("");
                }}
              >
                <X size={15} />
              </button>
            </div>
            <label>
              {t("events.schedule.field.title")}
              <input
                required
                maxLength={80}
                value={draft.title}
                onChange={(e) =>
                  setDraft((value) => ({ ...value, title: e.target.value }))
                }
              />
            </label>
            <label>
              {t("events.schedule.field.startsAt")}
              <input
                required
                type="datetime-local"
                value={draft.startsAt}
                onChange={(e) =>
                  setDraft((value) => ({ ...value, startsAt: e.target.value }))
                }
              />
            </label>
            <label>
              {t("events.schedule.field.endsAt")}{" "}
              <small>{t("events.schedule.optional")}</small>
              <input
                type="datetime-local"
                value={draft.endsAt}
                onChange={(e) =>
                  setDraft((value) => ({ ...value, endsAt: e.target.value }))
                }
              />
            </label>
            <label>
              {t("events.schedule.field.description")}
              <textarea
                rows={2}
                maxLength={280}
                value={draft.description}
                onChange={(e) =>
                  setDraft((value) => ({
                    ...value,
                    description: e.target.value,
                  }))
                }
              />
            </label>
            <label>
              {t("events.schedule.field.instructions")}
              <textarea
                rows={2}
                maxLength={500}
                placeholder={t("events.schedule.instructionsPlaceholder")}
                value={draft.instructions}
                onChange={(e) =>
                  setDraft((value) => ({
                    ...value,
                    instructions: e.target.value,
                  }))
                }
              />
            </label>
            <label>
              {t("events.schedule.field.resource")}
              <input
                type="url"
                maxLength={512}
                placeholder="https://..."
                value={draft.resourceUrl}
                onChange={(e) =>
                  setDraft((value) => ({
                    ...value,
                    resourceUrl: e.target.value,
                  }))
                }
              />
            </label>
            <div className="scheduled-events-form-actions">
              <button
                type="button"
                onClick={() => {
                  setEditingId("");
                  setError("");
                }}
              >
                {t("events.schedule.cancel")}
              </button>
              <button type="submit" disabled={saving || !draft.title.trim()}>
                {saving
                  ? t("events.schedule.saving")
                  : t("events.schedule.save")}
              </button>
            </div>
          </form>
        )}
        {loading ? (
          <p className="scheduled-events-empty" role="status">
            {t("events.schedule.loading")}
          </p>
        ) : events.length === 0 ? (
          <p className="scheduled-events-empty">{t("events.schedule.empty")}</p>
        ) : (
          <div className="scheduled-events-list">
            {events.map((event) => (
              <article
                className={`scheduled-event-card${event.cancelled ? " cancelled" : ""}`}
                key={event.id}
              >
                <div className="scheduled-event-heading">
                  <div>
                    <CalendarDays size={16} />
                    <h3>{event.title}</h3>
                  </div>
                  {event.cancelled && (
                    <span className="scheduled-event-cancelled">
                      {t("events.schedule.cancelled")}
                    </span>
                  )}
                </div>
                <p className="scheduled-event-time">
                  <Clock3 size={14} />
                  {formatDate(language, event.startsAt, {
                    dateStyle: "full",
                    timeStyle: "short",
                  })}
                  {event.endsAt &&
                    ` – ${formatDate(language, event.endsAt, { hour: "2-digit", minute: "2-digit" })}`}
                </p>
                {event.description && (
                  <p className="scheduled-event-description">
                    {event.description}
                  </p>
                )}
                {event.instructions && (
                  <p className="scheduled-event-instructions">
                    <MapPin size={14} />
                    <span>{event.instructions}</span>
                  </p>
                )}
                {event.resourceUrl && (
                  <a
                    className="scheduled-event-link"
                    href={event.resourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink size={14} />{" "}
                    {t("events.schedule.openResource")}
                  </a>
                )}
                <div className="scheduled-event-rsvp">
                  <p className="scheduled-event-rsvp-counts" aria-live="polite">
                    {t("events.schedule.count.going", {
                      count: formatNumber(language, event.goingCount),
                    })}{" "}
                    ·{" "}
                    {t("events.schedule.count.interested", {
                      count: formatNumber(language, event.interestedCount),
                    })}{" "}
                    ·{" "}
                    {t("events.schedule.count.declined", {
                      count: formatNumber(language, event.declinedCount),
                    })}
                  </p>
                  {event.myResponse && (
                    <span className="scheduled-event-rsvp-own">
                      {t("events.schedule.myResponse", {
                        response: t(
                          event.myResponse === "GOING"
                            ? "events.schedule.response.going"
                            : event.myResponse === "INTERESTED"
                              ? "events.schedule.response.interested"
                              : "events.schedule.response.declined",
                        ),
                      })}
                    </span>
                  )}
                  {!event.cancelled &&
                    new Date(event.startsAt).getTime() > Date.now() && (
                      <div
                        className="scheduled-event-rsvp-actions"
                        aria-label={t("events.schedule.response.label", {
                          title: event.title,
                        })}
                      >
                        <button
                          type="button"
                          aria-pressed={event.myResponse === "GOING"}
                          disabled={Boolean(savingRsvpId) || saving}
                          onClick={() => void respond(event, "GOING")}
                        >
                          {t("events.schedule.response.goingAction")}
                        </button>
                        <button
                          type="button"
                          aria-pressed={event.myResponse === "INTERESTED"}
                          disabled={Boolean(savingRsvpId) || saving}
                          onClick={() => void respond(event, "INTERESTED")}
                        >
                          {t("events.schedule.response.interestedAction")}
                        </button>
                        <button
                          type="button"
                          aria-pressed={event.myResponse === "DECLINED"}
                          disabled={Boolean(savingRsvpId) || saving}
                          onClick={() => void respond(event, "DECLINED")}
                        >
                          {t("events.schedule.response.declinedAction")}
                        </button>
                        {event.myResponse && (
                          <button
                            type="button"
                            disabled={Boolean(savingRsvpId) || saving}
                            onClick={() => void respond(event)}
                          >
                            {t("events.schedule.response.withdraw")}
                          </button>
                        )}
                      </div>
                    )}
                  {(event.cancelled ||
                    new Date(event.startsAt).getTime() <= Date.now()) &&
                    event.myResponse && (
                      <button
                        type="button"
                        className="scheduled-event-rsvp-withdraw"
                        disabled={Boolean(savingRsvpId) || saving}
                        onClick={() => void respond(event)}
                      >
                        {t("events.schedule.response.withdrawMine")}
                      </button>
                    )}
                  {!event.cancelled && (
                    <small>{t("events.schedule.response.disclaimer")}</small>
                  )}
                </div>
                <div className="scheduled-event-actions">
                  {!event.cancelled && (
                    <button type="button" onClick={enter}>
                      {t("events.schedule.enter")}
                    </button>
                  )}
                  {canManage &&
                    !event.cancelled &&
                    new Date(event.startsAt).getTime() > Date.now() && (
                      <>
                        <button
                          type="button"
                          aria-label={t("events.schedule.editLabel", {
                            title: event.title,
                          })}
                          disabled={saving}
                          onClick={() => edit(event)}
                        >
                          <Pencil size={14} /> {t("events.schedule.editAction")}
                        </button>
                        <button
                          type="button"
                          aria-label={t("events.schedule.cancelLabel", {
                            title: event.title,
                          })}
                          disabled={saving}
                          onClick={() => void cancelEvent(event)}
                        >
                          <Trash2 size={14} />{" "}
                          {t("events.schedule.cancelAction")}
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
          <RefreshCw size={14} /> {t("events.schedule.refresh")}
        </button>
      </div>
    </Dialog>
  );
}
