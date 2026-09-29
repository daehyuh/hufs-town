import { useCallback, useEffect, useRef, useState } from "react";
import { formatDate, useLanguage } from "../i18n/language";
import {
  cancelSocialJoinRequest,
  listIncomingSocialJoinRequests,
  listOutgoingSocialJoinRequests,
  respondToSocialJoinRequest,
  type SocialJoinRequest,
} from "./joinRequests";

export function MeetupRequestInbox({
  onOpenDestination,
}: {
  onOpenDestination: (spaceId: string) => boolean;
}) {
  const { language, t } = useLanguage();
  const [incoming, setIncoming] = useState<SocialJoinRequest[]>([]);
  const [outgoing, setOutgoing] = useState<SocialJoinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyRequestId, setBusyRequestId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const refreshInFlight = useRef(false);
  const refreshAgain = useRef(false);
  const dataRevision = useRef(0);
  const refreshRef = useRef<(silent?: boolean) => Promise<void>>(
    async () => undefined,
  );

  const refresh = useCallback(
    async (silent = false) => {
      if (refreshInFlight.current) {
        refreshAgain.current = true;
        return;
      }
      refreshInFlight.current = true;
      const revision = dataRevision.current;
      if (!silent) {
        setLoading(true);
        setError("");
      }
      try {
        const [nextIncoming, nextOutgoing] = await Promise.all([
          listIncomingSocialJoinRequests(),
          listOutgoingSocialJoinRequests(),
        ]);
        if (mounted.current && revision === dataRevision.current) {
          setIncoming(nextIncoming);
          setOutgoing(nextOutgoing);
          setError("");
        }
      } catch (cause) {
        if (mounted.current && revision === dataRevision.current)
          setError(
            language === "ko" && cause instanceof Error
              ? cause.message
              : t("meetup.error.load"),
          );
      } finally {
        refreshInFlight.current = false;
        if (mounted.current && !silent) setLoading(false);
        if (mounted.current && refreshAgain.current) {
          refreshAgain.current = false;
          void refreshRef.current(true);
        }
      }
    },
    [language, t],
  );
  refreshRef.current = refresh;

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    const timer = window.setInterval(refreshWhenVisible, 15000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  async function respond(request: SocialJoinRequest, approve: boolean) {
    if (busyRequestId) return;
    setBusyRequestId(request.id);
    setError("");
    setNotice("");
    try {
      await respondToSocialJoinRequest(
        request.id,
        approve ? "APPROVE" : "DECLINE",
      );
      dataRevision.current += 1;
      setIncoming((items) => items.filter((item) => item.id !== request.id));
      setNotice(
        approve ? t("meetup.notice.approved") : t("meetup.notice.declined"),
      );
      await refresh();
    } catch (cause) {
      setError(
        language === "ko" && cause instanceof Error
          ? cause.message
          : t("meetup.error.respond"),
      );
      void refresh();
    } finally {
      setBusyRequestId("");
    }
  }

  async function cancel(request: SocialJoinRequest) {
    if (busyRequestId) return;
    setBusyRequestId(request.id);
    setError("");
    setNotice("");
    try {
      await cancelSocialJoinRequest(request.id);
      dataRevision.current += 1;
      setOutgoing((items) => items.filter((item) => item.id !== request.id));
      setNotice(t("meetup.notice.cancelled"));
      await refresh();
    } catch (cause) {
      setError(
        language === "ko" && cause instanceof Error
          ? cause.message
          : t("meetup.error.cancel"),
      );
      void refresh();
    } finally {
      setBusyRequestId("");
    }
  }

  function openDestination(request: SocialJoinRequest) {
    if (!request.destinationSpaceId) return;
    try {
      const alreadyOpen = onOpenDestination(request.destinationSpaceId);
      if (alreadyOpen) setNotice(t("meetup.notice.alreadyHere"));
    } catch (cause) {
      setError(
        language === "ko" && cause instanceof Error
          ? cause.message
          : t("meetup.error.open"),
      );
    }
  }

  function statusLabel(status: SocialJoinRequest["status"]) {
    switch (status) {
      case "APPROVED":
        return t("meetup.status.approved");
      case "DECLINED":
        return t("meetup.status.declined");
      case "CANCELLED":
        return t("meetup.status.cancelled");
      case "EXPIRED":
        return t("meetup.status.expired");
      default:
        return t("meetup.status.pending");
    }
  }

  return (
    <section className="meetup-request-inbox" aria-label={t("meetup.title")}>
      <div className="meetup-request-heading">
        <strong>{t("meetup.title")}</strong>
        <div className="meetup-request-refresh-wrap">
          {loading && <small>{t("meetup.loading")}</small>}
          <button
            type="button"
            className="meetup-request-refresh"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={t("meetup.refreshLabel")}
          >
            {t("meetup.refresh")}
          </button>
        </div>
      </div>
      {incoming.map((request) => (
        <article className="meetup-request-card" key={request.id}>
          <div className="meetup-request-copy">
            <strong>
              {request.status === "APPROVED"
                ? t("meetup.incoming.approved", {
                    name: request.displayName,
                  })
                : t("meetup.incoming.received", {
                    name: request.displayName,
                  })}
            </strong>
            <small>
              {request.destinationSpaceName
                ? `${t("meetup.incoming.destination", {
                    spaceName: request.destinationSpaceName,
                  })} `
                : ""}
              {request.message || t("meetup.incoming.defaultMessage")}
              {request.status === "PENDING" &&
                t("meetup.incoming.expires", {
                  date: formatDate(language, request.expiresAt, {
                    month: "numeric",
                    day: "numeric",
                  }),
                })}
            </small>
          </div>
          {request.status === "PENDING" ? (
            <div className="meetup-request-actions">
              <button
                type="button"
                onClick={() => void respond(request, false)}
                disabled={busyRequestId !== ""}
              >
                {t("meetup.action.decline")}
              </button>
              <button
                type="button"
                className="accept"
                onClick={() => void respond(request, true)}
                disabled={busyRequestId !== ""}
              >
                {busyRequestId === request.id
                  ? t("meetup.action.processing")
                  : t("meetup.action.approve")}
              </button>
            </div>
          ) : (
            request.destinationSpaceId && (
              <div className="meetup-request-actions">
                <button
                  type="button"
                  className="accept"
                  onClick={() => openDestination(request)}
                >
                  {t("meetup.action.openSpace")}
                </button>
              </div>
            )
          )}
        </article>
      ))}
      {!loading && incoming.length === 0 && (
        <small className="meetup-request-empty">
          {t("meetup.empty.incoming")}
        </small>
      )}
      {outgoing.length > 0 && (
        <div
          className="meetup-outgoing-list"
          aria-label={t("meetup.outgoing.label")}
        >
          <strong>{t("meetup.outgoing.title")}</strong>
          {outgoing.map((request) => (
            <div className="meetup-outgoing-row" key={request.id}>
              <span>
                {request.displayName} · {statusLabel(request.status)}
              </span>
              {request.status === "PENDING" && (
                <button
                  type="button"
                  onClick={() => void cancel(request)}
                  disabled={busyRequestId !== ""}
                  aria-label={t("meetup.action.cancelLabel", {
                    name: request.displayName,
                  })}
                >
                  {t("meetup.action.cancel")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <small className="meetup-request-note">{t("meetup.note")}</small>
      {error && (
        <p className="poke-feedback error" role="status">
          {error}
        </p>
      )}
      {notice && (
        <p className="poke-feedback success" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
