import { useEffect, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { formatDate, useLanguage, type TranslationKey } from "../i18n/language";
import {
  cancelFriendRequest,
  createFriendRequest,
  getFriendPreferences,
  listFriends,
  removeFriend,
  respondToFriendRequest,
  saveFriendPreferences,
  searchFriends,
  type FriendOverview,
  type FriendPreferences,
  type FriendRequest,
  type FriendSearchRelationship,
  type FriendSearchResult,
} from "./friends";
import "./friends.css";

function messageOf(error: unknown, language: "ko" | "en", fallback: string) {
  return language === "ko" && error instanceof Error ? error.message : fallback;
}

function dateLabel(value: string, language: "ko" | "en") {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : formatDate(language, date, { month: "numeric", day: "numeric" });
}

function searchRelationshipLabel(
  relationship: FriendSearchRelationship,
  t: (key: TranslationKey) => string,
) {
  switch (relationship) {
    case "FRIEND":
      return t("friends.search.relationship.friend");
    case "INCOMING":
      return t("friends.search.relationship.incoming");
    case "OUTGOING":
      return t("friends.search.relationship.outgoing");
    case "COOLDOWN":
      return t("friends.search.relationship.cooldown");
    case "AVAILABLE":
      return t("friends.search.relationship.available");
    case "UNAVAILABLE":
      return t("friends.search.relationship.unavailable");
  }
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

export function FriendsDialog({
  close,
  onChanged,
}: {
  close: () => void;
  onChanged: () => void;
}) {
  const { language, t } = useLanguage();
  const [overview, setOverview] = useState<FriendOverview>({
    friends: [],
    incoming: [],
    outgoing: [],
  });
  const [preferences, setPreferences] = useState<FriendPreferences>({
    allowFriendRequests: true,
    allowFriendNotifications: true,
    sharePresenceWithFriends: false,
  });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FriendSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchSequence = useRef(0);

  async function refresh(silent = false) {
    if (!silent) setLoading(true);
    try {
      const [nextOverview, nextPreferences] = await Promise.all([
        listFriends(),
        getFriendPreferences(),
      ]);
      setOverview(nextOverview);
      setPreferences(nextPreferences);
      setError("");
    } catch (cause) {
      setError(messageOf(cause, language, t("friends.error.generic")));
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  async function loadSearchResults(query: string, sequence: number) {
    try {
      const response = await searchFriends(query);
      if (sequence === searchSequence.current) setSearchResults(response);
    } catch (cause) {
      if (sequence === searchSequence.current) {
        setSearchResults([]);
        setSearchError(messageOf(cause, language, t("friends.error.generic")));
      }
    } finally {
      if (sequence === searchSequence.current) setSearchLoading(false);
    }
  }

  useEffect(() => {
    const query = searchQuery.trim();
    const length = codePointLength(query);
    const sequence = ++searchSequence.current;
    if (!query || length < 2 || length > 32) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchError("");
      return;
    }

    setSearchResults([]);
    setSearchError("");
    setSearchLoading(true);
    const timer = window.setTimeout(
      () => void loadSearchResults(query, sequence),
      300,
    );
    return () => {
      window.clearTimeout(timer);
      if (searchSequence.current === sequence) searchSequence.current += 1;
    };
  }, [searchQuery]);

  async function sendSearchRequest(result: FriendSearchResult) {
    if (busyId || result.relationship !== "AVAILABLE") return;
    setBusyId(result.userId);
    setError("");
    setNotice("");
    try {
      const response = await createFriendRequest(result.userId);
      setNotice(
        response.status === "ACCEPTED"
          ? t("friends.notice.becameFriends", { name: result.displayName })
          : t("friends.notice.requestSent", { name: result.displayName }),
      );
      onChanged();
      await refresh(true);
      const query = searchQuery.trim();
      if (codePointLength(query) >= 2 && codePointLength(query) <= 32) {
        const sequence = ++searchSequence.current;
        setSearchLoading(true);
        setSearchError("");
        await loadSearchResults(query, sequence);
      }
    } catch (cause) {
      setError(messageOf(cause, language, t("friends.error.generic")));
    } finally {
      setBusyId("");
    }
  }

  async function respond(
    request: FriendRequest,
    decision: "ACCEPT" | "DECLINE",
  ) {
    if (busyId) return;
    setBusyId(request.id);
    setError("");
    setNotice("");
    try {
      await respondToFriendRequest(request.id, decision);
      setNotice(
        decision === "ACCEPT"
          ? t("friends.notice.accepted")
          : t("friends.notice.declined"),
      );
      onChanged();
      await refresh(true);
    } catch (cause) {
      setError(messageOf(cause, language, t("friends.error.generic")));
    } finally {
      setBusyId("");
    }
  }

  async function cancel(request: FriendRequest) {
    if (busyId) return;
    setBusyId(request.id);
    setError("");
    try {
      await cancelFriendRequest(request.id);
      setNotice(t("friends.notice.cancelled"));
      onChanged();
      await refresh(true);
    } catch (cause) {
      setError(messageOf(cause, language, t("friends.error.generic")));
    } finally {
      setBusyId("");
    }
  }

  async function remove(friend: FriendOverview["friends"][number]) {
    if (busyId) return;
    setBusyId(friend.userId);
    setError("");
    try {
      await removeFriend(friend.userId);
      setNotice(t("friends.notice.removed", { name: friend.displayName }));
      onChanged();
      await refresh(true);
    } catch (cause) {
      setError(messageOf(cause, language, t("friends.error.generic")));
    } finally {
      setBusyId("");
    }
  }

  async function changeRequestPreference(allowFriendRequests: boolean) {
    const before = preferences;
    const next = { ...preferences, allowFriendRequests };
    setPreferences(next);
    setError("");
    try {
      const saved = await saveFriendPreferences(next);
      setPreferences(saved);
      setNotice(
        allowFriendRequests
          ? t("friends.notice.requestsEnabled")
          : t("friends.notice.requestsDisabled"),
      );
    } catch (cause) {
      setPreferences(before);
      setError(messageOf(cause, language, t("friends.error.generic")));
    }
  }

  async function changeFriendNotificationPreference(
    allowFriendNotifications: boolean,
  ) {
    const before = preferences;
    const next = { ...preferences, allowFriendNotifications };
    setPreferences(next);
    setError("");
    try {
      const saved = await saveFriendPreferences(next);
      setPreferences(saved);
      setNotice(
        allowFriendNotifications
          ? t("friends.notice.notificationsEnabled")
          : t("friends.notice.notificationsDisabled"),
      );
    } catch (cause) {
      setPreferences(before);
      setError(messageOf(cause, language, t("friends.error.generic")));
    }
  }

  async function changePresencePreference(sharePresenceWithFriends: boolean) {
    const before = preferences;
    const next = { ...preferences, sharePresenceWithFriends };
    setPreferences(next);
    setError("");
    try {
      const saved = await saveFriendPreferences(next);
      setPreferences(saved);
      setNotice(
        sharePresenceWithFriends
          ? t("friends.notice.presenceEnabled")
          : t("friends.notice.presenceDisabled"),
      );
      onChanged();
    } catch (cause) {
      setPreferences(before);
      setError(messageOf(cause, language, t("friends.error.generic")));
    }
  }

  return (
    <Dialog
      title={t("friends.title")}
      close={close}
      closeLabel={t("dialog.close")}
    >
      <section className="friends-dialog" aria-label={t("friends.label")}>
        <label className="friends-preference">
          <input
            type="checkbox"
            checked={preferences.allowFriendRequests}
            onChange={(event) =>
              void changeRequestPreference(event.currentTarget.checked)
            }
          />
          <span>
            <strong>{t("friends.preference.requests.title")}</strong>
            <small>{t("friends.preference.requests.description")}</small>
          </span>
        </label>
        <label className="friends-preference">
          <input
            type="checkbox"
            checked={preferences.sharePresenceWithFriends}
            onChange={(event) =>
              void changePresencePreference(event.currentTarget.checked)
            }
          />
          <span>
            <strong>{t("friends.preference.presence.title")}</strong>
            <small>{t("friends.preference.presence.description")}</small>
          </span>
        </label>
        <label className="friends-preference">
          <input
            type="checkbox"
            checked={preferences.allowFriendNotifications}
            onChange={(event) =>
              void changeFriendNotificationPreference(
                event.currentTarget.checked,
              )
            }
          />
          <span>
            <strong>{t("friends.preference.notifications.title")}</strong>
            <small>{t("friends.preference.notifications.description")}</small>
          </span>
        </label>

        <section
          className="friends-section friends-search"
          aria-labelledby="friends-search-title"
        >
          <h3 id="friends-search-title">{t("friends.search.title")}</h3>
          <label className="friends-search-field">
            <span className="sr-only">{t("friends.search.label")}</span>
            <input
              type="search"
              aria-label={t("friends.search.label")}
              autoComplete="off"
              maxLength={64}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder={t("friends.search.placeholder")}
            />
          </label>
          {searchQuery.trim() && codePointLength(searchQuery.trim()) < 2 && (
            <p className="friends-empty">{t("friends.search.tooShort")}</p>
          )}
          {codePointLength(searchQuery.trim()) > 32 && (
            <p className="friends-message error" role="status">
              {t("friends.search.tooLong")}
            </p>
          )}
          {searchLoading && (
            <p className="friends-empty" role="status">
              {t("friends.search.searching")}
            </p>
          )}
          {searchError && (
            <p className="friends-message error" role="status">
              {searchError}
            </p>
          )}
          {!searchLoading && !searchError && searchResults.length === 0 && (
            <p className="friends-empty" role="status">
              {codePointLength(searchQuery.trim()) > 32
                ? t("friends.search.shorten")
                : codePointLength(searchQuery.trim()) >= 2
                  ? t("friends.search.noResults")
                  : t("friends.search.hint")}
            </p>
          )}
          {searchResults.length > 0 && (
            <div className="friends-search-results" aria-live="polite">
              {searchResults.map((result) => (
                <article className="friends-row" key={result.userId}>
                  <div>
                    <strong>{result.displayName}</strong>
                    <small
                      className={`friends-relationship ${result.relationship.toLowerCase()}`}
                    >
                      {searchRelationshipLabel(result.relationship, t)}
                    </small>
                  </div>
                  {result.relationship === "AVAILABLE" && (
                    <button
                      type="button"
                      className="accept"
                      onClick={() => void sendSearchRequest(result)}
                      disabled={busyId !== ""}
                    >
                      {busyId === result.userId
                        ? t("friends.search.requesting")
                        : t("friends.search.request")}
                    </button>
                  )}
                  {result.relationship === "INCOMING" && (
                    <small className="friends-search-hint">
                      {t("friends.search.incomingHint")}
                    </small>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        <section
          className="friends-section"
          aria-labelledby="friends-incoming-title"
        >
          <h3 id="friends-incoming-title">
            {t("friends.incoming.title", { count: overview.incoming.length })}
          </h3>
          {overview.incoming.map((request) => (
            <article className="friends-row" key={request.id}>
              <div>
                <strong>{request.displayName}</strong>
                <small>
                  {t("friends.incoming.requestedAt", {
                    date: dateLabel(request.requestedAt, language),
                  })}
                </small>
              </div>
              <div className="friends-actions">
                <button
                  type="button"
                  onClick={() => void respond(request, "DECLINE")}
                  disabled={busyId !== ""}
                >
                  {t("friends.action.decline")}
                </button>
                <button
                  type="button"
                  className="accept"
                  onClick={() => void respond(request, "ACCEPT")}
                  disabled={busyId !== ""}
                >
                  {busyId === request.id
                    ? t("friends.action.processing")
                    : t("friends.action.accept")}
                </button>
              </div>
            </article>
          ))}
          {!loading && overview.incoming.length === 0 && (
            <p className="friends-empty">{t("friends.incoming.empty")}</p>
          )}
        </section>

        <section
          className="friends-section"
          aria-labelledby="friends-list-title"
        >
          <h3 id="friends-list-title">
            {t("friends.list.title", { count: overview.friends.length })}
          </h3>
          {overview.friends.map((friend) => (
            <article className="friends-row" key={friend.userId}>
              <div>
                <strong>{friend.displayName}</strong>
                <small>
                  {t("friends.list.since", {
                    date: dateLabel(friend.since, language),
                  })}
                  {friend.online && (
                    <span className="friends-online">
                      {t("friends.list.online")}
                    </span>
                  )}
                </small>
              </div>
              <button
                type="button"
                onClick={() => void remove(friend)}
                disabled={busyId !== ""}
                aria-label={t("friends.action.removeLabel", {
                  name: friend.displayName,
                })}
              >
                {busyId === friend.userId
                  ? t("friends.action.processing")
                  : t("friends.action.remove")}
              </button>
            </article>
          ))}
          {!loading && overview.friends.length === 0 && (
            <p className="friends-empty">{t("friends.list.empty")}</p>
          )}
        </section>

        {overview.outgoing.length > 0 && (
          <section
            className="friends-section"
            aria-labelledby="friends-outgoing-title"
          >
            <h3 id="friends-outgoing-title">
              {t("friends.outgoing.title", { count: overview.outgoing.length })}
            </h3>
            {overview.outgoing.map((request) => (
              <article className="friends-row" key={request.id}>
                <div>
                  <strong>{request.displayName}</strong>
                  <small>
                    {t("friends.outgoing.sentAt", {
                      date: dateLabel(request.requestedAt, language),
                    })}
                  </small>
                </div>
                <button
                  type="button"
                  onClick={() => void cancel(request)}
                  disabled={busyId !== ""}
                  aria-label={t("friends.action.cancelLabel", {
                    name: request.displayName,
                  })}
                >
                  {t("friends.action.cancel")}
                </button>
              </article>
            ))}
          </section>
        )}

        {loading && (
          <p className="friends-empty" role="status">
            {t("friends.loading")}
          </p>
        )}
        <div className="friends-dialog-footer">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {t("friends.refresh")}
          </button>
        </div>
        {error && (
          <p className="friends-message error" role="status">
            {error}
          </p>
        )}
        {notice && (
          <p className="friends-message" role="status">
            {notice}
          </p>
        )}
      </section>
    </Dialog>
  );
}
