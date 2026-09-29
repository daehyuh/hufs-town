import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { formatDate, useLanguage } from "../i18n/language";
import {
  acceptSpaceInvite,
  declineSpaceInvite,
  listIncomingJoinRequests,
  listIncomingSpaceInvites,
  listJoinRequests,
  resolveJoinRequest,
  type IncomingSpaceInvite,
  type IncomingSpaceJoinRequest,
  type Space,
} from "./client";
import "./admissionRequestOverlay.css";

interface AdmissionRequestOverlayProps {
  spaceId?: string;
  spaceName?: string;
  onAcceptInvite?: (space: Space) => void;
}

export function AdmissionRequestOverlay({
  spaceId,
  spaceName,
  onAcceptInvite,
}: AdmissionRequestOverlayProps) {
  const { language, t } = useLanguage();
  const canAcceptInvite = !!onAcceptInvite;
  const [requests, setRequests] = useState<IncomingSpaceJoinRequest[]>([]);
  const requestCount = useRef(requests.length);
  requestCount.current = requests.length;
  const [invites, setInvites] = useState<IncomingSpaceInvite[]>([]);
  const [admissionLoading, setAdmissionLoading] = useState(
    !!spaceId || canAcceptInvite,
  );
  const [inviteLoading, setInviteLoading] = useState(canAcceptInvite);
  const [admissionError, setAdmissionError] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [admissionCursor, setAdmissionCursor] = useState<string | null>(null);
  const [admissionHasMore, setAdmissionHasMore] = useState(false);
  const [admissionMoreLoading, setAdmissionMoreLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [busyDecision, setBusyDecision] = useState<"APPROVE" | "REJECT" | "">(
    "",
  );
  const knownRequestIds = useRef(new Set<string>());
  const knownInviteIds = useRef(new Set<string>());
  const admissionPagesLoaded = useRef(1);
  const admissionRefreshInFlight = useRef(false);
  const acceptInviteRef = useRef(onAcceptInvite);
  useEffect(() => {
    acceptInviteRef.current = onAcceptInvite;
  }, [onAcceptInvite]);

  const refreshAdmissions = useCallback(
    async (active?: () => boolean) => {
      if (!spaceId && !canAcceptInvite) return;
      if (admissionRefreshInFlight.current) return;
      admissionRefreshInFlight.current = true;
      const pageCount = admissionPagesLoaded.current;
      if (requestCount.current === 0) setAdmissionLoading(true);
      try {
        let result: IncomingSpaceJoinRequest[];
        let nextCursor: string | null = null;
        let hasMore = false;
        let pagesLoaded = 0;
        result = [];
        let cursor: string | undefined;
        for (let page = 0; page < pageCount; page += 1) {
          if (canAcceptInvite) {
            const response = await listIncomingJoinRequests(cursor);
            result.push(...response.items);
            nextCursor = response.nextCursor;
            hasMore = response.hasMore;
          } else {
            const response = await listJoinRequests(spaceId!, cursor);
            result.push(
              ...response.items.map((request) => ({
                spaceId: spaceId!,
                spaceName: spaceName ?? "",
                request,
              })),
            );
            nextCursor = response.nextCursor;
            hasMore = response.hasMore;
          }
          pagesLoaded += 1;
          if (!hasMore || !nextCursor) break;
          cursor = nextCursor;
        }
        if (active && !active()) return;
        if (
          result.some(
            (item) =>
              !knownRequestIds.current.has(
                `${item.spaceId}:${item.request.id}`,
              ),
          )
        )
          setOpen(true);
        knownRequestIds.current = new Set(
          result.map((item) => `${item.spaceId}:${item.request.id}`),
        );
        setRequests(result);
        setAdmissionCursor(nextCursor);
        setAdmissionHasMore(hasMore);
        admissionPagesLoaded.current = pagesLoaded;
        setAdmissionError("");
      } catch {
        if (active && !active()) return;
        setAdmissionError(t("lobby.admissionInboxError"));
      } finally {
        admissionRefreshInFlight.current = false;
        if (!active || active()) setAdmissionLoading(false);
      }
    },
    [canAcceptInvite, spaceId, spaceName, t],
  );

  async function loadMoreAdmissions() {
    const cursor = admissionCursor;
    if (!cursor || !admissionHasMore || admissionRefreshInFlight.current)
      return;
    admissionRefreshInFlight.current = true;
    setAdmissionMoreLoading(true);
    try {
      let result: IncomingSpaceJoinRequest[];
      let nextCursor: string | null;
      let hasMore: boolean;
      if (canAcceptInvite) {
        const page = await listIncomingJoinRequests(cursor);
        result = page.items;
        nextCursor = page.nextCursor;
        hasMore = page.hasMore;
      } else {
        const page = await listJoinRequests(spaceId!, cursor);
        result = page.items.map((request) => ({
          spaceId: spaceId!,
          spaceName: spaceName ?? "",
          request,
        }));
        nextCursor = page.nextCursor;
        hasMore = page.hasMore;
      }
      setRequests((current) => {
        const known = new Set(
          current.map((item) => `${item.spaceId}:${item.request.id}`),
        );
        const additions = result.filter(
          (item) => !known.has(`${item.spaceId}:${item.request.id}`),
        );
        for (const item of additions)
          known.add(`${item.spaceId}:${item.request.id}`);
        return [...current, ...additions];
      });
      setAdmissionCursor(nextCursor);
      setAdmissionHasMore(hasMore);
      admissionPagesLoaded.current += 1;
      setAdmissionError("");
    } catch (cause) {
      setAdmissionError(
        language === "ko" && cause instanceof Error
          ? cause.message
          : t("lobby.admissionInboxError"),
      );
    } finally {
      admissionRefreshInFlight.current = false;
      setAdmissionMoreLoading(false);
    }
  }

  const refreshInvites = useCallback(
    async (active?: () => boolean) => {
      if (!canAcceptInvite) return;
      setInviteLoading(true);
      try {
        const result = await listIncomingSpaceInvites();
        if (active && !active()) return;
        if (
          result.some((invite) => !knownInviteIds.current.has(invite.inviteId))
        )
          setOpen(true);
        knownInviteIds.current = new Set(
          result.map((invite) => invite.inviteId),
        );
        setInvites(result);
        setInviteError("");
      } catch (cause) {
        if (active && !active()) return;
        setInviteError(
          language === "ko" && cause instanceof Error
            ? cause.message
            : t("lobby.error.incomingInvites"),
        );
      } finally {
        if (!active || active()) setInviteLoading(false);
      }
    },
    [canAcceptInvite, language, t],
  );

  useEffect(() => {
    if (!spaceId && !canAcceptInvite) return;
    let active = true;
    const isActive = () => active;
    void refreshAdmissions(isActive);
    const interval = window.setInterval(
      () => void refreshAdmissions(isActive),
      10_000,
    );
    const onFocus = () => void refreshAdmissions(isActive);
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [canAcceptInvite, refreshAdmissions, spaceId]);

  useEffect(() => {
    if (!canAcceptInvite) return;
    let active = true;
    const isActive = () => active;
    void refreshInvites(isActive);
    const interval = window.setInterval(
      () => void refreshInvites(isActive),
      10_000,
    );
    const onFocus = () => void refreshInvites(isActive);
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [canAcceptInvite, refreshInvites]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 5_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  async function resolveRequest(
    item: IncomingSpaceJoinRequest,
    decision: "APPROVE" | "REJECT",
  ) {
    if (busyKey) return;
    setBusyKey(`request:${item.request.id}`);
    setBusyDecision(decision);
    setAdmissionError("");
    setNotice("");
    try {
      await resolveJoinRequest(item.spaceId, item.request.id, decision);
      knownRequestIds.current.delete(`${item.spaceId}:${item.request.id}`);
      setRequests((current) =>
        current.filter(
          (request) =>
            request.spaceId !== item.spaceId ||
            request.request.id !== item.request.id,
        ),
      );
      setNotice(
        decision === "APPROVE"
          ? t("lobby.notice.requestApproved", {
              name: item.request.displayName,
            })
          : t("lobby.notice.requestRejected", {
              name: item.request.displayName,
            }),
      );
      await refreshAdmissions();
    } catch (cause) {
      setAdmissionError(
        language === "ko" && cause instanceof Error
          ? cause.message
          : t("lobby.admissionInboxError"),
      );
    } finally {
      setBusyKey("");
      setBusyDecision("");
    }
  }

  async function acceptInvite(invite: IncomingSpaceInvite) {
    if (busyKey) return;
    setBusyKey(`invite:${invite.inviteId}`);
    setBusyDecision("APPROVE");
    setInviteError("");
    try {
      const space = await acceptSpaceInvite(invite.inviteId);
      knownInviteIds.current.delete(invite.inviteId);
      setInvites((current) =>
        current.filter((item) => item.inviteId !== invite.inviteId),
      );
      acceptInviteRef.current?.(space);
    } catch (cause) {
      setInviteError(
        language === "ko" && cause instanceof Error
          ? cause.message
          : t("lobby.error.incomingInvites"),
      );
    } finally {
      setBusyKey("");
      setBusyDecision("");
    }
  }

  async function declineInvite(invite: IncomingSpaceInvite) {
    if (busyKey) return;
    setBusyKey(`invite:${invite.inviteId}`);
    setBusyDecision("REJECT");
    setInviteError("");
    setNotice("");
    try {
      await declineSpaceInvite(invite.inviteId);
      knownInviteIds.current.delete(invite.inviteId);
      setInvites((current) =>
        current.filter((item) => item.inviteId !== invite.inviteId),
      );
      setNotice(t("lobby.notice.inviteDeclined", { name: invite.spaceName }));
      await refreshInvites();
    } catch (cause) {
      setInviteError(
        language === "ko" && cause instanceof Error
          ? cause.message
          : t("lobby.error.incomingInvites"),
      );
    } finally {
      setBusyKey("");
      setBusyDecision("");
    }
  }

  const itemCount = requests.length + invites.length;
  const loading = admissionLoading || inviteLoading;
  const error = inviteError || admissionError;
  if (itemCount === 0 && !loading && !error && !notice) return null;

  if (!open) {
    return (
      <button
        className="world-admission-collapsed"
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${t("lobby.worldInbox")} ${itemCount}`}
      >
        <Bell size={16} aria-hidden="true" />
        <span>{t("lobby.worldInbox")}</span>
        {itemCount > 0 && (
          <strong>
            {itemCount}
            {admissionHasMore ? "+" : ""}
          </strong>
        )}
        <ChevronUp size={15} aria-hidden="true" />
      </button>
    );
  }

  return (
    <section
      className="world-admission-panel"
      aria-label={t("lobby.worldInbox")}
    >
      <header className="world-admission-heading">
        <div className="world-admission-title">
          <Bell size={16} aria-hidden="true" />
          <div>
            <strong>{t("lobby.worldInbox")}</strong>
            {spaceName && <small>{spaceName}</small>}
          </div>
          {itemCount > 0 && (
            <span className="world-admission-count">
              {itemCount}
              {admissionHasMore ? "+" : ""}
            </span>
          )}
        </div>
        <div className="world-admission-tools">
          <button
            type="button"
            onClick={() => {
              void refreshAdmissions();
              void refreshInvites();
            }}
            disabled={loading}
            aria-label={t("lobby.worldInboxRefresh")}
            title={t("lobby.worldInboxRefresh")}
          >
            <RefreshCw
              size={15}
              className={loading ? "is-spinning" : undefined}
            />
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t("dialog.minimize")}
            title={t("dialog.minimize")}
          >
            <ChevronDown size={17} />
          </button>
        </div>
      </header>
      <div className="world-admission-body">
        {inviteError && (
          <p className="world-admission-error" role="alert">
            {inviteError}
          </p>
        )}
        {admissionError && (
          <p className="world-admission-error" role="alert">
            {admissionError}
          </p>
        )}
        {notice && (
          <p className="world-admission-notice" role="status">
            {notice}
          </p>
        )}
        {inviteLoading && invites.length === 0 && canAcceptInvite && (
          <p className="world-admission-empty">
            {t("lobby.invitationLoading")}
          </p>
        )}
        {invites.length > 0 && (
          <section
            className="world-invitation-section"
            aria-label={t("lobby.invitationInbox")}
          >
            <h3>{t("lobby.invitationInbox")}</h3>
            <ul className="world-admission-list">
              {invites.map((invite) => {
                const key = `invite:${invite.inviteId}`;
                return (
                  <li
                    key={invite.inviteId}
                    className="world-admission-request"
                    aria-busy={busyKey === key}
                  >
                    <div className="world-admission-request-copy">
                      <strong>{invite.spaceName}</strong>
                      <span>
                        {t("lobby.invitationFrom", {
                          name: invite.inviterDisplayName,
                        })}
                      </span>
                      <span>
                        {t("lobby.expires", {
                          date: formatDate(language, invite.expiresAt, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }),
                        })}
                      </span>
                    </div>
                    <div className="world-admission-actions">
                      <button
                        type="button"
                        className="world-admission-reject"
                        onClick={() => void declineInvite(invite)}
                        disabled={!!busyKey}
                      >
                        {busyKey === key && busyDecision === "REJECT"
                          ? t("lobby.action.processing")
                          : t("lobby.decline")}
                      </button>
                      <button
                        type="button"
                        className="world-admission-approve"
                        onClick={() => void acceptInvite(invite)}
                        disabled={!!busyKey}
                      >
                        <Check size={14} />
                        {busyKey === key && busyDecision === "APPROVE"
                          ? t("lobby.action.processing")
                          : t("lobby.accept")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {admissionHasMore && (
              <button
                type="button"
                className="world-admission-load-more"
                disabled={admissionMoreLoading || admissionLoading}
                onClick={() => void loadMoreAdmissions()}
              >
                {admissionMoreLoading
                  ? t("lobby.admissionInboxLoading")
                  : t("lobby.admissionInboxLoadMore")}
              </button>
            )}
          </section>
        )}
        {admissionLoading &&
        requests.length === 0 &&
        (spaceId || canAcceptInvite) ? (
          <p className="world-admission-empty">
            {t("lobby.admissionInboxLoading")}
          </p>
        ) : requests.length > 0 ? (
          <section
            className="world-admission-section"
            aria-label={t("lobby.admissionInbox")}
          >
            <h3>{t("lobby.admissionInbox")}</h3>
            <ul className="world-admission-list">
              {requests.map((item) => {
                const key = `request:${item.request.id}`;
                return (
                  <li
                    key={`${item.spaceId}:${item.request.id}`}
                    className="world-admission-request"
                    aria-busy={busyKey === key}
                  >
                    <div className="world-admission-request-copy">
                      <strong>{item.request.displayName}</strong>
                      <span>
                        {t("lobby.admissionRequestFrom", {
                          space: item.spaceName || spaceName || "",
                        })}
                      </span>
                    </div>
                    <div className="world-admission-actions">
                      <button
                        type="button"
                        className="world-admission-reject"
                        onClick={() => void resolveRequest(item, "REJECT")}
                        disabled={!!busyKey}
                      >
                        {busyKey === key && busyDecision === "REJECT"
                          ? t("lobby.action.processing")
                          : t("lobby.decline")}
                      </button>
                      <button
                        type="button"
                        className="world-admission-approve"
                        onClick={() => void resolveRequest(item, "APPROVE")}
                        disabled={!!busyKey}
                      >
                        <Check size={14} />
                        {busyKey === key && busyDecision === "APPROVE"
                          ? t("lobby.action.processing")
                          : t("lobby.accept")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (spaceId || canAcceptInvite) &&
          !admissionLoading &&
          !admissionError ? (
          <p className="world-admission-empty">
            {t("lobby.members.joinRequestsEmpty")}
          </p>
        ) : null}
      </div>
    </section>
  );
}
