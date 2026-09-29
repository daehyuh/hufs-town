import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  Plus,
  Search,
  Settings2,
  Users,
  Globe2,
  LockKeyhole,
  Link2,
  Ticket,
  Copy,
  Leaf,
  RefreshCw,
  PencilRuler,
  UserMinus,
  ArrowLeftRight,
  Star,
  Archive,
  ArchiveRestore,
  CalendarDays,
  BookOpen,
  Mic2,
  Trees,
  Mail,
  Blocks,
} from "lucide-react";
import { Dialog } from "../components/Dialog";
import { useDialogActions } from "../components/DialogActions";
import {
  formatDate,
  formatNumber,
  LanguagePicker,
  useLanguage,
  type TranslationKey,
} from "../i18n/language";
import { Avatar } from "../components/Avatar";
import { OfficePreview } from "./OfficePreview";
import { ScheduledEventsDialog } from "../events/ScheduledEventsDialog";
import { SpaceExtensionsDialog } from "./SpaceExtensionsDialog";
import {
  AuthError,
  deleteCurrentAccount,
  getAccountDeletionImpact,
  saveProfile,
  type Account,
  type AccountDeletionImpact,
} from "../auth/client";
import {
  applyHufsTownCalendarVersion,
  disconnectGoogleCalendar,
  getGoogleCalendarStatus,
  startGoogleCalendarConnection,
  type GoogleCalendarConflict,
  type GoogleCalendarStatus,
} from "../auth/calendar";
import { AVATAR_CATALOG } from "../generated/avatarCatalog";
import { ASSET_GROUPS } from "../generated/assetGroups";
import * as api from "./client";
import { readRecentSpaceVisits, writeRecentSpaceVisits } from "./recentVisits";
import type {
  Space,
  Visibility,
  Invite,
  SpaceMember,
  SpaceAccessBlock,
  SpaceJoinRequest,
  SpaceOwnershipTransfer,
  IncomingOwnershipTransfer,
  IncomingSpaceInvite,
  SpaceListView,
  SpacePage,
  SpaceTemplateId,
} from "./client";
import "./spaces.css";

const SPACE_PAGE_SIZE = 12;
function pendingAdmissionStorageKey(userId: string) {
  return `hufs.pending-admissions.${userId}`;
}
function readPendingAdmissionIds(userId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = window.sessionStorage.getItem(
      pendingAdmissionStorageKey(userId),
    );
    const parsed: unknown = value ? JSON.parse(value) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (id): id is string =>
            typeof id === "string" && id.length > 0 && id.length <= 100,
        )
      : [];
  } catch {
    return [];
  }
}
function writePendingAdmissionIds(userId: string, ids: string[]) {
  if (typeof window === "undefined") return;
  try {
    const key = pendingAdmissionStorageKey(userId);
    if (ids.length === 0) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Storage can be unavailable in private browsing; live polling still works.
  }
}
const SPACE_TEMPLATES = [
  {
    id: "CAMPUS_SQUARE",
    nameKey: "spaceForm.template.campus",
    descriptionKey: "spaceForm.template.campusDescription",
    icon: Trees,
  },
  {
    id: "STUDY_SPACE",
    nameKey: "spaceForm.template.study",
    descriptionKey: "spaceForm.template.studyDescription",
    icon: BookOpen,
  },
  {
    id: "MEETUP_HALL",
    nameKey: "spaceForm.template.meetup",
    descriptionKey: "spaceForm.template.meetupDescription",
    icon: Mic2,
  },
] as const;
const SPACE_TEMPLATE_KEYS: Record<SpaceTemplateId, TranslationKey> = {
  OFFICE: "lobby.template.office",
  CAMPUS_SQUARE: "lobby.template.campus",
  STUDY_SPACE: "lobby.template.study",
  MEETUP_HALL: "lobby.template.meetup",
};
function visibilityTranslationKey(visibility: Visibility): TranslationKey {
  switch (visibility) {
    case "PRIVATE":
      return "lobby.visibility.private";
    case "UNLISTED":
      return "lobby.visibility.unlisted";
    default:
      return "lobby.visibility.public";
  }
}

type Modal =
  | { kind: "create" }
  | { kind: "edit" | "invites" | "members" | "operations"; space: Space };
type LobbyView = SpaceListView | "recent";
export function SpaceLobby({
  account,
  onEnter,
  onEditMap,
  signOut,
  signOutEverywhere,
  onProfileSaved,
  onAccountDeleted,
  children,
  brand,
}: {
  account: Account;
  onEnter: (space: Space, mapId?: string, reservationId?: string) => void;
  onEditMap: (space: Space) => void;
  signOut: () => void;
  signOutEverywhere: () => Promise<void>;
  onProfileSaved?: (account: Account) => void;
  onAccountDeleted: () => void;
  children?: ReactNode;
  brand: ReactNode;
}) {
  const { language, t } = useLanguage();
  const { confirm, prompt } = useDialogActions();
  const deletionKeyword = language === "en" ? "DELETE" : "탈퇴";
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [view, setView] = useState<LobbyView>("browse");
  const [recentSpaces, setRecentSpaces] = useState<Space[]>([]);
  const [recentRefresh, setRecentRefresh] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState<SpacePage>();
  const [favoriteSaving, setFavoriteSaving] = useState<Set<string>>(
    () => new Set(),
  );
  const [modal, setModal] = useState<Modal>();
  const [scheduleSpace, setScheduleSpace] = useState<Space>();
  const [extensionsSpace, setExtensionsSpace] = useState<Space>();
  const [profileOpen, setProfileOpen] = useState(false);
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [deletionImpact, setDeletionImpact] = useState<AccountDeletionImpact>();
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [deletionError, setDeletionError] = useState("");
  const [deletionLoading, setDeletionLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(() => api.pending("invite"));
  const pendingInviteCode = useRef(api.pending("invite"));
  const [invites, setInvites] = useState<Invite[]>([]);
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [accessBlocks, setAccessBlocks] = useState<SpaceAccessBlock[]>([]);
  const [joinRequests, setJoinRequests] = useState<SpaceJoinRequest[]>([]);
  const [joinRequestError, setJoinRequestError] = useState("");
  const [joinRequestsRefresh, setJoinRequestsRefresh] = useState(0);
  const [ownershipTransfer, setOwnershipTransfer] = useState<
    SpaceOwnershipTransfer[]
  >([]);
  const [operationsUpdatedAt, setOperationsUpdatedAt] = useState<number>();
  const [operationsRefresh, setOperationsRefresh] = useState(0);
  const [incomingOwnershipTransfers, setIncomingOwnershipTransfers] = useState<
    IncomingOwnershipTransfer[]
  >([]);
  const [incomingSpaceInvites, setIncomingSpaceInvites] = useState<
    IncomingSpaceInvite[]
  >([]);
  const [incomingSpaceInvitesLoading, setIncomingSpaceInvitesLoading] =
    useState(true);
  const [incomingSpaceInvitesError, setIncomingSpaceInvitesError] =
    useState("");
  const [admissionInbox, setAdmissionInbox] = useState<
    Array<{ spaceId: string; spaceName: string; request: SpaceJoinRequest }>
  >([]);
  const [admissionInboxLoading, setAdmissionInboxLoading] = useState(true);
  const [admissionInboxError, setAdmissionInboxError] = useState("");
  const [pendingAdmissionIds, setPendingAdmissionIds] = useState<string[]>(() =>
    readPendingAdmissionIds(account.userId),
  );
  const pendingAdmissionStatuses = useRef(
    new Map(pendingAdmissionIds.map((id) => [id, "PENDING"])),
  );
  const [createdCode, setCreatedCode] = useState("");
  const [hours, setHours] = useState(24);
  const [uses, setUses] = useState(10);
  const [targetInviteUserId, setTargetInviteUserId] = useState("");
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("calendar");
    if (!result) return;
    const messages: Record<string, TranslationKey> = {
      connected: "profile.calendarResult.connected",
      denied: "profile.calendarResult.denied",
      "login-required": "profile.calendarResult.login-required",
      expired: "profile.calendarResult.expired",
      reconnect: "profile.calendarResult.reconnect",
      unavailable: "profile.calendarResult.unavailable",
      failed: "profile.calendarResult.failed",
    };
    const message = messages[result];
    if (message) setNotice(t(message));
    url.searchParams.delete("calendar");
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash,
    );
  }, [t]);
  async function refresh() {
    if (view === "recent") {
      setRecentRefresh((value) => value + 1);
      return;
    }
    const result = await api.listSpaces({
      query: appliedSearch,
      view,
      page,
      pageSize: SPACE_PAGE_SIZE,
    });
    const lastPage = Math.max(1, result.totalPages);
    if (page > lastPage) {
      setPage(lastPage);
      return;
    }
    setSpaces(result.items);
    setPageInfo(result);
  }
  async function refreshIncomingOwnershipTransfers() {
    setIncomingOwnershipTransfers(await api.listIncomingOwnershipTransfers());
  }
  async function refreshIncomingSpaceInvites(showLoading = false) {
    if (showLoading) setIncomingSpaceInvitesLoading(true);
    try {
      setIncomingSpaceInvites(await api.listIncomingSpaceInvites());
      setIncomingSpaceInvitesError("");
    } catch (cause) {
      setIncomingSpaceInvitesError(
        language === "ko" && cause instanceof Error
          ? cause.message
          : t("lobby.error.incomingInvites"),
      );
    } finally {
      setIncomingSpaceInvitesLoading(false);
    }
  }
  async function refreshAdmissionInbox(showLoading = false) {
    if (showLoading) setAdmissionInboxLoading(true);
    try {
      setAdmissionInbox(await api.listIncomingJoinRequests());
      setAdmissionInboxError("");
    } catch (cause) {
      setAdmissionInboxError(
        language === "ko" && cause instanceof Error
          ? cause.message
          : t("lobby.admissionInboxError"),
      );
    } finally {
      setAdmissionInboxLoading(false);
    }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAppliedSearch(search.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let active = true;
    if (view === "recent") {
      setLoading(true);
      setError("");
      setPageInfo(undefined);
      const visits = readRecentSpaceVisits(account.userId);
      Promise.all(
        visits.map(async (visit) => {
          try {
            return {
              visit,
              space: await api.getSpace(visit.spaceId),
            };
          } catch (cause) {
            if (
              cause instanceof AuthError &&
              (cause.status === 403 || cause.status === 404)
            )
              return undefined;
            throw cause;
          }
        }),
      )
        .then((results) => {
          if (!active) return;
          const readable = results.filter(
            (result): result is NonNullable<typeof result> => !!result,
          );
          setRecentSpaces(readable.map(({ space }) => space));
          writeRecentSpaceVisits(
            account.userId,
            readable.map(({ visit }) => visit),
          );
        })
        .catch((cause) => {
          if (!active) return;
          setRecentSpaces([]);
          setError(
            language === "ko" && cause instanceof Error
              ? cause.message
              : t("lobby.error.recentSpaces"),
          );
        })
        .finally(() => {
          if (active) setLoading(false);
        });
      return () => {
        active = false;
      };
    }
    api
      .listSpaces({
        query: appliedSearch,
        view,
        page,
        pageSize: SPACE_PAGE_SIZE,
      })
      .then((data) => {
        if (active) {
          const lastPage = Math.max(1, data.totalPages);
          if (page > lastPage) {
            setPage(lastPage);
            return;
          }
          setSpaces(data.items);
          setPageInfo(data);
          setError("");
        }
      })
      .catch((e) => {
        if (active) {
          setSpaces([]);
          setPageInfo(undefined);
          setError(language === "ko" ? e.message : t("lobby.error.generic"));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    setLoading(true);
    return () => {
      active = false;
    };
  }, [account.userId, appliedSearch, recentRefresh, view, page, language, t]);
  useEffect(() => {
    let active = true;
    const load = () => {
      void api
        .listIncomingOwnershipTransfers()
        .then((items) => {
          if (active) setIncomingOwnershipTransfers(items);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 15000);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, []);
  useEffect(() => {
    let active = true;
    let refreshing = false;
    const load = () => {
      if (refreshing) return;
      refreshing = true;
      void api
        .listIncomingSpaceInvites()
        .then((items) => {
          if (active) {
            setIncomingSpaceInvites(items);
            setIncomingSpaceInvitesError("");
          }
        })
        .catch((cause) => {
          if (active)
            setIncomingSpaceInvitesError(
              language === "ko" && cause instanceof Error
                ? cause.message
                : t("lobby.error.incomingInvites"),
            );
        })
        .finally(() => {
          refreshing = false;
          if (active) setIncomingSpaceInvitesLoading(false);
        });
    };
    load();
    const timer = window.setInterval(load, 15000);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [language, t]);
  useEffect(() => {
    let refreshing = false;
    const load = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        await refreshAdmissionInbox();
      } finally {
        refreshing = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    window.addEventListener("focus", load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [account.userId, language, t]);
  useEffect(() => {
    let active = true;
    const destination = api.pending("space");
    if (destination)
      api
        .getSpace(destination)
        .then((space) => {
          if (active) {
            api.clearPending("space");
            enterOrRequest(space);
          }
        })
        .catch((e) => {
          if (active) {
            setError(language === "ko" ? e.message : t("lobby.error.generic"));
            api.clearPending("space");
          }
        });
    return () => {
      active = false;
    };
    // The pending destination belongs to this mount, not to every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const joinRequestSpaceId =
    modal?.kind === "members" && modal.space.approvalRequired
      ? modal.space.id
      : "";
  useEffect(() => {
    if (!joinRequestSpaceId) return;
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const items = await api.listJoinRequests(joinRequestSpaceId);
        if (active) {
          setJoinRequests(items);
          setJoinRequestError("");
        }
      } catch {
        if (active) setJoinRequestError(t("lobby.error.joinRequestRefresh"));
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [joinRequestSpaceId, joinRequestsRefresh, t]);
  const operationsSpaceId = modal?.kind === "operations" ? modal.space.id : "";
  useEffect(() => {
    if (!operationsSpaceId) return;
    let active = true;
    let refreshing = false;
    const refreshOperations = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const currentSpace = await api.getSpace(operationsSpaceId);
        if (!active) return;
        setSpaces((current) =>
          current.map((space) =>
            space.id === operationsSpaceId ? currentSpace : space,
          ),
        );
        setRecentSpaces((current) =>
          current.map((space) =>
            space.id === operationsSpaceId ? currentSpace : space,
          ),
        );
        if (currentSpace.role !== "OWNER" && currentSpace.role !== "ADMIN") {
          setModal(undefined);
          setError(t("lobby.error.spaceAccessChanged"));
          return;
        }
        const [nextMembers, nextRequests, nextInvites, nextBlocks] =
          await Promise.all([
            api.listMembers(operationsSpaceId),
            api.listJoinRequests(operationsSpaceId),
            api.listInvites(operationsSpaceId),
            api.listAccessBlocks(operationsSpaceId),
          ]);
        if (!active) return;
        setModal((current) =>
          current?.kind === "operations" &&
          current.space.id === operationsSpaceId
            ? { ...current, space: currentSpace }
            : current,
        );
        setMembers(nextMembers);
        setJoinRequests(nextRequests);
        setInvites(nextInvites);
        setAccessBlocks(nextBlocks);
        setOperationsUpdatedAt(Date.now());
        setError("");
      } catch (cause) {
        if (!active) return;
        if (
          cause instanceof AuthError &&
          (cause.status === 403 || cause.status === 404)
        ) {
          setModal(undefined);
          setError(t("lobby.error.spaceAccessChanged"));
          void refresh().catch(() => undefined);
        } else {
          setError(
            language === "ko" && cause instanceof Error
              ? cause.message
              : t("lobby.error.operations"),
          );
        }
      } finally {
        refreshing = false;
      }
    };
    void refreshOperations();
    const timer = window.setInterval(() => void refreshOperations(), 15000);
    window.addEventListener("focus", refreshOperations);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOperations);
    };
  }, [operationsSpaceId, operationsRefresh, language, t]);
  useEffect(() => {
    let approvedSpace: Space | undefined;
    let rejectedSpace: Space | undefined;
    for (const space of spaces) {
      const previousStatus = pendingAdmissionStatuses.current.get(space.id);
      if (previousStatus === "PENDING" && space.role) {
        approvedSpace = space;
        pendingAdmissionStatuses.current.delete(space.id);
        continue;
      }
      if (
        previousStatus === "PENDING" &&
        space.joinRequestStatus === "REJECTED"
      ) {
        rejectedSpace = space;
        pendingAdmissionStatuses.current.delete(space.id);
        continue;
      }
      if (space.joinRequestStatus === "PENDING")
        pendingAdmissionStatuses.current.set(space.id, "PENDING");
      else pendingAdmissionStatuses.current.delete(space.id);
    }
    const nextPendingIds = Array.from(pendingAdmissionStatuses.current.keys());
    writePendingAdmissionIds(account.userId, nextPendingIds);
    setPendingAdmissionIds((current) =>
      current.length === nextPendingIds.length &&
      current.every((id, index) => id === nextPendingIds[index])
        ? current
        : nextPendingIds,
    );
    if (approvedSpace) {
      setNotice(
        t("lobby.notice.admissionApproved", { name: approvedSpace.name }),
      );
      beginEntry(approvedSpace);
    } else if (rejectedSpace) {
      setNotice(
        t("lobby.notice.admissionRejected", { name: rejectedSpace.name }),
      );
    }
  }, [account.userId, spaces, onEnter, t]);
  useEffect(() => {
    if (pendingAdmissionIds.length === 0) return;
    let active = true;
    let refreshing = false;
    const refreshPendingAdmissions = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const results = await Promise.allSettled(
          pendingAdmissionIds.map((id) => api.getSpace(id)),
        );
        if (!active) return;
        const updatedSpaces: Space[] = [];
        results.forEach((result, index) => {
          if (result.status === "fulfilled") updatedSpaces.push(result.value);
          else if (
            result.reason instanceof AuthError &&
            (result.reason.status === 403 || result.reason.status === 404)
          )
            pendingAdmissionStatuses.current.delete(pendingAdmissionIds[index]);
        });
        setSpaces((current) =>
          current.map(
            (space) =>
              updatedSpaces.find((updated) => updated.id === space.id) ?? space,
          ),
        );
        let approvedSpace: Space | undefined;
        let rejectedSpace: Space | undefined;
        for (const space of updatedSpaces) {
          const previousStatus = pendingAdmissionStatuses.current.get(space.id);
          if (previousStatus === "PENDING" && space.role) {
            approvedSpace ??= space;
            pendingAdmissionStatuses.current.delete(space.id);
          } else if (
            previousStatus === "PENDING" &&
            space.joinRequestStatus === "REJECTED"
          ) {
            rejectedSpace ??= space;
            pendingAdmissionStatuses.current.delete(space.id);
          }
        }
        const nextPendingIds = Array.from(
          pendingAdmissionStatuses.current.keys(),
        );
        writePendingAdmissionIds(account.userId, nextPendingIds);
        setPendingAdmissionIds((current) =>
          current.length === nextPendingIds.length &&
          current.every((id, index) => id === nextPendingIds[index])
            ? current
            : nextPendingIds,
        );
        const hasTransientFailure = results.some(
          (result) =>
            result.status === "rejected" &&
            (!(result.reason instanceof AuthError) ||
              (result.reason.status !== 403 && result.reason.status !== 404)),
        );
        const hasUnavailableAdmission = results.some(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof AuthError &&
            (result.reason.status === 403 || result.reason.status === 404),
        );
        if (hasUnavailableAdmission)
          setNotice(t("lobby.error.spaceAccessChanged"));
        if (hasTransientFailure) setError(t("lobby.error.joinStateRefresh"));
        else
          setError((current) =>
            current === t("lobby.error.joinStateRefresh") ? "" : current,
          );
        if (approvedSpace) {
          setNotice(
            t("lobby.notice.admissionApproved", { name: approvedSpace.name }),
          );
          beginEntry(approvedSpace);
        } else if (rejectedSpace) {
          setNotice(
            t("lobby.notice.admissionRejected", { name: rejectedSpace.name }),
          );
        }
      } finally {
        refreshing = false;
      }
    };
    void refreshPendingAdmissions();
    const timer = window.setInterval(
      () => void refreshPendingAdmissions(),
      10000,
    );
    window.addEventListener("focus", refreshPendingAdmissions);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshPendingAdmissions);
    };
  }, [account.userId, pendingAdmissionIds, t]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(
        language === "ko" && e instanceof Error
          ? e.message
          : t("lobby.error.generic"),
      );
    } finally {
      setBusy(false);
    }
  }
  function resolveAdmissionRequest(
    request: SpaceJoinRequest,
    decision: "APPROVE" | "REJECT",
  ) {
    if (modal?.kind !== "members") return;
    const spaceId = modal.space.id;
    const confirmation =
      decision === "APPROVE"
        ? t("lobby.notice.requestApproved", { name: request.displayName })
        : t("lobby.notice.requestRejected", { name: request.displayName });
    void run(async () => {
      await api.resolveJoinRequest(spaceId, request.id, decision);
      setNotice(confirmation);
      try {
        setJoinRequests(await api.listJoinRequests(spaceId));
        setJoinRequestError("");
      } catch {
        setJoinRequestError(t("lobby.notice.requestRefreshFailed"));
      }
    });
  }
  function resolveInboxAdmissionRequest(
    item: (typeof admissionInbox)[number],
    decision: "APPROVE" | "REJECT",
  ) {
    const confirmation =
      decision === "APPROVE"
        ? t("lobby.notice.requestApproved", {
            name: item.request.displayName,
          })
        : t("lobby.notice.requestRejected", {
            name: item.request.displayName,
          });
    void run(async () => {
      await api.resolveJoinRequest(item.spaceId, item.request.id, decision);
      setAdmissionInbox((current) =>
        current.filter((entry) => entry.request.id !== item.request.id),
      );
      if (modal?.kind === "members" && modal.space.id === item.spaceId)
        setJoinRequests((current) =>
          current.filter((request) => request.id !== item.request.id),
        );
      setNotice(confirmation);
      await refreshAdmissionInbox();
    });
  }
  async function toggleFavorite(space: Space) {
    if (favoriteSaving.has(space.id)) return;
    const nextFavorite = !space.favorite;
    setFavoriteSaving((current) => new Set(current).add(space.id));
    setError("");
    setSpaces((current) =>
      current.map((item) =>
        item.id === space.id ? { ...item, favorite: nextFavorite } : item,
      ),
    );
    try {
      await api.setSpaceFavorite(space.id, nextFavorite);
      if (view === "favorites") {
        try {
          await refresh();
        } catch (e) {
          setError(
            language === "ko" && e instanceof Error
              ? e.message
              : t("lobby.error.refresh"),
          );
        }
      }
    } catch (e) {
      setSpaces((current) =>
        current.map((item) =>
          item.id === space.id ? { ...item, favorite: space.favorite } : item,
        ),
      );
      setError(
        language === "ko" && e instanceof Error
          ? e.message
          : t("lobby.error.favorite"),
      );
    } finally {
      setFavoriteSaving((current) => {
        const next = new Set(current);
        next.delete(space.id);
        return next;
      });
    }
  }
  async function archive(space: Space) {
    if (space.role !== "OWNER" || view === "archived") return;
    if (!(await confirm(t("lobby.confirm.archive", { name: space.name }))))
      return;
    await run(async () => {
      await api.archiveSpace(space.id);
      await refresh();
      setNotice(t("lobby.notice.spaceArchived", { name: space.name }));
    });
  }
  async function restore(space: Space) {
    if (space.role !== "OWNER" || view !== "archived") return;
    await run(async () => {
      await api.restoreSpace(space.id);
      await refresh();
      setNotice(t("lobby.notice.spaceRestored", { name: space.name }));
    });
  }
  async function clone(space: Space) {
    if (space.role !== "OWNER" || view === "archived") return;
    const nameInput = await prompt(
      t("lobby.confirm.clone", { name: space.name }),
      {
        initialValue: t("lobby.cloneName", { name: space.name }),
        label: t("lobby.cloneNameField"),
        maxLength: 60,
      },
    );
    if (nameInput === undefined) return;
    const name = nameInput.trim();
    if (!name || name.length > 60) {
      setError(t("lobby.error.nameLimit"));
      return;
    }
    await run(async () => {
      const created = await api.cloneSpace(space.id, name);
      setSearch("");
      setAppliedSearch("");
      setPage(1);
      setView("mine");
      const mine = await api.listSpaces({
        query: "",
        view: "mine",
        page: 1,
        pageSize: SPACE_PAGE_SIZE,
      });
      const included = mine.items.some((item) => item.id === created.id);
      const items = included
        ? mine.items
        : [created, ...mine.items].slice(0, SPACE_PAGE_SIZE);
      const totalItems = mine.totalItems + (included ? 0 : 1);
      const totalPages = Math.max(1, Math.ceil(totalItems / SPACE_PAGE_SIZE));
      setSpaces(items);
      setPageInfo({
        ...mine,
        items,
        totalItems,
        totalPages,
        hasNext: totalPages > 1,
        hasPrevious: false,
      });
      setNotice(t("lobby.notice.spaceCloned", { name: created.name }));
    });
  }
  function open(value: Modal) {
    setError("");
    setNotice("");
    setCreatedCode("");
    setInvites([]);
    setMembers([]);
    setAccessBlocks([]);
    setJoinRequests([]);
    setOwnershipTransfer([]);
    setOperationsUpdatedAt(undefined);
    setOperationsRefresh(0);
    setModal(value);
  }
  function openMembers(space: Space) {
    open({ kind: "members", space });
    void run(async () => {
      const [nextMembers, nextBlocks, nextTransfer] = await Promise.all([
        api.listMembers(space.id),
        api.listAccessBlocks(space.id),
        space.role === "OWNER"
          ? api.listOwnershipTransfer(space.id)
          : Promise.resolve([]),
      ]);
      setMembers(nextMembers);
      setAccessBlocks(nextBlocks);
      setOwnershipTransfer(nextTransfer);
    });
  }
  function openInvites(space: Space) {
    setTargetInviteUserId("");
    setCreatedCode("");
    open({ kind: "invites", space });
    void run(async () => {
      setInvites(await api.listInvites(space.id));
    });
  }
  const close = () => {
    if (!busy) {
      setModal(undefined);
      setError("");
    }
  };
  const upsert = (space: Space) =>
    setSpaces((current) => [
      space,
      ...current.filter((s) => s.id !== space.id),
    ]);
  const visible =
    view === "recent"
      ? recentSpaces.filter((space) =>
          `${space.name} ${space.description}`
            .toLocaleLowerCase()
            .includes(appliedSearch.toLocaleLowerCase()),
        )
      : view === "favorites"
        ? spaces.filter((space) => space.favorite)
        : spaces;
  const alert = error && (
    <p className="space-error" role="alert">
      {error}
    </p>
  );
  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setNotice(t("lobby.notice.copy"));
  }
  async function openDeletion() {
    setProfileOpen(false);
    setDeletionOpen(true);
    setDeletionImpact(undefined);
    setDeletionConfirmation("");
    setDeletionError("");
    setDeletionLoading(true);
    try {
      setDeletionImpact(await getAccountDeletionImpact());
    } catch (e) {
      setDeletionError(
        language === "ko" && e instanceof Error
          ? e.message
          : t("lobby.error.deletionImpact"),
      );
    } finally {
      setDeletionLoading(false);
    }
  }
  async function submitDeletion() {
    if (
      busy ||
      deletionLoading ||
      deletionImpact?.ownedSpaces.length ||
      deletionConfirmation !== deletionKeyword
    )
      return;
    setBusy(true);
    setDeletionError("");
    try {
      await deleteCurrentAccount(deletionConfirmation);
      onAccountDeleted();
    } catch (e) {
      setDeletionError(
        language === "ko" && e instanceof Error
          ? e.message
          : t("lobby.error.deletion"),
      );
      setBusy(false);
    }
  }
  function enterOrRequest(
    space: Space,
    mapId?: string,
    reservationId?: string,
  ) {
    if (!space.approvalRequired || space.role) {
      beginEntry(space, mapId, reservationId);
      return;
    }
    if (space.joinRequestStatus === "PENDING") {
      setSpaces((current) =>
        current.some((item) => item.id === space.id)
          ? current
          : [space, ...current],
      );
      setNotice(t("lobby.notice.admissionPending"));
      return;
    }
    setSpaces((current) =>
      current.some((item) => item.id === space.id)
        ? current
        : [space, ...current],
    );
    void run(async () => {
      const result = await api.requestJoin(space.id);
      if (result.status === "PENDING") {
        pendingAdmissionStatuses.current.set(space.id, "PENDING");
        const nextPendingIds = Array.from(
          pendingAdmissionStatuses.current.keys(),
        );
        writePendingAdmissionIds(account.userId, nextPendingIds);
        setPendingAdmissionIds(nextPendingIds);
        setSpaces((current) =>
          current.map((item) =>
            item.id === space.id
              ? { ...item, joinRequestStatus: "PENDING" }
              : item,
          ),
        );
        setNotice(t("lobby.notice.admissionRequested"));
      } else {
        await refresh();
        setNotice(t("lobby.notice.alreadyMember"));
      }
    });
  }
  function beginEntry(space: Space, mapId?: string, reservationId?: string) {
    pendingAdmissionStatuses.current.delete(space.id);
    const nextPendingIds = Array.from(pendingAdmissionStatuses.current.keys());
    writePendingAdmissionIds(account.userId, nextPendingIds);
    setPendingAdmissionIds(nextPendingIds);
    onEnter(space, mapId, reservationId);
  }
  return (
    <div className="space-home">
      <header className="space-header">
        {brand}
        <div className="space-account">
          <Avatar id={account.avatar} size={34} appearance={account} />
          <span>
            <strong>{account.displayName}</strong>
            <small>{t("lobby.signedIn")}</small>
          </span>
          <button
            className="text-button"
            onClick={() => setProfileOpen(true)}
            disabled={busy}
          >
            {t("lobby.editProfile")}
          </button>
          <button className="text-button" onClick={signOut} disabled={busy}>
            {t("lobby.signOut")}
          </button>
          <LanguagePicker />
        </div>
      </header>
      <main className="space-main">
        <section className="space-hero">
          <div>
            <h1>{t("lobby.heroTitle")}</h1>
            <p>{t("lobby.heroDescription")}</p>
            <button
              className="space-primary"
              onClick={() => open({ kind: "create" })}
            >
              <Plus size={18} /> {t("lobby.createSpace")}
            </button>
          </div>
          <img
            src={ASSET_GROUPS.brand.campusIllustration}
            alt={t("lobby.campusIllustration")}
          />
        </section>
        <form
          className={`invite-entry${pendingInviteCode.current && code === pendingInviteCode.current ? " has-pending-invite" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const space = await api.redeemInvite(api.inviteCode(code));
              api.clearPending("invite");
              pendingInviteCode.current = "";
              setCode("");
              upsert(space);
              beginEntry(space);
            });
          }}
        >
          <Ticket size={21} />
          <label htmlFor="invite-code">{t("lobby.inviteTitle")}</label>
          <input
            id="invite-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("lobby.invitePlaceholder")}
            maxLength={2048}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="space-secondary" disabled={busy || !code.trim()}>
            {t("lobby.inviteAccept")} <ArrowRight size={16} />
          </button>
        </form>
        {!modal &&
          pendingInviteCode.current &&
          code === pendingInviteCode.current && (
            <p className="invite-link-ready" role="status">
              {t("lobby.inviteLinkReady")}
            </p>
          )}
        {!modal && alert}
        {!modal && notice && (
          <p className="space-notice" role="status">
            {notice}
          </p>
        )}
        {!modal &&
          (incomingSpaceInvites.length > 0 ||
            incomingSpaceInvitesLoading ||
            incomingSpaceInvitesError) && (
            <section
              className="ownership-transfer-inbox space-invitation-inbox"
              aria-label={t("lobby.invitationInbox")}
            >
              <div className="ownership-transfer-inbox-heading">
                <Mail size={19} />
                <div className="space-invitation-inbox-title">
                  <h2>{t("lobby.invitationInbox")}</h2>
                  <p>{t("lobby.invitationDescription")}</p>
                </div>
                <button
                  type="button"
                  className="text-button invitation-inbox-refresh"
                  disabled={incomingSpaceInvitesLoading}
                  onClick={() => void refreshIncomingSpaceInvites(true)}
                  aria-label={t("lobby.invitationRefresh")}
                >
                  <RefreshCw size={14} /> {t("lobby.refreshShort")}
                </button>
              </div>
              {incomingSpaceInvitesLoading &&
                incomingSpaceInvites.length === 0 && (
                  <p className="invitation-inbox-status" role="status">
                    {t("lobby.invitationLoading")}
                  </p>
                )}
              {incomingSpaceInvitesError && (
                <div className="invitation-inbox-error" role="alert">
                  <span>{incomingSpaceInvitesError}</span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void refreshIncomingSpaceInvites(true)}
                  >
                    {t("lobby.retry")}
                  </button>
                </div>
              )}
              {incomingSpaceInvites.map((invite) => (
                <article
                  className="ownership-transfer-card"
                  key={invite.inviteId}
                >
                  <div>
                    <strong>{invite.spaceName}</strong>
                    <p>
                      {t("lobby.invitationFrom", {
                        name: invite.inviterDisplayName,
                      })}
                    </p>
                    <small>
                      {t("lobby.spaceOwner", {
                        name: invite.ownerDisplayName,
                      })}
                    </small>
                    <small>
                      {t("lobby.expires", {
                        date: formatDate(language, invite.expiresAt, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }),
                      })}
                    </small>
                  </div>
                  <div className="ownership-transfer-actions">
                    <button
                      className="space-primary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const space = await api.acceptSpaceInvite(
                            invite.inviteId,
                          );
                          setIncomingSpaceInvites((items) =>
                            items.filter(
                              (item) => item.inviteId !== invite.inviteId,
                            ),
                          );
                          void refreshIncomingSpaceInvites();
                          setSearch("");
                          setAppliedSearch("");
                          setView("mine");
                          setPage(1);
                          upsert(space);
                          beginEntry(space);
                        })
                      }
                    >
                      {t("lobby.accept")}
                    </button>
                    <button
                      className="text-button member-remove"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api.declineSpaceInvite(invite.inviteId);
                          setIncomingSpaceInvites((items) =>
                            items.filter(
                              (item) => item.inviteId !== invite.inviteId,
                            ),
                          );
                          await refreshIncomingSpaceInvites();
                          setNotice(
                            t("lobby.notice.inviteDeclined", {
                              name: invite.spaceName,
                            }),
                          );
                        })
                      }
                    >
                      {t("lobby.decline")}
                    </button>
                  </div>
                </article>
              ))}
            </section>
          )}
        {!modal &&
          (admissionInbox.length > 0 ||
            admissionInboxLoading ||
            admissionInboxError) && (
            <section
              className="ownership-transfer-inbox admission-request-inbox"
              aria-label={t("lobby.admissionInbox")}
            >
              <div className="ownership-transfer-inbox-heading">
                <Users size={19} />
                <div>
                  <h2>
                    {t("lobby.admissionInbox")}{" "}
                    {admissionInbox.length > 0 && (
                      <span className="admission-request-count">
                        {formatNumber(language, admissionInbox.length)}
                      </span>
                    )}
                  </h2>
                  <p>{t("lobby.admissionInboxDescription")}</p>
                </div>
                <button
                  type="button"
                  className="text-button invitation-inbox-refresh"
                  disabled={admissionInboxLoading}
                  onClick={() => void refreshAdmissionInbox(true)}
                  aria-label={t("lobby.admissionInboxRefresh")}
                >
                  <RefreshCw size={14} /> {t("lobby.refreshShort")}
                </button>
              </div>
              {admissionInboxLoading && admissionInbox.length === 0 && (
                <p className="invitation-inbox-status" role="status">
                  {t("lobby.admissionInboxLoading")}
                </p>
              )}
              {admissionInboxError && (
                <div className="invitation-inbox-error" role="alert">
                  <span>{admissionInboxError}</span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void refreshAdmissionInbox(true)}
                  >
                    {t("lobby.retry")}
                  </button>
                </div>
              )}
              {admissionInbox.map((item) => (
                <article
                  className="ownership-transfer-card admission-request-card"
                  key={`${item.spaceId}:${item.request.id}`}
                >
                  <div>
                    <strong>{item.request.displayName}</strong>
                    <p>
                      {t("lobby.admissionRequestFrom", {
                        space: item.spaceName,
                      })}
                    </p>
                    <small>
                      {formatDate(
                        language,
                        new Date(item.request.requestedAt).toISOString(),
                        { dateStyle: "medium", timeStyle: "short" },
                      )}
                    </small>
                  </div>
                  <div className="ownership-transfer-actions">
                    <button
                      type="button"
                      className="space-primary"
                      disabled={busy}
                      onClick={() =>
                        resolveInboxAdmissionRequest(item, "APPROVE")
                      }
                    >
                      {t("lobby.accept")}
                    </button>
                    <button
                      type="button"
                      className="text-button member-remove"
                      disabled={busy}
                      onClick={() =>
                        resolveInboxAdmissionRequest(item, "REJECT")
                      }
                    >
                      {t("lobby.decline")}
                    </button>
                  </div>
                </article>
              ))}
            </section>
          )}
        {incomingOwnershipTransfers.length > 0 && (
          <section
            className="ownership-transfer-inbox"
            aria-label={t("lobby.transferInbox")}
          >
            <div className="ownership-transfer-inbox-heading">
              <ArrowLeftRight size={19} />
              <div>
                <h2>{t("lobby.transferInbox")}</h2>
                <p>{t("lobby.transferDescription")}</p>
              </div>
            </div>
            {incomingOwnershipTransfers.map((transfer) => (
              <article
                className="ownership-transfer-card"
                key={transfer.spaceId}
              >
                <div>
                  <strong>{transfer.spaceName}</strong>
                  <p>
                    {t("lobby.transferRequestedBy", {
                      name: transfer.ownerDisplayName,
                    })}
                  </p>
                  <small>
                    {t("lobby.transferExpires", {
                      date: formatDate(language, transfer.expiresAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })}
                  </small>
                </div>
                <div className="ownership-transfer-actions">
                  <button
                    className="space-primary"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        !(await confirm(
                          t("lobby.transferAcceptConfirm", {
                            name: transfer.spaceName,
                          }),
                        ))
                      )
                        return;
                      void run(async () => {
                        const result = await api.respondOwnershipTransfer(
                          transfer.spaceId,
                          "ACCEPT",
                        );
                        await refreshIncomingOwnershipTransfers();
                        if (result.status === "ACCEPTED") {
                          setView("mine");
                          setPage(1);
                          const mine = await api.listSpaces({
                            query: appliedSearch,
                            view: "mine",
                            page: 1,
                            pageSize: SPACE_PAGE_SIZE,
                          });
                          setSpaces(mine.items);
                          setPageInfo(mine);
                          setNotice(
                            t("lobby.notice.transferAccepted", {
                              name: transfer.spaceName,
                            }),
                          );
                        } else {
                          setNotice(
                            result.status === "EXPIRED"
                              ? t("lobby.notice.transferExpired")
                              : t("lobby.notice.transferRefresh"),
                          );
                        }
                      });
                    }}
                  >
                    {t("lobby.accept")}
                  </button>
                  <button
                    className="text-button member-remove"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.respondOwnershipTransfer(
                          transfer.spaceId,
                          "DECLINE",
                        );
                        await refreshIncomingOwnershipTransfers();
                        setNotice(
                          t("lobby.notice.transferDeclined", {
                            name: transfer.spaceName,
                          }),
                        );
                      })
                    }
                  >
                    {t("lobby.decline")}
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}
        <div className="space-toolbar">
          <div role="group" aria-label={t("lobby.tabs")}>
            <button
              className={view === "browse" ? "selected" : ""}
              aria-pressed={view === "browse"}
              onClick={() => {
                setView("browse");
                setPage(1);
              }}
            >
              {t("lobby.browse")}
            </button>
            <button
              className={view === "recent" ? "selected" : ""}
              aria-pressed={view === "recent"}
              onClick={() => {
                setView("recent");
                setPage(1);
              }}
            >
              {t("lobby.recent")}
            </button>
            <button
              className={view === "mine" ? "selected" : ""}
              aria-pressed={view === "mine"}
              onClick={() => {
                setView("mine");
                setPage(1);
              }}
            >
              {t("lobby.mine")}
            </button>
            <button
              className={view === "favorites" ? "selected" : ""}
              aria-pressed={view === "favorites"}
              onClick={() => {
                setView("favorites");
                setPage(1);
              }}
            >
              {t("lobby.favorites")}
            </button>
            <button
              className={view === "archived" ? "selected" : ""}
              aria-pressed={view === "archived"}
              onClick={() => {
                setView("archived");
                setPage(1);
              }}
            >
              {t("lobby.archived")}
            </button>
          </div>
          <label className="space-search">
            <Search size={17} />
            <input
              aria-label={t("lobby.search")}
              placeholder={t("lobby.search")}
              value={search}
              maxLength={100}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <button
            className="icon-button"
            aria-label={t("lobby.refresh")}
            disabled={busy}
            onClick={() => void run(refresh)}
          >
            <RefreshCw size={18} />
          </button>
        </div>
        {!loading &&
          (view === "recent"
            ? visible.length > 0
            : (pageInfo?.totalItems ?? 0) > 0) && (
            <p className="space-result-count" aria-live="polite">
              {t("lobby.spaceCount", {
                count: formatNumber(
                  language,
                  view === "recent"
                    ? visible.length
                    : (pageInfo?.totalItems ?? 0),
                ),
              })}
            </p>
          )}
        {loading ? (
          <p role="status" className="space-empty">
            {t("lobby.loading")}
          </p>
        ) : visible.length === 0 ? (
          <div className="space-empty">
            <Leaf size={32} />
            <h2>
              {view === "recent"
                ? search
                  ? t("lobby.emptyRecentSearch")
                  : t("lobby.emptyRecent")
                : search
                  ? t("lobby.emptySearch")
                  : view === "favorites"
                    ? t("lobby.emptyFavorites")
                    : view === "archived"
                      ? t("lobby.emptyArchived")
                      : view === "mine"
                        ? t("lobby.emptyMine")
                        : t("lobby.emptyBrowse")}
            </h2>
            <p>
              {view === "favorites"
                ? t("lobby.emptyFavoritesHint")
                : view === "archived"
                  ? t("lobby.emptyArchivedHint")
                  : view === "recent"
                    ? t("lobby.emptyRecentHint")
                    : t("lobby.emptyBrowseHint")}
            </p>
          </div>
        ) : (
          <div className="space-grid">
            {visible.map((s, index) => (
              <article key={s.id} className="space-card">
                <button
                  className={`space-cover cover-${index % 3}`}
                  onClick={() => view !== "archived" && enterOrRequest(s)}
                  disabled={view === "archived"}
                  aria-label={`${s.name} ${view === "archived" ? t("lobby.archivedSpace") : s.approvalRequired && !s.role ? t("lobby.admissionRequest") : t("lobby.enterPrepare")}`}
                >
                  {view === "archived" ? (
                    <span className="archived-cover-label">
                      <Archive size={24} /> {t("lobby.archivedSpace")}
                    </span>
                  ) : (
                    <OfficePreview spaceId={s.id} />
                  )}
                  <span className="visibility-badge">
                    {view === "archived" ? (
                      <Archive size={13} />
                    ) : s.visibility === "PRIVATE" ? (
                      <LockKeyhole size={13} />
                    ) : s.visibility === "UNLISTED" ? (
                      <Link2 size={13} />
                    ) : (
                      <Globe2 size={13} />
                    )}
                    {view === "archived"
                      ? t("lobby.archivedBadge")
                      : t(visibilityTranslationKey(s.visibility))}
                  </span>
                  {(s.role === "OWNER" || s.role === "ADMIN") && (
                    <span className="owner-badge">
                      {s.role === "OWNER" ? t("lobby.owner") : t("lobby.admin")}
                    </span>
                  )}
                </button>
                <div className="space-card-body">
                  <h2>{s.name}</h2>
                  <p>{s.description || t("lobby.cardDescription")}</p>
                  <span className="space-capacity">
                    <Users size={14} />
                    {t("lobby.capacity", {
                      count: formatNumber(language, s.capacity),
                      template: t(SPACE_TEMPLATE_KEYS[s.templateId]),
                    })}
                  </span>
                  {s.approvalRequired && (
                    <span className="approval-label">
                      {s.role
                        ? t("lobby.approvalRequired")
                        : s.joinRequestStatus === "PENDING"
                          ? t("lobby.approvalPending")
                          : t("lobby.approvalNeeded")}
                    </span>
                  )}
                  <div className="space-card-actions">
                    {view === "archived" ? (
                      s.role === "OWNER" && (
                        <button
                          className="space-secondary restore-space"
                          disabled={busy}
                          aria-label={`${s.name} ${t("lobby.restore")}`}
                          onClick={() => void restore(s)}
                        >
                          <ArchiveRestore size={17} /> {t("lobby.restore")}
                        </button>
                      )
                    ) : (
                      <>
                        <button
                          className="icon-button"
                          title={t("lobby.schedule")}
                          aria-label={`${s.name} ${t("lobby.schedule")}`}
                          onClick={() => setScheduleSpace(s)}
                        >
                          <CalendarDays size={17} />
                        </button>
                        <button
                          className="space-secondary enter-space"
                          onClick={() => enterOrRequest(s)}
                          disabled={
                            busy ||
                            (s.approvalRequired &&
                              !s.role &&
                              s.joinRequestStatus === "PENDING")
                          }
                        >
                          {s.approvalRequired && !s.role
                            ? s.joinRequestStatus === "PENDING"
                              ? t("lobby.approvalPending")
                              : s.joinRequestStatus === "REJECTED"
                                ? t("lobby.admissionAgain")
                                : t("lobby.admissionRequest")
                            : t("lobby.enter")}{" "}
                          <ArrowRight size={16} />
                        </button>
                        <button
                          className={`icon-button space-favorite${s.favorite ? " selected" : ""}`}
                          title={
                            s.favorite
                              ? t("lobby.favoriteRemove")
                              : t("lobby.favoriteAdd")
                          }
                          aria-label={`${s.name} ${s.favorite ? t("lobby.favoriteRemove") : t("lobby.favoriteAdd")}`}
                          aria-pressed={s.favorite}
                          disabled={favoriteSaving.has(s.id)}
                          onClick={() => void toggleFavorite(s)}
                        >
                          <Star
                            size={18}
                            fill={s.favorite ? "currentColor" : "none"}
                          />
                        </button>
                        {s.role && (
                          <button
                            className="icon-button"
                            title={t("lobby.extensions")}
                            aria-label={`${s.name} ${t("lobby.extensions")}`}
                            onClick={() => setExtensionsSpace(s)}
                          >
                            <Blocks size={18} />
                          </button>
                        )}
                        {s.visibility !== "PRIVATE" && (
                          <button
                            className="icon-button"
                            title={t("lobby.spaceLinkCopy")}
                            aria-label={t("lobby.spaceLinkCopyNamed", {
                              name: s.name,
                            })}
                            onClick={() =>
                              void run(() =>
                                copy(`${location.origin}/#space=${s.id}`),
                              )
                            }
                          >
                            <Link2 size={18} />
                          </button>
                        )}
                        {(s.role === "OWNER" || s.role === "ADMIN") && (
                          <>
                            <button
                              className="icon-button"
                              title={t("lobby.operations")}
                              aria-label={t("lobby.operationsNamed", {
                                name: s.name,
                              })}
                              onClick={() =>
                                open({ kind: "operations", space: s })
                              }
                            >
                              <Activity size={18} />
                            </button>
                            <button
                              className="icon-button"
                              title={t("lobby.editMap")}
                              aria-label={t("lobby.editMapNamed", {
                                name: s.name,
                              })}
                              onClick={() => onEditMap(s)}
                            >
                              <PencilRuler size={18} />
                            </button>
                            <button
                              className="icon-button"
                              title={t("lobby.manageInvites")}
                              aria-label={t("lobby.manageInvitesNamed", {
                                name: s.name,
                              })}
                              disabled={busy}
                              onClick={() => openInvites(s)}
                            >
                              <Ticket size={18} />
                            </button>
                            <button
                              className="icon-button"
                              title={t("lobby.manageMembers")}
                              aria-label={t("lobby.manageMembersNamed", {
                                name: s.name,
                              })}
                              disabled={busy}
                              onClick={() => openMembers(s)}
                            >
                              <UserMinus size={18} />
                            </button>
                            {s.role === "OWNER" && (
                              <>
                                <button
                                  className="icon-button"
                                  title={t("lobby.cloneSpace")}
                                  aria-label={t("lobby.cloneSpaceNamed", {
                                    name: s.name,
                                  })}
                                  disabled={busy}
                                  onClick={() => void clone(s)}
                                >
                                  <Copy size={18} />
                                </button>
                                <button
                                  className="icon-button"
                                  title={t("lobby.editSpace")}
                                  aria-label={t("lobby.editSpaceNamed", {
                                    name: s.name,
                                  })}
                                  onClick={() =>
                                    open({ kind: "edit", space: s })
                                  }
                                >
                                  <Settings2 size={18} />
                                </button>
                                <button
                                  className="icon-button"
                                  title={t("lobby.archiveSpace")}
                                  aria-label={t("lobby.archiveSpaceNamed", {
                                    name: s.name,
                                  })}
                                  disabled={busy}
                                  onClick={() => void archive(s)}
                                >
                                  <Archive size={18} />
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        {view !== "recent" &&
          !loading &&
          pageInfo &&
          pageInfo.totalPages > 1 && (
            <nav
              className="space-pagination"
              aria-label={t("lobby.pagination")}
            >
              <button
                className="space-secondary"
                disabled={!pageInfo.hasPrevious || loading}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                {t("lobby.previous")}
              </button>
              <span>
                {t("lobby.pageOf", {
                  page: formatNumber(language, pageInfo.page),
                  pages: formatNumber(language, pageInfo.totalPages),
                  count: formatNumber(language, pageInfo.totalItems),
                })}
              </span>
              <button
                className="space-secondary"
                disabled={!pageInfo.hasNext || loading}
                onClick={() => setPage((current) => current + 1)}
              >
                {t("lobby.next")}
              </button>
            </nav>
          )}
        <p className="space-footnote">{t("lobby.footer")}</p>
      </main>
      {modal && (
        <Dialog
          title={
            modal.kind === "create"
              ? t("lobby.modal.create")
              : modal.kind === "edit"
                ? t("lobby.modal.edit")
                : modal.kind === "invites"
                  ? t("lobby.modal.invites")
                  : modal.kind === "operations"
                    ? t("lobby.modal.operations")
                    : t("lobby.modal.members")
          }
          close={close}
        >
          {alert}
          {notice && (
            <p className="space-notice" role="status">
              {notice}
            </p>
          )}
          {modal.kind === "operations" ? (
            <section
              className="space-operations"
              aria-label={t("lobby.operation.aria")}
            >
              <p className="muted">
                {t("lobby.operation.description", {
                  name: modal.space.name,
                })}
              </p>
              {operationsUpdatedAt === undefined ? (
                <p role="status">{t("lobby.operation.loading")}</p>
              ) : (
                <>
                  <dl className="space-operation-stats">
                    <div>
                      <dt>{t("lobby.operation.role")}</dt>
                      <dd>
                        {modal.space.role === "OWNER"
                          ? t("lobby.role.owner")
                          : t("lobby.role.admin")}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("lobby.operation.visibility")}</dt>
                      <dd>
                        {t(visibilityTranslationKey(modal.space.visibility))}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("lobby.operation.capacity")}</dt>
                      <dd>
                        {t("lobby.operation.capacityValue", {
                          count: formatNumber(language, modal.space.capacity),
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("lobby.operation.members")}</dt>
                      <dd>
                        {t("lobby.operation.memberCount", {
                          count: formatNumber(language, members.length),
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("lobby.operation.admins")}</dt>
                      <dd>
                        {t("lobby.operation.memberCount", {
                          count: formatNumber(
                            language,
                            members.filter((member) => member.role === "ADMIN")
                              .length,
                          ),
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("lobby.operation.pending")}</dt>
                      <dd>
                        {t("lobby.operation.requestCount", {
                          count: formatNumber(language, joinRequests.length),
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("lobby.operation.invites")}</dt>
                      <dd>
                        {t("lobby.operation.inviteCount", {
                          count: formatNumber(
                            language,
                            invites.filter(
                              (invite) =>
                                !invite.revoked &&
                                invite.useCount < invite.maxUses &&
                                Date.parse(invite.expiresAt) >
                                  operationsUpdatedAt,
                            ).length,
                          ),
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("lobby.operation.blocked")}</dt>
                      <dd>
                        {t("lobby.operation.memberCount", {
                          count: formatNumber(language, accessBlocks.length),
                        })}
                      </dd>
                    </div>
                  </dl>
                  <p className="space-operations-config">
                    {modal.space.approvalRequired
                      ? t("lobby.operation.approvalOn")
                      : t("lobby.operation.approvalOff")}
                    {" · "}
                    {modal.space.guestEntryEnabled
                      ? t("lobby.operation.guestOn")
                      : t("lobby.operation.guestOff")}
                    {modal.space.allowedEmailDomains.length > 0 && (
                      <>
                        {" · "}
                        {t("lobby.operation.domains", {
                          count: formatNumber(
                            language,
                            modal.space.allowedEmailDomains.length,
                          ),
                        })}
                      </>
                    )}
                  </p>
                  <p className="space-operations-updated">
                    {t("lobby.operation.lastChecked", {
                      time: formatDate(language, operationsUpdatedAt, {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      }),
                    })}
                  </p>
                </>
              )}
              <div className="space-operations-actions">
                <button
                  type="button"
                  className="space-secondary"
                  onClick={() => setOperationsRefresh((value) => value + 1)}
                >
                  {t("lobby.operation.refresh")}
                </button>
                <button
                  type="button"
                  className="space-secondary"
                  onClick={() => openMembers(modal.space)}
                >
                  {t("lobby.operation.manageMembers")}
                </button>
                <button
                  type="button"
                  className="space-secondary"
                  onClick={() => openInvites(modal.space)}
                >
                  {t("lobby.operation.manageInvites")}
                </button>
                {modal.space.role === "OWNER" && (
                  <button
                    type="button"
                    className="space-secondary"
                    onClick={() => open({ kind: "edit", space: modal.space })}
                  >
                    {t("lobby.operation.edit")}
                  </button>
                )}
              </div>
            </section>
          ) : modal.kind === "members" ? (
            <div className="member-manager">
              <p className="muted">
                {t("lobby.members.description", {
                  name: modal.space.name,
                })}
              </p>
              {modal.space.role === "OWNER" && (
                <>
                  <h3>{t("lobby.members.transferTitle")}</h3>
                  {ownershipTransfer.length > 0 ? (
                    <div className="ownership-transfer-pending">
                      <p>
                        <strong>
                          {ownershipTransfer[0].targetDisplayName}
                        </strong>
                        {t("lobby.members.transferPending", {
                          name: ownershipTransfer[0].targetDisplayName,
                        })}
                      </p>
                      <small>
                        {t("lobby.transferExpires", {
                          date: formatDate(
                            language,
                            ownershipTransfer[0].expiresAt,
                            {
                              dateStyle: "medium",
                              timeStyle: "short",
                            },
                          ),
                        })}
                      </small>
                      <button
                        className="text-button member-remove"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api.cancelOwnershipTransfer(modal.space.id);
                            setOwnershipTransfer([]);
                            setNotice(t("lobby.notice.transferCanceled"));
                          })
                        }
                      >
                        {t("lobby.members.transferCancel")}
                      </button>
                    </div>
                  ) : (
                    <p className="space-empty">
                      {t("lobby.members.transferNone")}
                    </p>
                  )}
                </>
              )}
              <h3>
                {t("lobby.members.joinRequests", {
                  count: formatNumber(language, joinRequests.length),
                })}
              </h3>
              {joinRequestError && (
                <p className="space-error" role="alert">
                  {joinRequestError}{" "}
                  <button
                    className="text-button"
                    onClick={() => setJoinRequestsRefresh((value) => value + 1)}
                  >
                    {t("lobby.members.joinRequestsRefresh")}
                  </button>
                </p>
              )}
              {joinRequests.length === 0 ? (
                <p className="space-empty">
                  {joinRequestError
                    ? t("lobby.members.joinRequestsUnknown")
                    : t("lobby.members.joinRequestsEmpty")}
                </p>
              ) : (
                <ul className="invite-list">
                  {joinRequests.map((request) => (
                    <li key={request.id}>
                      <span>
                        <strong>{request.displayName}</strong>
                        <small>
                          {t("lobby.members.requestedAt", {
                            date: formatDate(language, request.requestedAt, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }),
                          })}
                        </small>
                      </span>
                      <div className="join-request-actions">
                        <button
                          className="text-button approve"
                          disabled={busy || Boolean(joinRequestError)}
                          onClick={() =>
                            resolveAdmissionRequest(request, "APPROVE")
                          }
                        >
                          {t("lobby.members.approve")}
                        </button>
                        <button
                          className="text-button member-remove"
                          disabled={busy || Boolean(joinRequestError)}
                          onClick={() =>
                            resolveAdmissionRequest(request, "REJECT")
                          }
                        >
                          {t("lobby.members.reject")}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <h3>
                {t("lobby.members.current", {
                  count: formatNumber(language, members.length),
                })}
              </h3>
              {members.length === 0 ? (
                <p className="space-empty">{t("lobby.members.empty")}</p>
              ) : (
                <ul className="invite-list">
                  {members.map((member) => (
                    <li key={member.userId}>
                      <span>
                        <strong>
                          {member.displayName}
                          {member.role === "OWNER"
                            ? t("lobby.members.owner")
                            : member.role === "ADMIN"
                              ? t("lobby.members.admin")
                              : ""}
                        </strong>
                        <small>
                          {t("lobby.members.joinedAt", {
                            date: formatDate(language, member.joinedAt),
                          })}
                          {member.lastVisitedAt
                            ? t("lobby.members.lastVisited", {
                                date: formatDate(
                                  language,
                                  member.lastVisitedAt,
                                ),
                              })
                            : ""}
                        </small>
                      </span>
                      <div className="member-row-actions">
                        {modal.space.role === "OWNER" &&
                          member.role !== "OWNER" &&
                          (ownershipTransfer.length > 0 ? (
                            ownershipTransfer[0].targetUserId ===
                            member.userId ? (
                              <span className="ownership-transfer-label">
                                {t("lobby.members.transferAcceptPending")}
                              </span>
                            ) : null
                          ) : (
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={async () => {
                                if (
                                  !(await confirm(
                                    t("lobby.members.transferConfirm", {
                                      name: member.displayName,
                                    }),
                                  ))
                                )
                                  return;
                                void run(async () => {
                                  const transfer =
                                    await api.requestOwnershipTransfer(
                                      modal.space.id,
                                      member.userId,
                                    );
                                  setOwnershipTransfer([transfer]);
                                  setNotice(
                                    t("lobby.members.transferSent", {
                                      name: member.displayName,
                                    }),
                                  );
                                });
                              }}
                            >
                              {t("lobby.members.transferButton")}
                            </button>
                          ))}
                        {modal.space.role === "OWNER" &&
                          member.role !== "OWNER" && (
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={async () => {
                                const nextRole =
                                  member.role === "ADMIN" ? "MEMBER" : "ADMIN";
                                if (
                                  !(await confirm(
                                    nextRole === "ADMIN"
                                      ? t("lobby.members.grantAdminConfirm", {
                                          name: member.displayName,
                                        })
                                      : t("lobby.members.removeAdminConfirm", {
                                          name: member.displayName,
                                        }),
                                  ))
                                )
                                  return;
                                void run(async () => {
                                  await api.setMemberRole(
                                    modal.space.id,
                                    member.userId,
                                    nextRole,
                                  );
                                  setMembers(
                                    await api.listMembers(modal.space.id),
                                  );
                                  setNotice(
                                    nextRole === "ADMIN"
                                      ? t("lobby.members.adminGranted", {
                                          name: member.displayName,
                                        })
                                      : t("lobby.members.adminRemoved", {
                                          name: member.displayName,
                                        }),
                                  );
                                });
                              }}
                            >
                              {member.role === "ADMIN"
                                ? t("lobby.members.roleRemove")
                                : t("lobby.members.roleGrant")}
                            </button>
                          )}
                        {member.role === "MEMBER" && (
                          <button
                            className="text-button member-remove"
                            disabled={busy}
                            onClick={async () => {
                              if (
                                !(await confirm(
                                  t("lobby.members.kickConfirm", {
                                    name: member.displayName,
                                  }),
                                ))
                              )
                                return;
                              void run(async () => {
                                await api.kickMember(
                                  modal.space.id,
                                  member.userId,
                                );
                                const [nextMembers, nextBlocks] =
                                  await Promise.all([
                                    api.listMembers(modal.space.id),
                                    api.listAccessBlocks(modal.space.id),
                                  ]);
                                setMembers(nextMembers);
                                setAccessBlocks(nextBlocks);
                                setNotice(
                                  t("lobby.members.kicked", {
                                    name: member.displayName,
                                  }),
                                );
                              });
                            }}
                          >
                            {t("lobby.members.kick")}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <h3>
                {t("lobby.members.blocks", {
                  count: formatNumber(language, accessBlocks.length),
                })}
              </h3>
              {accessBlocks.length === 0 ? (
                <p className="space-empty">{t("lobby.members.blocksEmpty")}</p>
              ) : (
                <ul className="invite-list">
                  {accessBlocks.map((blocked) => (
                    <li key={blocked.userId}>
                      <span>
                        <strong>{blocked.displayName}</strong>
                        <small>
                          {t("lobby.members.blockedSince", {
                            date: formatDate(language, blocked.blockedAt, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }),
                          })}
                        </small>
                      </span>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api.unblockMember(
                              modal.space.id,
                              blocked.userId,
                            );
                            setAccessBlocks(
                              await api.listAccessBlocks(modal.space.id),
                            );
                            setNotice(
                              t("lobby.members.unblocked", {
                                name: blocked.displayName,
                              }),
                            );
                          })
                        }
                      >
                        {t("lobby.members.unblock")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : modal.kind !== "invites" ? (
            <SpaceForm
              initial={modal.kind === "edit" ? modal.space : undefined}
              busy={busy}
              onSave={(draft) =>
                void run(async () => {
                  const result =
                    modal.kind === "edit"
                      ? await api.editSpace(modal.space.id, {
                          name: draft.name,
                          description: draft.description,
                          visibility: draft.visibility,
                          approvalRequired: draft.approvalRequired,
                          allowedEmailDomains: draft.allowedEmailDomains,
                          guestEntryEnabled: draft.guestEntryEnabled,
                        })
                      : await api.createSpace(draft);
                  if (modal.kind === "create") {
                    setView("mine");
                    setPage(1);
                    setSearch("");
                    setAppliedSearch("");
                    upsert(result);
                  } else {
                    await refresh();
                  }
                  setModal(undefined);
                  setNotice(
                    modal.kind === "edit"
                      ? t("lobby.notice.spaceEdited")
                      : t("lobby.notice.spaceCreated"),
                  );
                })
              }
            />
          ) : (
            <div className="invite-manager">
              <p className="muted">
                {t("lobby.inviteManager.description", {
                  name: modal.space.name,
                })}
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const result = await api.createInvite(
                      modal.space.id,
                      hours,
                      uses,
                      targetInviteUserId.trim() || undefined,
                    );
                    setCreatedCode(result.code);
                    setInvites((previous) => [result.invite, ...previous]);
                  });
                }}
              >
                <div className="space-fields">
                  <label>
                    {t("lobby.inviteManager.validFor")}
                    <select
                      value={hours}
                      onChange={(e) => setHours(Number(e.target.value))}
                    >
                      <option value={1}>{t("lobby.inviteManager.hour")}</option>
                      <option value={24}>{t("lobby.inviteManager.day")}</option>
                      <option value={168}>
                        {t("lobby.inviteManager.week")}
                      </option>
                    </select>
                  </label>
                  <label>
                    {t("lobby.inviteManager.maxUses")}
                    <input
                      type="number"
                      min={1}
                      max={100}
                      required
                      disabled={Boolean(targetInviteUserId.trim())}
                      value={uses}
                      onChange={(e) => setUses(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    {t("lobby.inviteManager.targetAccount")}{" "}
                    <span className="muted">
                      {t("lobby.inviteManager.optional")}
                    </span>
                    <input
                      value={targetInviteUserId}
                      onChange={(e) => {
                        setTargetInviteUserId(e.target.value);
                        if (e.target.value.trim()) setUses(1);
                      }}
                      maxLength={36}
                      placeholder={t("lobby.inviteManager.targetPlaceholder")}
                      autoComplete="off"
                    />
                  </label>
                </div>
                <p className="muted">{t("lobby.inviteManager.help")}</p>
                <button className="space-primary" disabled={busy}>
                  {t("lobby.inviteManager.create")}
                </button>
              </form>
              {createdCode && (
                <div className="created-invite">
                  <label htmlFor="created-code">
                    {t("lobby.inviteManager.newCode")}
                  </label>
                  <input
                    id="created-code"
                    readOnly
                    value={createdCode}
                    onFocus={(e) => e.target.select()}
                  />
                  <div>
                    <button
                      className="space-secondary"
                      onClick={() => void run(() => copy(createdCode))}
                    >
                      <Copy size={15} /> {t("lobby.inviteManager.copyCode")}
                    </button>
                    <button
                      className="space-secondary"
                      onClick={() =>
                        void run(() =>
                          copy(`${location.origin}/#invite=${createdCode}`),
                        )
                      }
                    >
                      <Link2 size={15} /> {t("lobby.inviteManager.copyLink")}
                    </button>
                  </div>
                  <small>{t("lobby.inviteManager.codeWarning")}</small>
                </div>
              )}
              <h3>{t("lobby.inviteManager.issued")}</h3>
              <p className="muted">{t("lobby.inviteManager.issuedHelp")}</p>
              {invites.length === 0 ? (
                <p className="space-empty">
                  {t("lobby.inviteManager.issuedEmpty")}
                </p>
              ) : (
                <ul className="invite-list">
                  {invites.map((i) => {
                    const ended =
                      i.revoked ||
                      Date.parse(i.expiresAt) <= Date.now() ||
                      i.useCount >= i.maxUses;
                    return (
                      <li key={i.id}>
                        <span>
                          <strong>
                            {i.revoked
                              ? t("lobby.inviteManager.revoked")
                              : ended
                                ? t("lobby.inviteManager.ended")
                                : t("lobby.inviteManager.available")}{" "}
                            ·{" "}
                            {t("lobby.inviteManager.uses", {
                              used: formatNumber(language, i.useCount),
                              max: formatNumber(language, i.maxUses),
                            })}
                          </strong>
                          <small>
                            {i.targetUserId
                              ? t("lobby.inviteManager.targetLabel", {
                                  name: i.targetDisplayName || i.targetUserId,
                                })
                              : t("lobby.inviteManager.linkLabel")}
                            {t("lobby.inviteManager.until", {
                              date: formatDate(language, i.expiresAt, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              }),
                            })}
                          </small>
                        </span>
                        <button
                          className="text-button"
                          disabled={busy || ended}
                          onClick={() =>
                            void run(async () => {
                              await api.revokeInvite(modal.space.id, i.id);
                              setInvites(await api.listInvites(modal.space.id));
                              setCreatedCode("");
                            })
                          }
                        >
                          {t("lobby.inviteManager.cancel")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </Dialog>
      )}
      {profileOpen && (
        <ProfileDialog
          account={account}
          busy={busy}
          onLogoutEverywhere={signOutEverywhere}
          close={() => {
            if (!busy) setProfileOpen(false);
          }}
          onDelete={() => void openDeletion()}
          save={(profile) =>
            void run(async () => {
              const updated = await saveProfile(
                profile.displayName,
                profile.avatar,
                {
                  skin: profile.skin,
                  clothing: profile.clothing,
                  hair: profile.hair,
                },
                profile.bio,
                profile.links,
              );
              onProfileSaved?.(updated);
              setProfileOpen(false);
              setNotice(t("profile.saved"));
            })
          }
        />
      )}
      {deletionOpen && (
        <Dialog
          title={t("accountDeletion.title")}
          close={() => {
            if (!busy) setDeletionOpen(false);
          }}
        >
          <div className="account-deletion-dialog">
            <p className="account-deletion-lead">
              {t("accountDeletion.description")}
            </p>
            <ul className="account-deletion-policy">
              <li>{t("accountDeletion.profile")}</li>
              <li>{t("accountDeletion.messages")}</li>
              <li>{t("accountDeletion.uploads")}</li>
              <li>{t("accountDeletion.retention")}</li>
              <li>{t("accountDeletion.relogin")}</li>
            </ul>
            {deletionLoading ? (
              <p role="status">{t("accountDeletion.checkingSpaces")}</p>
            ) : deletionImpact?.ownedSpaces.length ? (
              <div className="account-deletion-owned" role="alert">
                <strong>{t("accountDeletion.ownedSpaces")}</strong>
                <ul>
                  {deletionImpact.ownedSpaces.map((space) => (
                    <li key={space.id}>{space.name}</li>
                  ))}
                </ul>
                <p>{t("accountDeletion.ownedSpacesHint")}</p>
              </div>
            ) : null}
            {deletionError && (
              <p className="space-error" role="alert">
                {deletionError}
              </p>
            )}
            <label
              className="account-deletion-confirm"
              htmlFor="account-deletion-confirmation"
            >
              {t("accountDeletion.confirmLabel", {
                word: deletionKeyword,
              })}
            </label>
            <input
              id="account-deletion-confirmation"
              value={deletionConfirmation}
              onChange={(event) => setDeletionConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            <div className="account-deletion-actions">
              <button
                type="button"
                className="space-secondary"
                onClick={() => setDeletionOpen(false)}
                disabled={busy}
              >
                {t("accountDeletion.cancel")}
              </button>
              <button
                type="button"
                className="account-delete-submit"
                onClick={() => void submitDeletion()}
                disabled={
                  busy ||
                  deletionLoading ||
                  !deletionImpact ||
                  !!deletionImpact.ownedSpaces.length ||
                  deletionConfirmation !== deletionKeyword
                }
              >
                {busy ? t("accountDeletion.busy") : t("accountDeletion.submit")}
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {scheduleSpace && (
        <ScheduledEventsDialog
          space={scheduleSpace}
          canManage={
            scheduleSpace.role === "OWNER" || scheduleSpace.role === "ADMIN"
          }
          close={() => setScheduleSpace(undefined)}
          enter={() => {
            const target = scheduleSpace;
            setScheduleSpace(undefined);
            enterOrRequest(target);
          }}
        />
      )}
      {extensionsSpace && (
        <SpaceExtensionsDialog
          space={extensionsSpace}
          close={() => setExtensionsSpace(undefined)}
        />
      )}
      {children}
    </div>
  );
}

function ProfileDialog({
  account,
  busy,
  close,
  onLogoutEverywhere,
  onDelete,
  save,
}: {
  account: Account;
  busy: boolean;
  close: () => void;
  onLogoutEverywhere: () => Promise<void>;
  onDelete: () => void;
  save: (profile: Account) => void;
}) {
  const { language, t } = useLanguage();
  const [displayName, setDisplayName] = useState(account.displayName);
  const [avatar, setAvatar] = useState(account.avatar);
  const [skin, setSkin] = useState(account.skin);
  const [clothing, setClothing] = useState(account.clothing);
  const [hair, setHair] = useState(account.hair);
  const [bio, setBio] = useState(account.bio ?? "");
  const [accountIdCopied, setAccountIdCopied] = useState(false);
  const [sessionLogoutBusy, setSessionLogoutBusy] = useState(false);
  const [sessionLogoutError, setSessionLogoutError] = useState("");
  const appearance = { skin, clothing, hair };
  const randomize = () => {
    const pick = <T,>(values: readonly T[]) =>
      values[Math.floor(Math.random() * values.length)];
    setAvatar(Math.floor(Math.random() * AVATAR_CATALOG.bodyShapes.length));
    setSkin(pick(AVATAR_CATALOG.skinTones));
    setClothing(pick(AVATAR_CATALOG.clothing));
    setHair(pick(AVATAR_CATALOG.hair));
  };
  async function logoutEverywhere() {
    if (busy || sessionLogoutBusy) return;
    setSessionLogoutBusy(true);
    setSessionLogoutError("");
    try {
      await onLogoutEverywhere();
    } catch (error) {
      setSessionLogoutError(
        language === "ko" && error instanceof Error
          ? error.message
          : t("profile.logoutFailed"),
      );
    } finally {
      setSessionLogoutBusy(false);
    }
  }
  const label = (value: string) => {
    const keys: Partial<Record<string, TranslationKey>> = {
      afro: "avatarPart.afro",
      armor: "avatarPart.armor",
      arts: "avatarPart.arts",
      average: "avatarPart.average",
      balding: "avatarPart.balding",
      bikini: "avatarPart.bikini",
      black: "avatarPart.black",
      blue: "avatarPart.blue",
      blonde: "avatarPart.blonde",
      brown: "avatarPart.brown",
      bun: "avatarPart.bun",
      casual: "avatarPart.casual",
      cute: "avatarPart.cute",
      dainty: "avatarPart.dainty",
      dark: "avatarPart.dark",
      double: "avatarPart.double",
      dress: "avatarPart.dress",
      dragon: "avatarPart.dragon",
      gold: "avatarPart.gold",
      heavy: "avatarPart.heavy",
      grey: "avatarPart.grey",
      green: "avatarPart.green",
      light: "avatarPart.light",
      long: "avatarPart.long",
      mage: "avatarPart.mage",
      martial: "avatarPart.martial",
      medium: "avatarPart.medium",
      ninja: "avatarPart.ninja",
      normal: "avatarPart.normal",
      pinafore: "avatarPart.pinafore",
      pink: "avatarPart.pink",
      ponytail: "avatarPart.ponytail",
      purple: "avatarPart.purple",
      red: "avatarPart.red",
      robe: "avatarPart.robe",
      rogue: "avatarPart.rogue",
      shaved: "avatarPart.shaved",
      short: "avatarPart.short",
      shorts: "avatarPart.shorts",
      spiky: "avatarPart.spiky",
      suit: "avatarPart.suit",
      summer: "avatarPart.summer",
      skirt: "avatarPart.skirt",
      tails: "avatarPart.tails",
      tunic: "avatarPart.tunic",
      twin: "avatarPart.twin",
      white: "avatarPart.white",
      yellow: "avatarPart.yellow",
    };
    return value
      .split("_")
      .map((word) => {
        const key = keys[word];
        return key ? t(key) : language === "ko" ? word : "Other";
      })
      .filter(Boolean)
      .join(" ");
  };
  return (
    <Dialog title={t("profile.title")} close={close}>
      <form
        className="profile-editor"
        onSubmit={(event) => {
          event.preventDefault();
          if (!displayName.trim() || busy) return;
          save({
            ...account,
            displayName: displayName.trim(),
            avatar,
            skin,
            clothing,
            hair,
            bio: bio.trim(),
            links: account.links ?? [],
          });
        }}
      >
        <div className="profile-editor-preview">
          <Avatar id={avatar} size={112} appearance={appearance} />
          <div className="profile-editor-preview-details">
            <strong>{displayName.trim() || t("profile.nameRequired")}</strong>
            <small>{t("profile.previewHint")}</small>
            <label className="profile-body-shape">
              {t("wardrobe.shape")}
              <select
                aria-label={t("wardrobe.shape")}
                value={avatar}
                onChange={(event) => setAvatar(Number(event.target.value))}
              >
                {AVATAR_CATALOG.bodyShapes.map((shape, index) => (
                  <option key={shape} value={index}>
                    {label(shape)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="profile-account-id">
          <label htmlFor="profile-invite-account-id">
            {t("profile.inviteAccountId")}
          </label>
          <div>
            <input
              id="profile-invite-account-id"
              readOnly
              value={account.userId}
            />
            <button
              type="button"
              className="space-secondary"
              onClick={() =>
                void navigator.clipboard
                  .writeText(account.userId)
                  .then(() => setAccountIdCopied(true))
                  .catch(() => setAccountIdCopied(false))
              }
            >
              <Copy size={15} />
              {accountIdCopied ? t("profile.copyDone") : t("profile.copyId")}
            </button>
          </div>
          <small>{t("profile.inviteAccountHint")}</small>
        </div>
        <button type="button" className="avatar-randomize" onClick={randomize}>
          {t("profile.randomize")}
        </button>
        <div className="avatar-config-grid">
          <label>
            {t("profile.skin")}
            <select
              value={skin}
              onChange={(event) => setSkin(event.target.value)}
            >
              {AVATAR_CATALOG.skinTones.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("profile.clothing")}
            <select
              value={clothing}
              onChange={(event) => setClothing(event.target.value)}
            >
              {AVATAR_CATALOG.clothing.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("profile.hair")}
            <select
              value={hair}
              onChange={(event) => setHair(event.target.value)}
            >
              {AVATAR_CATALOG.hair.map((value) => (
                <option key={value} value={value}>
                  {label(value.replace(/^hair_/, ""))}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="form-label" htmlFor="profile-display-name">
          {t("profile.displayName")} <span>{displayName.length}/20</span>
        </label>
        <input
          id="profile-display-name"
          required
          maxLength={20}
          autoComplete="nickname"
          value={displayName}
          onChange={(event) =>
            setDisplayName(event.target.value.replace(/[\x00-\x1F\x7F]/g, ""))
          }
        />
        <label className="form-label" htmlFor="profile-bio">
          {t("profile.bio")} <span>{bio.length}/280</span>
        </label>
        <textarea
          id="profile-bio"
          rows={3}
          maxLength={280}
          value={bio}
          onChange={(event) =>
            setBio(event.target.value.replace(/[\x00-\x1F\x7F]/g, ""))
          }
          placeholder={t("profile.bioPlaceholder")}
        />
        <button
          className="space-primary"
          disabled={busy || !displayName.trim()}
        >
          {busy ? t("profile.saving") : t("profile.save")}
        </button>
      </form>
      <GoogleCalendarSettings />
      <div className="profile-delete-row">
        <span>
          <strong>{t("profile.loggedInDevices")}</strong>
          <small>{t("profile.logoutDevicesHint")}</small>
        </span>
        <button
          type="button"
          className="account-delete-link"
          onClick={() => void logoutEverywhere()}
          disabled={busy || sessionLogoutBusy}
        >
          {sessionLogoutBusy
            ? t("profile.logoutBusy")
            : t("profile.logoutEverywhere")}
        </button>
      </div>
      {sessionLogoutError && (
        <p className="space-error" role="alert">
          {sessionLogoutError}
        </p>
      )}
      <div className="profile-delete-row">
        <span>
          <strong>{t("profile.accountManagement")}</strong>
          <small>{t("profile.accountManagementHint")}</small>
        </span>
        <button
          type="button"
          className="account-delete-link"
          onClick={onDelete}
          disabled={busy}
        >
          {t("profile.deleteAccount")}
        </button>
      </div>
    </Dialog>
  );
}

function GoogleCalendarSettings() {
  const { t } = useLanguage();
  const [status, setStatus] = useState<GoogleCalendarStatus>();
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    getGoogleCalendarStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setError(t("profile.calendarStatusError"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [t]);

  async function refreshStatus() {
    const current = await getGoogleCalendarStatus();
    setStatus(current);
  }

  async function connect() {
    if (action) return;
    setAction("connect");
    setError("");
    setNotice("");
    try {
      const { authorizationUrl } = await startGoogleCalendarConnection();
      const destination = new URL(authorizationUrl);
      if (
        destination.origin !== "https://accounts.google.com" ||
        destination.pathname !== "/o/oauth2/v2/auth"
      ) {
        throw new Error("Invalid Google OAuth destination");
      }
      window.location.assign(destination.href);
    } catch {
      setError(t("profile.calendarActionError"));
      setAction("");
    }
  }

  async function disconnect() {
    if (action) return;
    setAction("disconnect");
    setError("");
    setNotice("");
    try {
      await disconnectGoogleCalendar();
      await refreshStatus();
      setNotice(t("profile.calendarDisconnected"));
    } catch {
      setError(t("profile.calendarActionError"));
    } finally {
      setAction("");
    }
  }

  async function applyConflict(conflict: GoogleCalendarConflict) {
    if (action) return;
    setAction(conflict.sourceKind + conflict.sourceId);
    setError("");
    setNotice("");
    try {
      await applyHufsTownCalendarVersion(conflict);
      await refreshStatus();
      setNotice(t("profile.calendarApplyQueued"));
    } catch {
      setError(t("profile.calendarActionError"));
    } finally {
      setAction("");
    }
  }

  return (
    <section
      className="profile-calendar-panel"
      aria-labelledby="profile-calendar-title"
    >
      <div className="profile-calendar-heading">
        <CalendarDays size={18} aria-hidden="true" />
        <div>
          <strong id="profile-calendar-title">
            {t("profile.calendarTitle")}
          </strong>
          <small>{t("profile.calendarDescription")}</small>
        </div>
      </div>
      {loading ? (
        <p className="profile-calendar-muted" role="status">
          {t("profile.calendarLoading")}
        </p>
      ) : status?.connected ? (
        <>
          <p className="profile-calendar-state">
            <span className="profile-calendar-indicator" aria-hidden="true" />
            {status.reconnectRequired
              ? t("profile.calendarReconnectRequired")
              : t("profile.calendarConnected")}
          </p>
          {status.pendingCount > 0 && (
            <small className="profile-calendar-muted">
              {t("profile.calendarPendingCount", {
                count: status.pendingCount,
              })}
            </small>
          )}
          {status.failedCount > 0 && (
            <small className="profile-calendar-warning">
              {t("profile.calendarFailedCount", { count: status.failedCount })}
            </small>
          )}
          {status.conflicts.length > 0 && (
            <div className="profile-calendar-conflicts">
              <strong>
                {t("profile.calendarConflictCount", {
                  count: status.conflicts.length,
                })}
              </strong>
              <small>{t("profile.calendarConflictHint")}</small>
              <ul>
                {status.conflicts.map((conflict) => (
                  <li key={`${conflict.sourceKind}:${conflict.sourceId}`}>
                    <span>
                      {conflict.sourceKind === "SCHEDULED_EVENT"
                        ? t("profile.calendarConflictEvent")
                        : t("profile.calendarConflictReservation")}
                    </span>
                    <button
                      type="button"
                      className="space-secondary"
                      disabled={Boolean(action) || status.reconnectRequired}
                      onClick={() => void applyConflict(conflict)}
                    >
                      {action === conflict.sourceKind + conflict.sourceId
                        ? t("profile.calendarApplying")
                        : t("profile.calendarApply")}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <small className="profile-calendar-muted">
            {t("profile.calendarDisconnectHint")}
          </small>
          <div className="profile-calendar-actions">
            {status.reconnectRequired && (
              <button
                type="button"
                className="space-secondary"
                disabled={Boolean(action) || !status.enabled}
                onClick={() => void connect()}
              >
                {action === "connect"
                  ? t("profile.calendarConnecting")
                  : t("profile.calendarReconnect")}
              </button>
            )}
            <button
              type="button"
              className="account-delete-link"
              disabled={Boolean(action)}
              onClick={() => void disconnect()}
            >
              {action === "disconnect"
                ? t("profile.calendarDisconnecting")
                : t("profile.calendarDisconnect")}
            </button>
          </div>
        </>
      ) : status?.enabled ? (
        <>
          <p className="profile-calendar-muted">
            {t("profile.calendarNotConnected")}
          </p>
          <button
            type="button"
            className="space-secondary"
            disabled={Boolean(action)}
            onClick={() => void connect()}
          >
            {action === "connect"
              ? t("profile.calendarConnecting")
              : t("profile.calendarConnect")}
          </button>
        </>
      ) : (
        <p className="profile-calendar-muted">
          {t("profile.calendarNotConfigured")}
        </p>
      )}
      {notice && (
        <p className="profile-calendar-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="space-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function SpaceForm({
  initial,
  busy,
  onSave,
}: {
  initial?: Space;
  busy: boolean;
  onSave: (draft: {
    name: string;
    description: string;
    visibility: Visibility;
    capacity: number;
    approvalRequired: boolean;
    allowedEmailDomains: string[];
    guestEntryEnabled: boolean;
    templateId: SpaceTemplateId;
  }) => void;
}) {
  const { language, t } = useLanguage();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [visibility, setVisibility] = useState<Visibility>(
    initial?.visibility ?? "PRIVATE",
  );
  const [capacity, setCapacity] = useState(initial?.capacity ?? 100);
  const [approvalRequired, setApprovalRequired] = useState(
    initial?.approvalRequired ?? false,
  );
  const [allowedDomainsText, setAllowedDomainsText] = useState(
    initial?.allowedEmailDomains?.join("\n") ?? "",
  );
  const [guestEntryEnabled, setGuestEntryEnabled] = useState(
    initial?.guestEntryEnabled ?? false,
  );
  const allowedEmailDomains = allowedDomainsText
    .split(/[\s,;]+/)
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  const guestEntryAvailable =
    visibility === "PUBLIC" &&
    !approvalRequired &&
    allowedEmailDomains.length === 0;
  const [templateId, setTemplateId] = useState<SpaceTemplateId>(
    initial?.templateId ?? "CAMPUS_SQUARE",
  );
  return (
    <form
      className="space-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          name: name.trim(),
          description: description.trim(),
          visibility,
          capacity,
          approvalRequired,
          allowedEmailDomains,
          guestEntryEnabled,
          templateId,
        });
      }}
    >
      <label>
        {t("spaceForm.name")}
        <input
          required
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("spaceForm.namePlaceholder")}
        />
      </label>
      <label>
        {t("spaceForm.description")}
        <input
          maxLength={300}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("spaceForm.descriptionPlaceholder")}
        />
      </label>
      {initial ? (
        <p className="space-template-fixed">
          {t("spaceForm.templateFixed", {
            name: t(SPACE_TEMPLATE_KEYS[initial.templateId]),
          })}
        </p>
      ) : (
        <fieldset className="space-template-picker">
          <legend>{t("spaceForm.templatePrompt")}</legend>
          <div className="space-template-options">
            {SPACE_TEMPLATES.map((template) => {
              const Icon = template.icon;
              return (
                <label
                  className={`space-template-option ${templateId === template.id ? "selected" : ""}`}
                  key={template.id}
                >
                  <input
                    type="radio"
                    name="space-template"
                    value={template.id}
                    checked={templateId === template.id}
                    onChange={() => setTemplateId(template.id)}
                  />
                  <span className="space-template-icon">
                    <Icon size={17} />
                  </span>
                  <span className="space-template-copy">
                    <strong>{t(template.nameKey)}</strong>
                    <small>{t(template.descriptionKey)}</small>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      <fieldset>
        <legend>{t("spaceForm.visibility")}</legend>
        {(["PUBLIC", "UNLISTED", "PRIVATE"] as const).map((v) => (
          <label
            className={`visibility-option ${visibility === v ? "selected" : ""}`}
            key={v}
          >
            <input
              type="radio"
              name="visibility"
              value={v}
              checked={visibility === v}
              onChange={() => {
                setVisibility(v);
                if (v === "PRIVATE") setApprovalRequired(false);
                if (v !== "PUBLIC") setGuestEntryEnabled(false);
              }}
            />
            <span>
              <strong>{t(visibilityTranslationKey(v))}</strong>
              <small>
                {v === "PUBLIC"
                  ? t("spaceForm.visibility.publicHint")
                  : v === "UNLISTED"
                    ? t("spaceForm.visibility.unlistedHint")
                    : t("spaceForm.visibility.privateHint")}
              </small>
            </span>
          </label>
        ))}
      </fieldset>
      {visibility === "PRIVATE" ? (
        <p className="muted">{t("spaceForm.privateHint")}</p>
      ) : (
        <label className="approval-option">
          <input
            type="checkbox"
            checked={approvalRequired}
            onChange={(event) => {
              setApprovalRequired(event.target.checked);
              if (event.target.checked) setGuestEntryEnabled(false);
            }}
          />
          <span>
            <strong>{t("spaceForm.approval")}</strong>
            <small>{t("spaceForm.approvalHint")}</small>
          </span>
        </label>
      )}
      <label>
        {t("spaceForm.domains")}
        <textarea
          aria-label={t("spaceForm.domains")}
          value={allowedDomainsText}
          onChange={(event) => {
            setAllowedDomainsText(event.target.value);
            if (event.target.value.trim()) setGuestEntryEnabled(false);
          }}
          placeholder="hufs.ac.kr, example.edu"
          rows={2}
        />
        <small className="muted">{t("spaceForm.domainsHint")}</small>
      </label>
      <label className="approval-option">
        <input
          type="checkbox"
          checked={guestEntryEnabled}
          disabled={!guestEntryAvailable && !guestEntryEnabled}
          onChange={(event) => setGuestEntryEnabled(event.target.checked)}
        />
        <span>
          <strong>{t("spaceForm.guest")}</strong>
          <small>{t("spaceForm.guestHint")}</small>
        </span>
      </label>
      {initial ? (
        <p className="muted">
          {t("spaceForm.editCapacityHint", {
            count: formatNumber(language, capacity),
          })}
        </p>
      ) : (
        <label>
          {t("spaceForm.capacity")}
          <input
            type="number"
            required
            min={1}
            max={100}
            value={capacity}
            onChange={(e) => setCapacity(Number(e.target.value))}
          />
          <small className="muted">{t("spaceForm.capacityHint")}</small>
        </label>
      )}
      <button className="space-primary" disabled={busy || !name.trim()}>
        {busy
          ? t("spaceForm.saving")
          : initial
            ? t("spaceForm.save")
            : t("spaceForm.create")}
        <ArrowRight size={17} />
      </button>
    </form>
  );
}
