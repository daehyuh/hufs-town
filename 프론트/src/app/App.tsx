import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useId,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Compass,
  DoorOpen,
  Flag,
  FileText,
  LogOut,
  Mic,
  MicOff,
  MessageCircle,
  ShieldCheck,
  LocateFixed,
  Map,
  Minus,
  Plus,
  Pencil,
  Radio,
  RefreshCw,
  Smile,
  Send,
  Shuffle,
  Settings2,
  Trash2,
  Users,
  UserPlus,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  DirectMessageMutationAck,
  MapDefinition,
  MapInteraction,
  PlayerView,
  Portal,
} from "../generated/protocol";
import { createUuid } from "../ids";
import {
  keepEditedDraft,
  localizeUneditedChoices,
} from "../events/draftDefaults";
import {
  readEventToolsEnabled,
  writeEventToolsEnabled,
} from "../events/eventToolsPreference";
import { Avatar, type AvatarAppearance } from "../components/Avatar";
import { useDialogActions } from "../components/DialogActions";
import { profileDetailsErrorKey } from "../social/profileDetailsError";
import { WorldConnection } from "../game/WorldConnection";
import {
  AutoAwayPolicy,
  AUTO_AWAY_CHECK_INTERVAL_MS,
  AUTO_AWAY_RESTORE_DELAY_MS,
} from "../game/AutoAwayPolicy";
import {
  readWorldRenderMode,
  writeWorldRenderMode,
  type WorldRenderMode,
} from "../game/renderPreference";
import {
  chatHistoryKey,
  type ChatHistoryPage,
  type ChatLine,
} from "../game/WorldConnection";
import { WorldCanvas } from "../game/WorldCanvas";
import { availableEmotes } from "../game/emoteOptions";
import { MobileMovementPad } from "../game/MobileMovementPad";
import { MiniMapPanel } from "../game/MiniMapPanel";
import type { CampusScene, NearbyAmbientSound } from "../game/CampusScene";
import { AVATAR_CATALOG } from "../generated/avatarCatalog";
import { ASSET_GROUPS } from "../generated/assetGroups";
import {
  clearGuestSession,
  clearPending,
  getGuestSpace,
  getSpace,
  pending,
  setPending,
  requestAdmission,
  requestGuestAdmission,
  type AdmissionTicket,
  type GuestSpace,
  type Space,
} from "../spaces/client";
import { recordRecentSpaceVisit } from "../spaces/recentVisits";
import {
  createSpaceBoardPost,
  deleteSpaceBoardPost,
  listSpaceBoardPosts,
  type SpaceBoardPost,
} from "../spaces/boards";
import { SharedWhiteboard } from "../spaces/SharedWhiteboard";
import { RoomNoteDialog } from "../spaces/RoomNoteDialog";
import { AdmissionRequestOverlay } from "../spaces/AdmissionRequestOverlay";
import { Dialog } from "../components/Dialog";
import { PanelDisclosureButton } from "./PanelDisclosureButton";
import { MediaController } from "../media/MediaController";
import { RoomRecordingControls } from "../media/RoomRecordingControls";
import { listSpaceAssets } from "../editor/assetsClient";
import { ASSETS_BY_ID, replaceCustomAssets } from "../game/officeAssets";
import {
  downloadEventAttendance,
  getEventResults,
  listEventHistory,
  type EventResults,
  type EventSummary,
} from "../events/client";
import { EventHistoryPanel } from "../events/EventHistoryPanel";
import { eventEngagementMessageKey } from "../events/eventEngagementMessage";
import { eventActionMessageKey } from "../events/eventActionMessage";
import {
  listBlockedAccounts,
  removeBlockedAccount,
  type BlockedAccount,
} from "../social/blocks";
import {
  leaveGroupConversation,
  listDirectConversations,
  listGroupInvitations,
  listGroupMembers,
  removeGroupMember,
  renameGroupConversation,
  listDirectMessageRevisions,
  respondToGroupInvitation,
  type DirectConversation,
  type DirectMessageRevision,
  type GroupInvitation,
  type GroupMember,
} from "../social/directMessages";
import {
  AuthError,
  currentAccount,
  loadAuth,
  logout,
  logoutEverywhere,
  savePokePreference,
  saveProfile,
  startLogin,
  type AuthState,
  type Account,
} from "../auth/client";
import {
  disableDirectMessagePush,
  enableDirectMessagePush,
  pushSupported,
  syncDirectMessagePush,
} from "../social/webPush";
import {
  getReportAccess,
  kickReportedUser,
  listModerationReports,
  muteReportedMedia,
  muteReportedUser,
  reportDirectMessage,
  reviewModerationReport,
  type ModerationReport,
  type ReportCategory,
  type ReportStatus,
} from "../social/reports";
import { ChatRetentionSettingsDialog } from "../social/ChatRetentionSettingsDialog";
import { ProductAnalyticsDialog } from "../social/ProductAnalyticsDialog";
import { MeetupRequestInbox } from "../social/MeetupRequestInbox";
import { worldMessageErrorKey } from "../social/worldMessageError";
import { worldAckMessage } from "../social/worldAckMessage";
import { createSocialJoinRequest } from "../social/joinRequests";
import { FriendsDialog } from "../social/FriendsDialog";
import {
  formatDate,
  formatNumber,
  LanguagePicker,
  useLocalizedError,
  useLanguage,
  type TranslationKey,
} from "../i18n/language";
import {
  createFriendRequest,
  friendRelationship,
  isAccountId,
  listFriends,
  respondToFriendRequest,
  type FriendOverview,
  type FriendRelationship,
} from "../social/friends";

const SpaceLobby = lazy(() =>
  import("../spaces/SpaceLobby").then((module) => ({
    default: module.SpaceLobby,
  })),
);
const MapEditor = lazy(() =>
  import("../editor/MapEditor").then((module) => ({
    default: module.MapEditor,
  })),
);
const MediaPreflight = lazy(() =>
  import("../media/MediaPreflight").then((module) => ({
    default: module.MediaPreflight,
  })),
);
const MediaControls = lazy(() =>
  import("../media/MediaPanel").then((module) => ({
    default: module.MediaControls,
  })),
);
const MediaStage = lazy(() =>
  import("../media/MediaPanel").then((module) => ({
    default: module.MediaStage,
  })),
);
interface Bootstrap {
  mode: string;
  storage: string;
  space: { id: string; name: string; capacity: number };
  map: MapDefinition;
  worldPath: string;
  features?: { media: boolean; editor: boolean };
}
interface ProfileDraft extends AvatarAppearance {
  name: string;
  avatar: number;
  bio: string;
  links: string[];
}
type ProfileCardPlayer = {
  id: string;
  name: string;
  avatar: number;
  skin: AvatarAppearance["skin"];
  clothing: string;
  hair: string;
  status: PlayerView["status"];
  bio?: string;
  links?: string[];
  profileLoading?: boolean;
  profileError?: string;
};

function ParticipantProfileCard({
  player,
  selfId,
  zoneName,
  online,
  blocked,
  canMessage,
  canBlock,
  canPoke,
  canJoin,
  friendState,
  canFriend,
  friendBusy,
  friendError,
  onClose,
  onMessage,
  onBlock,
  onPoke,
  onJoin,
  onFriend,
}: {
  player: ProfileCardPlayer;
  selfId: string;
  zoneName: string;
  online: boolean;
  blocked: boolean;
  canMessage: boolean;
  canBlock: boolean;
  canPoke: boolean;
  canJoin: boolean;
  friendState: FriendRelationship["state"];
  canFriend: boolean;
  friendBusy: boolean;
  friendError: string;
  onClose: () => void;
  onMessage: () => void;
  onBlock: () => void;
  onPoke: () => void;
  onJoin: () => void;
  onFriend: () => void;
}) {
  const { t } = useLanguage();
  const ownProfile = player.id === selfId;
  const status =
    player.status === "AWAY"
      ? t("people.participant.away")
      : player.status === "DND"
        ? t("people.participant.dnd")
        : t("people.presence.available");
  return (
    <div className="participant-profile-card">
      <div className="participant-profile-hero">
        <span className={`participant-avatar color-${player.avatar}`}>
          <Avatar id={player.avatar} size={82} appearance={player} />
        </span>
        <div>
          <strong>{player.name}</strong>
          <span>
            <i className={`presence-dot ${player.status.toLowerCase()}`} />
            {status}
          </span>
          <small>{zoneName}</small>
        </div>
      </div>
      {player.profileLoading ? (
        <p className="participant-profile-note" role="status">
          {t("people.profile.loading")}
        </p>
      ) : player.profileError ? (
        <p className="participant-profile-note" role="status">
          {t("people.profile.error")}
        </p>
      ) : player.bio || player.links?.length ? (
        <div className="participant-profile-details">
          {player.bio && <p>{player.bio}</p>}
          {!!player.links?.length && (
            <ul>
              {player.links.map((link) => (
                <li key={link}>
                  <a
                    href={/^https?:\/\/[^\s]+$/i.test(link) ? link : undefined}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {link}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : !ownProfile ? (
        <p className="participant-profile-note">{t("people.profile.empty")}</p>
      ) : null}
      {ownProfile ? (
        <p className="participant-profile-note">
          {t("people.profile.selfHint")}
        </p>
      ) : (
        <div className="participant-profile-actions">
          {canFriend && (
            <button
              type="button"
              onClick={onFriend}
              disabled={
                friendBusy ||
                friendState === "FRIEND" ||
                friendState === "OUTGOING"
              }
            >
              <UserPlus size={15} />
              {friendBusy
                ? t("friends.action.processing")
                : friendState === "FRIEND"
                  ? t("friends.search.relationship.friend")
                  : friendState === "OUTGOING"
                    ? t("friends.search.relationship.outgoing")
                    : friendState === "INCOMING"
                      ? t("friends.action.accept")
                      : t("friends.search.request")}
            </button>
          )}
          <button
            type="button"
            onClick={onMessage}
            disabled={!online || blocked || !canMessage}
          >
            <MessageCircle size={15} /> {t("chat.tabs.direct")}
          </button>
          <button type="button" onClick={onPoke} disabled={!online || !canPoke}>
            👉 {t("people.participant.poke", { name: player.name })}
          </button>
          <button type="button" onClick={onJoin} disabled={!online || !canJoin}>
            {t("people.participant.join")}
          </button>
          <button
            type="button"
            className={blocked ? "active" : ""}
            onClick={onBlock}
            disabled={!online || !canBlock}
          >
            {t(
              blocked
                ? "people.participant.unblock"
                : "people.participant.block",
            )}
          </button>
          <button type="button" className="profile-close" onClick={onClose}>
            {t("dialog.close")}
          </button>
          {friendError && (
            <small className="profile-feedback error" role="status">
              {friendError}
            </small>
          )}
        </div>
      )}
    </div>
  );
}
function Brand() {
  const { t } = useLanguage();
  return (
    <div className="brand">
      <img src={ASSET_GROUPS.brand.mark} alt="" aria-hidden="true" />
      <span>{t("brand.name")}</span>
    </div>
  );
}
const reportCategoryKeys: Record<ReportCategory, TranslationKey> = {
  HARASSMENT: "report.category.harassment",
  THREAT: "report.category.threat",
  SPAM: "report.category.spam",
  PERSONAL_INFO: "report.category.personalInfo",
  OTHER: "report.category.other",
};
const reportStatusKeys: Record<ReportStatus, TranslationKey> = {
  OPEN: "report.status.open",
  REVIEWING: "report.status.reviewing",
  RESOLVED: "report.status.resolved",
  DISMISSED: "report.status.dismissed",
};
function avatarPartLabel(
  value: string,
  translateWord?: (word: string) => string,
) {
  const words: Record<string, string> = {
    black: "검정",
    blue: "파랑",
    brown: "갈색",
    blonde: "금발",
    cute: "귀여운",
    dark: "어두운",
    grey: "회색",
    green: "초록",
    gold: "금색",
    light: "밝은",
    medium: "중간",
    purple: "보라",
    pink: "분홍",
    red: "빨강",
    white: "흰색",
    yellow: "노랑",
    armor: "갑옷",
    bikini: "수영복",
    casual: "캐주얼",
    dress: "드레스",
    mage: "마법사",
    robe: "로브",
    martial: "무술",
    arts: "복장",
    ninja: "닌자",
    pinafore: "앞치마 원피스",
    rogue: "도적",
    shorts: "반바지",
    suit: "정장",
    summer: "여름",
    skirt: "치마",
    tunic: "튜닉",
    afro: "아프로",
    balding: "숱 적은",
    bun: "묶음머리",
    double: "양쪽",
    long: "긴 머리",
    ponytail: "포니테일",
    shaved: "삭발",
    short: "짧은 머리",
    spiky: "뾰족머리",
    twin: "트윈",
    tails: "테일",
  };
  return value
    .split("_")
    .map((word) => translateWord?.(word) ?? words[word] ?? word)
    .filter(Boolean)
    .join(" ");
}
export function App() {
  const { language, t } = useLanguage();
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [bootstrapErrorKey, setBootstrapErrorKey] = useState<TranslationKey>();
  const error = bootstrapErrorKey ? t(bootstrapErrorKey) : "";
  const [request, setRequest] = useState(0);
  const [session, setSession] = useState<
    { name: string; avatar: number } & AvatarAppearance & {
        userId?: string;
        allowPokes?: boolean;
      }
  >();
  const [selectedSpace, setSelectedSpace] = useState<Space>();
  const [guestSpace, setGuestSpace] = useState<GuestSpace>();
  const [guestMode, setGuestMode] = useState(false);
  const guestAdmissionTicket = useRef<AdmissionTicket | undefined>(undefined);
  const [selectedMapId, setSelectedMapId] = useState<string>();
  const [selectedReservationId, setSelectedReservationId] = useState("");
  const [mapTransferResumeToken, setMapTransferResumeToken] = useState("");
  const [portalAdmissionSource, setPortalAdmissionSource] = useState<{
    sourceSpaceId: string;
    sourceMapId: string;
    portalId: string;
  }>();
  const [editingSpace, setEditingSpace] = useState<Space>();
  const [auth, setAuth] = useState<AuthState>();
  const [authError, setAuthError] = useState("");
  const [authErrorKey, setAuthErrorKey] = useState<TranslationKey>();
  const [authBusy, setAuthBusy] = useState(false);
  const authFailureTranslations: Record<string, TranslationKey> = {
    AUTH_RATE_LIMIT: "auth.callback.rateLimited",
  };
  const authErrorMessage = auth?.errorKey
    ? t(auth.errorKey)
    : language === "ko" && authError
      ? authError
      : authErrorKey
        ? t(authErrorKey)
        : authError;
  function reportAuthFailure(cause: unknown, fallback: TranslationKey) {
    if (
      cause instanceof AuthError &&
      cause.code &&
      authFailureTranslations[cause.code]
    ) {
      setAuthError("");
      setAuthErrorKey(authFailureTranslations[cause.code]);
      return;
    }
    const detail =
      cause instanceof Error && /[가-힣]/.test(cause.message)
        ? cause.message
        : "";
    setAuthError(detail);
    setAuthErrorKey(fallback);
  }
  useEffect(() => {
    let active = true;
    loadAuth()
      .then((value) => {
        if (active) {
          setAuth(value);
          setAuthError(value.error);
          setAuthErrorKey(undefined);
        }
      })
      .catch(() => {
        if (active) {
          setAuthError("");
          setAuthErrorKey("auth.connectionError");
        }
      });
    return () => {
      active = false;
    };
  }, [request]);
  useEffect(() => {
    if (!auth || auth.config.mode !== "sso" || auth.account || session) return;
    const spaceId = pending("space");
    if (!spaceId) return;
    let active = true;
    getGuestSpace(spaceId)
      .then((space) => {
        if (active) {
          setGuestSpace(space);
          setAuthError("");
          setAuthErrorKey(undefined);
        }
      })
      .catch((error) => {
        if (active) reportAuthFailure(error, "auth.guestLoadFailed");
      });
    return () => {
      active = false;
    };
  }, [auth?.config.mode, auth?.account?.userId, session]);
  async function runAuth(action: () => Promise<void>) {
    setAuthBusy(true);
    setAuthError("");
    setAuthErrorKey(undefined);
    setAuth((value) =>
      value?.errorKey ? { ...value, errorKey: undefined } : value,
    );
    try {
      await action();
    } catch (error) {
      if (
        error instanceof AuthError &&
        (error.status === 401 || error.code === "ACCOUNT_UNAVAILABLE")
      ) {
        setSession(undefined);
        setAuth((value) => value && { ...value, account: undefined });
      }
      reportAuthFailure(error, "auth.requestFailed");
    } finally {
      setAuthBusy(false);
    }
  }
  async function signOut() {
    void disableDirectMessagePush(true).catch(() => undefined);
    // Exit the world immediately; the server also disconnects every socket of the invalidated session.
    setSession(undefined);
    setSelectedSpace(undefined);
    setSelectedMapId(undefined);
    setSelectedReservationId("");
    setMapTransferResumeToken("");
    setPortalAdmissionSource(undefined);
    await runAuth(async () => {
      await logout();
      setAuth((value) => value && { ...value, account: undefined });
    });
  }
  async function signOutEverywhere() {
    void disableDirectMessagePush(true).catch(() => undefined);
    setSession(undefined);
    setSelectedSpace(undefined);
    setSelectedMapId(undefined);
    setSelectedReservationId("");
    setMapTransferResumeToken("");
    setPortalAdmissionSource(undefined);
    await logoutEverywhere();
    setAuth((value) => value && { ...value, account: undefined });
  }
  function accountDeleted() {
    void disableDirectMessagePush(true).catch(() => undefined);
    setSession(undefined);
    setSelectedSpace(undefined);
    setSelectedMapId(undefined);
    setSelectedReservationId("");
    setMapTransferResumeToken("");
    setPortalAdmissionSource(undefined);
    setAuth((value) =>
      value ? { ...value, account: undefined, error: "" } : value,
    );
  }
  async function leaveCampus() {
    const wasGuest = guestMode;
    setSession(undefined);
    setSelectedSpace(undefined);
    setSelectedMapId(undefined);
    setSelectedReservationId("");
    setMapTransferResumeToken("");
    setPortalAdmissionSource(undefined);
    setGuestMode(false);
    guestAdmissionTicket.current = undefined;
    if (wasGuest) {
      clearPending("space");
      setGuestSpace(undefined);
      try {
        await clearGuestSession();
      } catch (error) {
        reportAuthFailure(error, "auth.guestLeaveFailed");
      }
      return;
    }
    if (auth?.config.mode === "sso")
      await runAuth(async () => {
        const account = await currentAccount();
        setAuth((value) => value && { ...value, account });
      });
  }
  async function joinCampus(
    profile: { name: string; avatar: number } & AvatarAppearance,
  ) {
    if (!auth) return;
    if (auth.config.mode === "preview") {
      const previous = loadPreviewProfile();
      try {
        localStorage.setItem(
          "hufs-town.preview-profile",
          JSON.stringify({
            ...profile,
            bio: previous?.bio ?? "",
            links: previous?.links ?? [],
          }),
        );
      } catch {
        /* The active preview session still uses this profile. */
      }
      setSession(profile);
      return;
    }
    await runAuth(async () => {
      const account = await saveProfile(
        profile.name,
        profile.avatar,
        profile,
        auth.account?.bio ?? "",
        auth.account?.links ?? [],
      );
      setAuth((value) => value && { ...value, account });
      setSession({
        name: account.displayName,
        avatar: account.avatar,
        skin: account.skin,
        clothing: account.clothing,
        hair: account.hair,
        userId: account.userId,
        allowPokes: account.allowPokes,
      });
    });
  }
  async function joinGuestCampus(
    profile: { name: string; avatar: number } & AvatarAppearance,
  ) {
    if (!guestSpace) return;
    await runAuth(async () => {
      guestAdmissionTicket.current = await requestGuestAdmission(
        guestSpace.id,
        profile,
      );
      setSelectedSpace({
        id: guestSpace.id,
        name: guestSpace.name,
        description: guestSpace.description,
        visibility: "PUBLIC",
        capacity: guestSpace.capacity,
        templateId: "CAMPUS_SQUARE",
        role: "",
        approvalRequired: false,
        allowedEmailDomains: [],
        guestEntryEnabled: true,
        joinRequestStatus: "",
        favorite: false,
        archived: false,
      });
      setSelectedReservationId("");
      setGuestMode(true);
      setSession({ ...profile, allowPokes: false });
      clearPending("space");
    });
  }
  async function followPortal(
    portal: Portal,
    sourceMapId: string,
    sourceSpaceId: string,
  ) {
    if (!auth?.account) return;
    try {
      const target = await getSpace(portal.targetSpaceId);
      // Unmount the current world first so its socket and media tracks are closed
      // before the target space's admission flow starts.
      setSession(undefined);
      setSelectedSpace(target);
      setSelectedMapId(portal.targetMapId || undefined);
      setSelectedReservationId("");
      setMapTransferResumeToken("");
      setPortalAdmissionSource({
        sourceSpaceId,
        sourceMapId,
        portalId: portal.id,
      });
      setAuthError("");
      setAuthErrorKey(undefined);
    } catch (error) {
      reportAuthFailure(error, "portal.destinationFailed");
    }
  }
  function openMeetupDestination(spaceId: string) {
    if (!auth?.account) throw new Error(t("meetup.loginRequired"));
    const currentSpaceId = selectedSpace?.id ?? bootstrap?.space.id;
    if (session && currentSpaceId === spaceId) return true;
    setPending("space", spaceId);
    setSession(undefined);
    setSelectedSpace(undefined);
    setSelectedMapId(undefined);
    setSelectedReservationId("");
    setMapTransferResumeToken("");
    setPortalAdmissionSource(undefined);
    setAuthError("");
    return false;
  }
  useEffect(() => {
    const abort = new AbortController();
    setBootstrapErrorKey(undefined);
    fetch("/api/v1/bootstrap", { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) throw Error();
        return r.json();
      })
      .then(setBootstrap)
      .catch((e) => {
        if (e.name !== "AbortError")
          setBootstrapErrorKey("landing.serverUnavailable");
      });
    return () => abort.abort();
  }, [request]);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("dm");
    if (requested && /^[0-9a-f-]{36}$/i.test(requested)) {
      try {
        sessionStorage.setItem("hufs-town.pending-dm", requested);
      } catch {
        /* The URL route remains available for this page load. */
      }
    }
  }, []);
  useEffect(() => {
    if (!auth?.account || !bootstrap || session) return;
    const account = auth.account;
    let requested = "";
    try {
      requested = sessionStorage.getItem("hufs-town.pending-dm") ?? "";
    } catch {
      /* The route can still be handled by Campus. */
    }
    if (!/^[0-9a-f-]{36}$/i.test(requested)) return;
    let active = true;
    void getSpace(bootstrap.space.id)
      .then((space) => {
        if (!active) return;
        try {
          sessionStorage.removeItem("hufs-town.pending-dm");
        } catch {
          /* The route remains available in the URL. */
        }
        const url = new URL(window.location.href);
        url.searchParams.set("dm", requested);
        history.replaceState(
          null,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
        setSelectedSpace(space);
        setSession({
          name: account.displayName,
          avatar: account.avatar,
          skin: account.skin,
          clothing: account.clothing,
          hair: account.hair,
          userId: account.userId,
          allowPokes: account.allowPokes,
        });
      })
      .catch(() => {
        if (active) {
          setAuthError("");
          setAuthErrorKey("auth.notificationConversationUnavailable");
        }
      });
    return () => {
      active = false;
    };
  }, [auth?.account, bootstrap, session]);
  const previewProfile =
    auth?.config.mode === "preview" ? loadPreviewProfile() : undefined;
  if (editingSpace && auth?.account)
    return (
      <Suspense
        fallback={
          <div className="loading-message" role="status">
            {t("editor.status.loading")}
          </div>
        }
      >
        <MapEditor
          key={editingSpace.id}
          space={editingSpace}
          user={auth.account.userId}
          close={() => setEditingSpace(undefined)}
        />
      </Suspense>
    );
  if (session && bootstrap)
    return (
      <Campus
        key={`${selectedSpace?.id ?? bootstrap.space.id}:${selectedMapId ?? "default"}`}
        bootstrap={
          selectedSpace ? { ...bootstrap, space: selectedSpace } : bootstrap
        }
        session={session}
        admissionSpace={
          auth?.account &&
          selectedSpace?.approvalRequired &&
          (selectedSpace.role === "OWNER" || selectedSpace.role === "ADMIN")
            ? { id: selectedSpace.id, name: selectedSpace.name }
            : undefined
        }
        onAcceptInvite={
          auth?.account
            ? (space) => {
                clearPending("invite");
                setPending("space", space.id);
                void leaveCampus();
              }
            : undefined
        }
        initialResumeToken={mapTransferResumeToken}
        leave={() => void leaveCampus()}
        logout={auth?.account ? () => void signOut() : undefined}
        onJoinTransfer={(mapId, resumeToken) => {
          setMapTransferResumeToken(resumeToken);
          setSelectedMapId(mapId);
          setSelectedReservationId("");
          setPortalAdmissionSource(undefined);
        }}
        onOpenMeetupDestination={openMeetupDestination}
        onPortal={(portal, sourceMapId) =>
          void followPortal(
            portal,
            sourceMapId,
            selectedSpace?.id ?? bootstrap.space.id,
          )
        }
        profileBio={auth?.account?.bio ?? previewProfile?.bio ?? ""}
        profileLinks={auth?.account?.links ?? previewProfile?.links ?? []}
        onSaveProfile={async (draft) => {
          if (auth?.account) {
            const account = await saveProfile(
              draft.name,
              draft.avatar,
              draft,
              draft.bio,
              draft.links,
            );
            setAuth((value) => (value ? { ...value, account } : value));
            setSession((value) =>
              value
                ? {
                    ...value,
                    name: account.displayName,
                    avatar: account.avatar,
                    skin: account.skin,
                    clothing: account.clothing,
                    hair: account.hair,
                  }
                : value,
            );
            return {
              name: account.displayName,
              avatar: account.avatar,
              skin: account.skin,
              clothing: account.clothing,
              hair: account.hair,
              bio: account.bio,
              links: account.links,
            };
          }
          try {
            localStorage.setItem(
              "hufs-town.preview-profile",
              JSON.stringify(draft),
            );
          } catch {
            /* preview remains in memory */
          }
          setSession((value) =>
            value
              ? {
                  ...value,
                  name: draft.name,
                  avatar: draft.avatar,
                  skin: draft.skin,
                  clothing: draft.clothing,
                  hair: draft.hair,
                }
              : value,
          );
          return {
            ...draft,
            name: draft.name.trim(),
            bio: draft.bio.trim(),
            links: draft.links.map((link) => link.trim()).filter(Boolean),
          };
        }}
        admit={
          selectedSpace
            ? (resumeToken) => {
                if (guestMode) {
                  const ticket = guestAdmissionTicket.current;
                  if (ticket) {
                    guestAdmissionTicket.current = undefined;
                    return Promise.resolve(ticket);
                  }
                  return requestGuestAdmission(selectedSpace.id, {
                    resumeToken,
                  });
                }
                return requestAdmission(
                  selectedSpace.id,
                  selectedMapId,
                  portalAdmissionSource,
                  resumeToken,
                  selectedReservationId,
                );
              }
            : undefined
        }
      />
    );
  if (auth?.account)
    return (
      <Suspense
        fallback={
          <main className="loading-message" role="status">
            {t("lobby.loading")}
          </main>
        }
      >
        <SpaceLobby
          account={auth.account}
          brand={<Brand />}
          signOut={() => void signOut()}
          signOutEverywhere={signOutEverywhere}
          onAccountDeleted={accountDeleted}
          onProfileSaved={(account) =>
            setAuth((value) => (value ? { ...value, account } : value))
          }
          onEditMap={setEditingSpace}
          onEnter={(space, mapId, reservationId) => {
            setAuthError("");
            setSelectedSpace(space);
            setSelectedMapId(mapId);
            setSelectedReservationId(reservationId ?? "");
            setMapTransferResumeToken("");
            setPortalAdmissionSource(undefined);
          }}
        >
          {selectedSpace && (
            <Dialog
              title={selectedSpace.name}
              close={() => {
                if (!authBusy) setSelectedSpace(undefined);
              }}
            >
              <p className="muted">{t("join.enterPrompt")}</p>
              {authErrorMessage && (
                <p className="space-error" role="alert">
                  {authErrorMessage}
                </p>
              )}
              {error && (
                <p className="space-error" role="alert">
                  {error}
                </p>
              )}
              <JoinForm
                key={selectedSpace.id}
                initialName={auth.account.displayName}
                initialAvatar={auth.account.avatar}
                initialSkin={auth.account.skin}
                initialClothing={auth.account.clothing}
                initialHair={auth.account.hair}
                preview={false}
                disabled={!bootstrap || authBusy}
                space={selectedSpace}
                onJoin={(profile) => void joinCampus(profile)}
              />
            </Dialog>
          )}
        </SpaceLobby>
      </Suspense>
    );
  return (
    <div className="landing">
      <header className="landing-header">
        <Brand />
        <div className="landing-header-tools">
          <LanguagePicker />
          <span className="preview-pill">
            <span />
            {auth?.config.mode === "sso"
              ? "HUFS SSO"
              : t("landing.localPreviewBadge")}
          </span>
        </div>
      </header>
      <main className="welcome-layout">
        <section className="welcome-story">
          <h1>{t("landing.title")}</h1>
          <p className="welcome-description">{t("landing.description")}</p>
          <div className="campus-illustration">
            <div className="illustration-orbit" />
            <img
              src="/assets/campus.png"
              alt={t("landing.campusIllustrationAlt")}
            />
          </div>
        </section>
        <section className="join-card">
          <div className="join-heading">
            <h2>{t("landing.heading")}</h2>
          </div>
          <p className="muted">
            {t(
              auth?.config.mode === "preview"
                ? "landing.subtitle.preview"
                : "landing.subtitle",
            )}
          </p>
          <div className="auth-panel">
            {auth?.account ? (
              <div className="account-status">
                <ShieldCheck size={20} />
                <span>
                  <strong>
                    {t("landing.accountWelcome", {
                      name: auth.account.displayName,
                    })}
                  </strong>
                  <small>{t("landing.accountSignedIn")}</small>
                </span>
                <button
                  className="text-button"
                  disabled={authBusy}
                  onClick={() => void signOut()}
                >
                  {t("landing.signOut")}
                </button>
              </div>
            ) : (
              <>
                <button
                  className="sso-button"
                  disabled={!auth?.config.configured || authBusy}
                  onClick={() => void runAuth(startLogin)}
                >
                  <img src={ASSET_GROUPS.brand.mark} alt="" />
                  {authBusy ? t("landing.loginBusy") : t("landing.login")}
                  <ArrowUpRight size={18} />
                </button>
                <p className="auth-hint">
                  {!auth
                    ? t("landing.loginChecking")
                    : auth.config.configured
                      ? t("landing.loginReturn")
                      : t("landing.loginUnavailable")}
                </p>
              </>
            )}
            {authErrorMessage && (
              <div className="server-error" role="alert">
                {authErrorMessage}
                <button onClick={() => setRequest((r) => r + 1)}>
                  {t("landing.localAgain")}
                </button>
              </div>
            )}
          </div>
          {auth?.config.mode === "preview" && (
            <div className="auth-divider">{t("landing.previewEntry")}</div>
          )}
          {(auth?.account || auth?.config.mode === "preview") && (
            <JoinForm
              key={auth.account?.userId ?? "preview"}
              initialName={auth.account?.displayName ?? previewProfile?.name}
              initialAvatar={auth.account?.avatar ?? previewProfile?.avatar}
              initialSkin={auth.account?.skin ?? previewProfile?.skin}
              initialClothing={
                auth.account?.clothing ?? previewProfile?.clothing
              }
              initialHair={auth.account?.hair ?? previewProfile?.hair}
              preview={auth.config.mode === "preview"}
              disabled={!bootstrap || authBusy}
              onJoin={(profile) => void joinCampus(profile)}
            />
          )}
          {error ? (
            <div className="server-error" role="alert">
              {error}
              <button onClick={() => setRequest((r) => r + 1)}>
                <RefreshCw size={14} /> {t("landing.localAgain")}
              </button>
            </div>
          ) : !bootstrap ? (
            <p className="loading-message" role="status">
              {t("landing.loading")}
            </p>
          ) : (
            <div className="server-ready">
              <span /> {t("landing.serverReady")}
            </div>
          )}
        </section>
      </main>
      <footer className="landing-footer">
        <span>GDG on Campus · HUFS</span>
      </footer>
      {guestSpace && auth?.config.mode === "sso" && !auth.account && (
        <Dialog
          title={t("landing.guestTitle", { name: guestSpace.name })}
          close={() => {
            if (authBusy) return;
            clearPending("space");
            setGuestSpace(undefined);
            setAuthError("");
          }}
        >
          <p className="muted">{t("landing.guestDescription")}</p>
          {authErrorMessage && (
            <p className="space-error" role="alert">
              {authErrorMessage}
            </p>
          )}
          <JoinForm
            key={`guest:${guestSpace.id}`}
            preview
            disabled={!bootstrap || authBusy}
            space={guestSpace}
            onJoin={(profile) => void joinGuestCampus(profile)}
          />
        </Dialog>
      )}
    </div>
  );
}

function JoinForm({
  disabled,
  onJoin,
  initialName,
  initialAvatar,
  initialSkin,
  initialClothing,
  initialHair,
  preview,
  space,
}: {
  disabled: boolean;
  onJoin: (s: { name: string; avatar: number } & AvatarAppearance) => void;
  initialName?: string;
  initialAvatar?: number;
  initialSkin?: string;
  initialClothing?: string;
  initialHair?: string;
  preview: boolean;
  space?: { name: string; capacity: number };
}) {
  const { language, t } = useLanguage();
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [name, setName] = useState(
    () =>
      initialName ??
      (preview ? (localStorage.getItem("hufs.displayName") ?? "") : ""),
  );
  const [avatar, setAvatar] = useState(initialAvatar ?? 0);
  const [skin, setSkin] = useState(initialSkin ?? "light");
  const [clothing, setClothing] = useState(
    initialClothing ??
      AVATAR_CATALOG.defaults.clothing[avatar] ??
      "casual_white",
  );
  const [hair, setHair] = useState(initialHair ?? "hair_short_black");
  const [appearanceTab, setAppearanceTab] = useState<
    "skin" | "clothing" | "hair"
  >("skin");
  const appearance = { skin, clothing, hair };
  const randomizeAppearance = () => {
    const pick = <T,>(options: readonly T[]) =>
      options[Math.floor(Math.random() * options.length)];
    setAvatar(Math.floor(Math.random() * AVATAR_CATALOG.bodyShapes.length));
    setSkin(pick(AVATAR_CATALOG.skinTones));
    setClothing(pick(AVATAR_CATALOG.clothing));
    setHair(pick(AVATAR_CATALOG.hair));
  };
  const enterCampus = () => {
    if (!name.trim() || disabled) return;
    if (preview) localStorage.setItem("hufs.displayName", name.trim());
    onJoin({ name: name.trim(), avatar, ...appearance });
  };
  const label = (value: string) =>
    avatarPartLabel(value, (word) => t(`avatarPart.${word}` as TranslationKey));
  const bodyShape =
    AVATAR_CATALOG.bodyShapes[avatar] ?? AVATAR_CATALOG.bodyShapes[0];
  const appearanceOptions = {
    skin: AVATAR_CATALOG.skinTones,
    clothing: AVATAR_CATALOG.clothing,
    hair: AVATAR_CATALOG.hair,
  }[appearanceTab];
  const appearanceLabel = (part: "skin" | "clothing" | "hair", value: string) =>
    label(part === "hair" ? value.slice(5) : value);
  const updateAppearance = (value: string) => {
    if (appearanceTab === "skin") setSkin(value);
    else if (appearanceTab === "clothing") setClothing(value);
    else setHair(value);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        enterCampus();
      }}
    >
      <div className="join-avatar-preview">
        <div className="join-avatar-stage">
          <Avatar id={avatar} size={84} appearance={appearance} />
        </div>
        <label className="join-body-shape">
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
      <p className="avatar-caption">{t("join.avatarCaption")}</p>
      <button
        className="avatar-randomize"
        type="button"
        onClick={randomizeAppearance}
      >
        <Shuffle size={15} /> {t("join.randomize")}
      </button>
      <div className="join-appearance-picker">
        <div
          className="join-appearance-tabs"
          aria-label={t("join.avatarCaption")}
        >
          {(["skin", "clothing", "hair"] as const).map((part) => {
            const value = appearance[part];
            const sprite =
              part === "skin"
                ? `body-${bodyShape}-${value}`
                : `${part}-${bodyShape}-${value}`;
            return (
              <button
                key={part}
                className={`join-appearance-tab${appearanceTab === part ? " selected" : ""}`}
                type="button"
                aria-pressed={appearanceTab === part}
                onClick={() => setAppearanceTab(part)}
              >
                <span
                  className="join-appearance-part-icon"
                  aria-hidden="true"
                  style={{
                    backgroundImage: `url(/assets/avatar-parts/${sprite}.png)`,
                  }}
                />
                <span className="join-appearance-tab-copy">
                  <small>{t(`join.${part}` as TranslationKey)}</small>
                  <strong>{appearanceLabel(part, value)}</strong>
                </span>
              </button>
            );
          })}
        </div>
        <div
          className="join-appearance-options"
          aria-label={t(`join.${appearanceTab}` as TranslationKey)}
        >
          {appearanceOptions.map((value) => {
            const optionAppearance = { ...appearance, [appearanceTab]: value };
            const selected = appearance[appearanceTab] === value;
            return (
              <button
                key={value}
                className={`join-appearance-option${selected ? " selected" : ""}`}
                type="button"
                aria-label={appearanceLabel(appearanceTab, value)}
                aria-pressed={selected}
                title={appearanceLabel(appearanceTab, value)}
                onClick={() => updateAppearance(value)}
              >
                <Avatar id={avatar} size={36} appearance={optionAppearance} />
                <small>{appearanceLabel(appearanceTab, value)}</small>
              </button>
            );
          })}
        </div>
      </div>
      <label className="form-label" htmlFor="nickname">
        {t("join.name")} <span>{formatNumber(language, name.length)}/20</span>
      </label>
      <input
        id="nickname"
        autoComplete="nickname"
        maxLength={20}
        required
        placeholder={t("join.namePlaceholder")}
        value={name}
        onChange={(e) =>
          setName(e.target.value.replace(/[\x00-\x1F\x7F]/g, ""))
        }
      />
      <button
        className="join-button"
        disabled={disabled || !name.trim()}
        type="submit"
      >
        {t("join.enter")} <ArrowRight size={19} />
      </button>
      <button
        className="join-device-check"
        disabled={disabled}
        type="button"
        onClick={() => setPreflightOpen(true)}
      >
        <Settings2 size={15} /> {t("join.deviceCheck")}
      </button>
      {preflightOpen && (
        <Suspense
          fallback={
            <p className="loading-message" role="status">
              {t("landing.loading")}
            </p>
          }
        >
          <MediaPreflight
            close={() => setPreflightOpen(false)}
            canEnter={!disabled && !!name.trim()}
            enter={() => {
              setPreflightOpen(false);
              enterCampus();
            }}
          />
        </Suspense>
      )}
      <div className="destination">
        <span className="destination-icon">
          <Map size={17} />
        </span>
        <div>
          <strong>{space?.name ?? t("join.defaultCampus")}</strong>
          <small>
            {t("join.officeCapacity", {
              count: formatNumber(language, space?.capacity ?? 100),
            })}
          </small>
        </div>
        <ArrowUpRight size={16} />
      </div>
    </form>
  );
}
function ChatPanel({
  messages,
  channel,
  mode,
  conversations,
  conversationId,
  authenticated,
  error,
  zoneName,
  zoneId,
  selfId,
  onScopeChannelChange,
  persistHistory,
  online,
  historyPage,
  leavingGroup,
  mutationAck,
  mutatingMessageId,
  onInviteGroup,
  onManageGroup,
  onRequestMeetup,
  meetupRequestBusy,
  onModeChange,
  onSelectConversation,
  onBack,
  onLeaveGroup,
  onLoadOlder,
  onReloadHistory,
  onMutateMessage,
  onLoadMessageRevisions,
  onReportMessage,
  reportSuccess,
  onSend,
}: {
  messages: ChatLine[];
  channel: "nearby" | "room" | "space" | "dm";
  mode: "scope" | "dm";
  conversations: DirectConversation[];
  conversationId: string;
  authenticated: boolean;
  error: string;
  zoneName: string;
  zoneId: string;
  selfId: string;
  onScopeChannelChange: (channel: "nearby" | "space") => void;
  persistHistory: boolean;
  online: boolean;
  historyPage: ChatHistoryPage;
  leavingGroup: boolean;
  mutationAck: DirectMessageMutationAck | null;
  mutatingMessageId: string;
  onInviteGroup: (conversationId: string) => void;
  onManageGroup: (conversationId: string) => void;
  onRequestMeetup: (conversationId: string) => void;
  meetupRequestBusy: boolean;
  onModeChange: (mode: "scope" | "dm") => void;
  onSelectConversation: (conversationId: string) => void;
  onBack: () => void;
  onLeaveGroup: (conversationId: string) => void;
  onLoadOlder: () => Promise<void>;
  onReloadHistory: () => Promise<void>;
  onMutateMessage: (
    conversationId: string,
    messageId: string,
    action: "EDIT" | "DELETE",
    text: string,
  ) => boolean;
  onLoadMessageRevisions: (
    conversationId: string,
    messageId: string,
  ) => Promise<DirectMessageRevision[]>;
  onReportMessage: (conversationId: string, messageId: string) => void;
  reportSuccess: string;
  onSend: (
    text: string,
    channel: "nearby" | "room" | "space" | "dm",
    zoneId: string,
    conversationId: string,
  ) => boolean;
}) {
  const { language, t } = useLanguage();
  const { confirm } = useDialogActions();
  const chatEmojis = [
    { value: "👋", label: t("chat.emoji.greeting") },
    { value: "😊", label: t("chat.emoji.smile") },
    { value: "🎉", label: t("chat.emoji.celebrate") },
    { value: "❤️", label: t("chat.emoji.heart") },
    { value: "👍", label: t("chat.emoji.like") },
    { value: "😂", label: t("chat.emoji.laugh") },
  ];
  const [draft, setDraft] = useState("");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editingDraft, setEditingDraft] = useState("");
  const [revisionHistory, setRevisionHistory] = useState<{
    messageId: string;
    revision: number;
    entries: DirectMessageRevision[];
    loading: boolean;
    error: string;
  } | null>(null);
  const revisionRequest = useRef(0);
  const handledMutationAck = useRef("");
  const list = useRef<HTMLDivElement | null>(null);
  const composeInput = useRef<HTMLInputElement | null>(null);
  const emojiTrigger = useRef<HTMLButtonElement | null>(null);
  const chatTabsId = useId();
  const scrollBaseline = useRef({ height: 0, top: 0, count: 0 });
  const preserveScroll = useRef(false);
  const currentConversation = `${channel}:${conversationId}:${zoneId}`;
  const previousConversation = useRef(currentConversation);
  const conversation = conversations.find(
    (item) => item.conversationId === conversationId,
  );
  const visible = messages.filter((message) =>
    channel === "dm"
      ? message.channel === "dm" && message.conversationId === conversationId
      : message.channel === channel &&
        (channel !== "room" || message.zoneId === zoneId),
  );
  useEffect(() => {
    if (
      mutationAck?.accepted &&
      mutationAck.requestId !== handledMutationAck.current &&
      mutationAck.conversationId === conversationId &&
      mutationAck.messageId === editingMessageId
    ) {
      handledMutationAck.current = mutationAck.requestId;
      setEditingMessageId("");
      setEditingDraft("");
    }
  }, [mutationAck, conversationId, editingMessageId]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    if (previousConversation.current !== currentConversation) {
      previousConversation.current = currentConversation;
      preserveScroll.current = false;
      element.scrollTop = element.scrollHeight;
      return;
    }
    if (preserveScroll.current) {
      if (historyPage.loading) return;
      if (visible.length > scrollBaseline.current.count)
        element.scrollTop =
          scrollBaseline.current.top +
          (element.scrollHeight - scrollBaseline.current.height);
      preserveScroll.current = false;
      return;
    }
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [visible.length, currentConversation, historyPage.loading]);
  function loadOlder() {
    const element = list.current;
    if (!element || historyPage.loading || !online) return;
    scrollBaseline.current = {
      height: element.scrollHeight,
      top: element.scrollTop,
      count: visible.length,
    };
    preserveScroll.current = true;
    void onLoadOlder();
  }
  function insertChatEmoji(value: string) {
    const input = composeInput.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    const nextDraft = `${draft.slice(0, start)}${value}${draft.slice(end)}`;
    const nextCursor = start + value.length;
    setDraft(nextDraft);
    setEmojiPickerOpen(false);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(nextCursor, nextCursor);
    });
  }
  async function toggleRevisionHistory(messageId: string, revision: number) {
    if (
      revisionHistory?.messageId === messageId &&
      revisionHistory.revision === revision &&
      !revisionHistory.loading &&
      !revisionHistory.error
    ) {
      revisionRequest.current++;
      setRevisionHistory(null);
      return;
    }
    const requestId = ++revisionRequest.current;
    setRevisionHistory({
      messageId,
      revision,
      entries: [],
      loading: true,
      error: "",
    });
    try {
      const entries = await onLoadMessageRevisions(conversationId, messageId);
      if (requestId === revisionRequest.current)
        setRevisionHistory({
          messageId,
          revision,
          entries,
          loading: false,
          error: "",
        });
    } catch {
      if (requestId === revisionRequest.current)
        setRevisionHistory({
          messageId,
          revision,
          entries: [],
          loading: false,
          error: t("chat.message.historyError"),
        });
    }
  }
  function handleChatTabKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]:not(:disabled)',
      ),
    );
    if (tabs.length < 2) return;
    const current = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[role="tab"]',
    );
    const currentIndex = current ? tabs.indexOf(current) : -1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (currentIndex +
              (event.key === "ArrowRight" ? 1 : -1) +
              tabs.length) %
            tabs.length;
    const nextTab = tabs[nextIndex];
    event.preventDefault();
    nextTab.focus();
    onModeChange(nextIndex === 0 ? "scope" : "dm");
  }
  return (
    <div className="chat-panel-content">
      <div
        className="chat-tabs"
        role="tablist"
        aria-label={t("chat.tabs.aria")}
        onKeyDown={handleChatTabKeyDown}
      >
        <button
          type="button"
          role="tab"
          id={`${chatTabsId}-scope-tab`}
          aria-controls={`${chatTabsId}-panel`}
          aria-selected={mode === "scope"}
          tabIndex={mode === "scope" ? 0 : -1}
          className={mode === "scope" ? "active" : ""}
          onClick={() => onModeChange("scope")}
        >
          {t("chat.tabs.scope")}
        </button>
        <button
          type="button"
          role="tab"
          id={`${chatTabsId}-dm-tab`}
          aria-controls={`${chatTabsId}-panel`}
          aria-selected={mode === "dm"}
          tabIndex={mode === "dm" ? 0 : -1}
          className={mode === "dm" ? "active" : ""}
          disabled={!authenticated}
          onClick={() => onModeChange("dm")}
        >
          {t("chat.tabs.direct")}
          {conversations.some((item) => item.unreadCount > 0) && <i />}
        </button>
      </div>
      <section
        id={`${chatTabsId}-panel`}
        role="tabpanel"
        tabIndex={0}
        aria-labelledby={`${chatTabsId}-${mode === "scope" ? "scope" : "dm"}-tab`}
      >
        {mode === "scope" && channel !== "room" && (
          <div
            className="chat-scope-tabs"
            role="group"
            aria-label={t("chat.scope.aria")}
          >
            <button
              type="button"
              className={channel === "nearby" ? "active" : ""}
              aria-pressed={channel === "nearby"}
              onClick={() => onScopeChannelChange("nearby")}
            >
              {t("chat.scope.nearby")}
            </button>
            <button
              type="button"
              className={channel === "space" ? "active" : ""}
              aria-pressed={channel === "space"}
              onClick={() => onScopeChannelChange("space")}
            >
              {t("chat.scope.space")}
            </button>
          </div>
        )}
        {mode === "dm" && !conversationId ? (
          <div className="dm-inbox">
            <div className="chat-context">
              <span className="chat-context-icon">
                <MessageCircle size={16} />
              </span>
              <div>
                <strong>{t("chat.inbox.title")}</strong>
                <small>{t("chat.inbox.description")}</small>
              </div>
            </div>
            {error && (
              <p className="poke-feedback error" role="status">
                {error}
              </p>
            )}
            {reportSuccess && (
              <p className="poke-feedback success" role="status">
                {reportSuccess}
              </p>
            )}
            <div className="dm-conversation-list">
              {conversations.map((item) => (
                <button
                  type="button"
                  className="dm-conversation"
                  key={item.conversationId}
                  onClick={() => onSelectConversation(item.conversationId)}
                >
                  <span
                    className={`chat-avatar ${item.kind === "GROUP" ? "group-chat-avatar" : `color-${item.avatar ?? 0}`}`}
                  >
                    {item.kind === "GROUP" ? (
                      <Users size={17} />
                    ) : (
                      <Avatar
                        id={item.avatar ?? 0}
                        size={32}
                        appearance={{
                          skin: item.skin ?? "light",
                          clothing: item.clothing ?? "casual_white",
                          hair: item.hair ?? "hair_short_black",
                        }}
                      />
                    )}
                  </span>
                  <span className="dm-conversation-copy">
                    <strong>{item.displayName}</strong>
                    <small>
                      {item.kind === "GROUP"
                        ? `${formatNumber(language, item.participantCount)} · `
                        : ""}
                      {item.lastMessage || t("chat.inbox.emptyPreview")}
                    </small>
                  </span>
                  {item.unreadCount > 0 && (
                    <b className="dm-unread">
                      {item.unreadCount > 99 ? "99+" : item.unreadCount}
                    </b>
                  )}
                </button>
              ))}
              {!conversations.length && (
                <div className="chat-empty">
                  <span>✉️</span>
                  <strong>{t("chat.inbox.emptyTitle")}</strong>
                  <p>{t("chat.inbox.emptyDescription")}</p>
                </div>
              )}
            </div>
            <p className="chat-privacy-note">{t("chat.inbox.privacy")}</p>
          </div>
        ) : (
          <>
            {channel === "dm" && (
              <button type="button" className="dm-back" onClick={onBack}>
                ← {t("chat.back")}
              </button>
            )}
            {error && channel === "dm" && (
              <p className="poke-feedback error" role="status">
                {error}
              </p>
            )}
            {reportSuccess && channel === "dm" && (
              <p className="poke-feedback success" role="status">
                {reportSuccess}
              </p>
            )}
            <div className="chat-context">
              <span className="chat-context-icon">
                <MessageCircle size={16} />
              </span>
              <div>
                <strong>
                  {channel === "dm"
                    ? (conversation?.displayName ?? t("chat.directFallback"))
                    : channel === "room"
                      ? zoneName
                      : channel === "space"
                        ? t("chat.space")
                        : t("chat.nearby")}
                </strong>
                <small>
                  {channel === "dm"
                    ? conversation?.kind === "GROUP"
                      ? t("chat.group.visibility", {
                          count: formatNumber(
                            language,
                            conversation.participantCount,
                          ),
                        })
                      : t("chat.direct.visibility")
                    : channel === "room"
                      ? t("chat.room.visibility")
                      : channel === "space"
                        ? t("chat.space.visibility")
                        : t("chat.nearby.visibility")}
                </small>
              </div>
              {channel === "dm" && conversation?.kind === "GROUP" && (
                <div className="group-chat-actions">
                  <button
                    type="button"
                    className="group-manage-button"
                    onClick={() => onManageGroup(conversation.conversationId)}
                  >
                    <Users size={13} /> {t("chat.group.members")}
                  </button>
                  <button
                    type="button"
                    className="group-invite-button"
                    onClick={() => onInviteGroup(conversation.conversationId)}
                  >
                    <UserPlus size={13} /> {t("chat.group.invite")}
                  </button>
                  <button
                    type="button"
                    className="group-leave-button"
                    onClick={() => onLeaveGroup(conversation.conversationId)}
                    disabled={leavingGroup}
                  >
                    <DoorOpen size={14} />{" "}
                    {leavingGroup
                      ? t("chat.group.leaving")
                      : t("chat.group.leave")}
                  </button>
                </div>
              )}
              {channel === "dm" &&
                authenticated &&
                conversation?.kind === "DIRECT" && (
                  <button
                    type="button"
                    className="meetup-request-button"
                    onClick={() => onRequestMeetup(conversation.conversationId)}
                    disabled={meetupRequestBusy}
                    title={t("chat.meetup.title")}
                  >
                    {meetupRequestBusy
                      ? t("chat.meetup.busy")
                      : t("chat.meetup.button")}
                  </button>
                )}
            </div>
            <div
              className="chat-message-list"
              role="log"
              aria-live="polite"
              aria-label={
                channel === "dm"
                  ? t("chat.log.direct", {
                      name:
                        conversation?.displayName ?? t("chat.directFallback"),
                    })
                  : channel === "room"
                    ? t("chat.log.room", { name: zoneName })
                    : channel === "space"
                      ? t("chat.log.space")
                      : t("chat.log.nearby")
              }
              ref={list}
            >
              {persistHistory && historyPage.hasMore && (
                <button
                  type="button"
                  className="chat-load-older"
                  onClick={loadOlder}
                  disabled={historyPage.loading || !online}
                >
                  {historyPage.loading
                    ? t("chat.history.loadingOlder")
                    : historyPage.error
                      ? t("chat.history.retry")
                      : t("chat.history.loadOlder")}
                </button>
              )}
              {persistHistory && historyPage.error && (
                <p className="chat-history-error" role="status">
                  {t(historyPage.error)}
                </p>
              )}
              {persistHistory && historyPage.canReload && (
                <button
                  type="button"
                  className="chat-load-older"
                  onClick={() => void onReloadHistory()}
                  disabled={historyPage.loading || !online}
                >
                  {historyPage.loading
                    ? t("chat.history.loading")
                    : t("chat.history.reload")}
                </button>
              )}
              {visible.map((message) =>
                (() => {
                  const own = message.own || message.senderId === selfId;
                  const editable =
                    channel === "dm" &&
                    own &&
                    message.delivery === "sent" &&
                    !message.deleted &&
                    Date.now() - message.sentAt <= 15 * 60 * 1000;
                  const removable =
                    channel === "dm" &&
                    own &&
                    message.delivery === "sent" &&
                    !message.deleted;
                  const editing = editingMessageId === message.messageId;
                  const busy = !!mutatingMessageId;
                  return (
                    <article
                      className={`chat-message ${own ? "own" : ""} ${message.delivery === "failed" ? "failed" : ""}`}
                      key={message.messageId}
                    >
                      <span className={`chat-avatar color-${message.avatar}`}>
                        <Avatar
                          id={message.avatar}
                          size={28}
                          appearance={message}
                        />
                      </span>
                      <div className="chat-message-body">
                        <div className="chat-message-meta">
                          <strong>{message.senderName}</strong>
                          <span className="chat-message-meta-actions">
                            <time
                              dateTime={new Date(message.sentAt).toISOString()}
                            >
                              {formatDate(language, message.sentAt, {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </time>
                            {!editing && editable && (
                              <button
                                type="button"
                                aria-label={t("chat.message.editAria")}
                                title={t("chat.message.editTitle")}
                                disabled={busy}
                                onClick={() => {
                                  setEditingMessageId(message.messageId);
                                  setEditingDraft(message.text);
                                }}
                              >
                                <Pencil size={12} />
                              </button>
                            )}
                            {!editing && removable && (
                              <button
                                type="button"
                                aria-label={t("chat.message.deleteAria")}
                                title={t("chat.message.deleteTitle")}
                                disabled={busy}
                                onClick={async () => {
                                  if (
                                    await confirm(
                                      t("chat.message.deleteConfirm"),
                                    )
                                  )
                                    onMutateMessage(
                                      conversationId,
                                      message.messageId,
                                      "DELETE",
                                      "",
                                    );
                                }}
                              >
                                <Trash2 size={12} />
                              </button>
                            )}
                            {!own &&
                              channel === "dm" &&
                              message.delivery === "sent" &&
                              !message.deleted && (
                                <button
                                  type="button"
                                  aria-label={t("report.message.label")}
                                  title={t("report.message.title")}
                                  onClick={() =>
                                    onReportMessage(
                                      conversationId,
                                      message.messageId,
                                    )
                                  }
                                >
                                  <Flag size={12} />
                                </button>
                              )}
                          </span>
                        </div>
                        {editing ? (
                          <form
                            className="chat-message-edit"
                            onSubmit={(event) => {
                              event.preventDefault();
                              onMutateMessage(
                                conversationId,
                                message.messageId,
                                "EDIT",
                                editingDraft,
                              );
                            }}
                          >
                            <textarea
                              aria-label={t("chat.message.editingAria")}
                              maxLength={500}
                              value={editingDraft}
                              onChange={(event) =>
                                setEditingDraft(event.target.value)
                              }
                              autoFocus
                            />
                            <div>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingMessageId("");
                                  setEditingDraft("");
                                }}
                                disabled={busy}
                              >
                                {t("chat.message.cancel")}
                              </button>
                              <button
                                type="submit"
                                disabled={busy || !editingDraft.trim()}
                              >
                                {mutatingMessageId === message.messageId
                                  ? t("chat.message.saving")
                                  : t("chat.message.save")}
                              </button>
                            </div>
                          </form>
                        ) : message.deleted ? (
                          <p className="chat-message-deleted">
                            {t("chat.message.deleted")}
                          </p>
                        ) : (
                          <p>{message.text}</p>
                        )}
                        {message.editedAt > 0 && !message.deleted && (
                          <div className="chat-message-revision-link">
                            <small className="chat-message-edited">
                              {t("chat.message.edited")}
                            </small>
                            {channel === "dm" && (
                              <button
                                type="button"
                                aria-expanded={
                                  revisionHistory?.messageId ===
                                  message.messageId
                                }
                                onClick={() =>
                                  void toggleRevisionHistory(
                                    message.messageId,
                                    message.revision,
                                  )
                                }
                              >
                                {t("chat.message.revisions")}
                              </button>
                            )}
                          </div>
                        )}
                        {channel === "dm" &&
                          revisionHistory?.messageId === message.messageId && (
                            <div
                              className="chat-message-revisions"
                              aria-label={t("chat.message.revisionsAria")}
                            >
                              <div className="chat-message-revisions-heading">
                                <strong>{t("chat.message.previous")}</strong>
                                <button
                                  type="button"
                                  aria-label={t("chat.message.revisionsClose")}
                                  onClick={() => {
                                    revisionRequest.current++;
                                    setRevisionHistory(null);
                                  }}
                                >
                                  <X size={12} />
                                </button>
                              </div>
                              {revisionHistory.revision !== message.revision ? (
                                <div
                                  className="chat-message-revisions-empty"
                                  role="status"
                                >
                                  {t("chat.message.changed")}{" "}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void toggleRevisionHistory(
                                        message.messageId,
                                        message.revision,
                                      )
                                    }
                                  >
                                    {t("chat.message.refresh")}
                                  </button>
                                </div>
                              ) : revisionHistory.loading ? (
                                <p
                                  className="chat-message-revisions-empty"
                                  role="status"
                                >
                                  {t("chat.message.historyLoading")}
                                </p>
                              ) : revisionHistory.error ? (
                                <div
                                  className="chat-message-revisions-empty"
                                  role="status"
                                >
                                  {revisionHistory.error}{" "}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void toggleRevisionHistory(
                                        message.messageId,
                                        message.revision,
                                      )
                                    }
                                  >
                                    {t("chat.message.retry")}
                                  </button>
                                </div>
                              ) : revisionHistory.entries.length === 0 ? (
                                <p className="chat-message-revisions-empty">
                                  {t("chat.message.noPrevious")}
                                </p>
                              ) : (
                                revisionHistory.entries.map((entry) => (
                                  <article
                                    className="chat-message-revision"
                                    key={entry.revision}
                                  >
                                    <small>
                                      v{entry.revision} ·{" "}
                                      {formatDate(language, entry.versionAt, {
                                        month: "numeric",
                                        day: "numeric",
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </small>
                                    <p>{entry.text}</p>
                                    {editable && own && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setEditingMessageId(
                                            message.messageId,
                                          );
                                          setEditingDraft(entry.text);
                                          revisionRequest.current++;
                                          setRevisionHistory(null);
                                        }}
                                      >
                                        {t("chat.message.editVersion")}
                                      </button>
                                    )}
                                  </article>
                                ))
                              )}
                            </div>
                          )}
                        {channel === "dm" &&
                          own &&
                          (message.readByCount ?? 0) > 0 && (
                            <small className="chat-message-read">
                              {conversation?.kind === "GROUP"
                                ? t("chat.message.readCount", {
                                    count: formatNumber(
                                      language,
                                      message.readByCount ?? 0,
                                    ),
                                  })
                                : t("chat.message.read")}
                            </small>
                          )}
                        {message.delivery === "pending" && (
                          <small>{t("chat.message.sending")}</small>
                        )}
                        {message.delivery === "failed" && (
                          <small role="status">
                            {message.error || t("chat.message.sendFailed")}
                          </small>
                        )}
                      </div>
                    </article>
                  );
                })(),
              )}
              {!visible.length && (
                <div className="chat-empty">
                  <strong>{t("chat.empty.title")}</strong>
                </div>
              )}
            </div>
            <form
              className="chat-compose"
              onSubmit={(event) => {
                event.preventDefault();
                if (onSend(draft, channel, zoneId, conversationId))
                  setDraft("");
              }}
            >
              <label className="sr-only" htmlFor="campus-chat-input">
                {t("chat.compose.label")}
              </label>
              <input
                ref={composeInput}
                id="campus-chat-input"
                value={draft}
                maxLength={500}
                inputMode="text"
                enterKeyHint="send"
                autoComplete="off"
                placeholder={
                  online
                    ? t("chat.compose.placeholder")
                    : t("chat.compose.offline")
                }
                disabled={!online}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="chat-emoji-tools">
                <button
                  ref={emojiTrigger}
                  type="button"
                  className="chat-emoji-trigger"
                  aria-label={t("chat.compose.emoji")}
                  aria-expanded={emojiPickerOpen}
                  aria-controls={`${chatTabsId}-emoji-picker`}
                  onClick={() => setEmojiPickerOpen((open) => !open)}
                >
                  <Smile size={18} />
                </button>
                {emojiPickerOpen && (
                  <div
                    id={`${chatTabsId}-emoji-picker`}
                    className="chat-emoji-picker"
                    role="group"
                    aria-label={t("chat.compose.commonEmoji")}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setEmojiPickerOpen(false);
                        emojiTrigger.current?.focus();
                      }
                    }}
                  >
                    {chatEmojis.map(({ value, label }, index) => (
                      <button
                        key={value}
                        type="button"
                        aria-label={t("chat.compose.emojiLabel", { label })}
                        title={label}
                        autoFocus={index === 0}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => insertChatEmoji(value)}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="submit"
                aria-label={t("chat.compose.send")}
                disabled={!online || !draft.trim()}
              >
                <Send size={17} />
              </button>
            </form>
            <p className="chat-privacy-note">
              {channel === "dm"
                ? `${t("chat.privacy.retention")} ${t(
                    conversation?.kind === "GROUP"
                      ? "chat.privacy.groupMembers"
                      : "chat.privacy.directMembers",
                  )}`
                : persistHistory
                  ? `${t("chat.privacy.retention")} ${t(
                      channel === "room"
                        ? "chat.privacy.roomMembers"
                        : channel === "space"
                          ? "chat.privacy.spaceMembers"
                          : "chat.privacy.nearbyMembers",
                    )}`
                  : t("chat.privacy.preview")}
            </p>
          </>
        )}
      </section>
    </div>
  );
}

function loadPreviewProfile(): ProfileDraft | undefined {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem("hufs-town.preview-profile") ?? "null",
    );
    if (!value || typeof value !== "object") return undefined;
    const profile = value as Partial<ProfileDraft>;
    if (
      typeof profile.name !== "string" ||
      !profile.name.trim() ||
      profile.name.trim().length > 20 ||
      /[\x00-\x1f\x7f]|\p{Cf}/u.test(profile.name) ||
      !Number.isInteger(profile.avatar) ||
      profile.avatar! < 0 ||
      profile.avatar! >= AVATAR_CATALOG.bodyShapes.length ||
      !AVATAR_CATALOG.skinTones.some((part) => part === profile.skin) ||
      !AVATAR_CATALOG.clothing.some((part) => part === profile.clothing) ||
      !AVATAR_CATALOG.hair.some((part) => part === profile.hair) ||
      typeof profile.bio !== "string" ||
      Array.from(profile.bio).length > 280 ||
      /[\x00-\x1f\x7f]|\p{Cf}/u.test(profile.bio) ||
      !Array.isArray(profile.links) ||
      profile.links.length > 3 ||
      profile.links.some(
        (link) =>
          typeof link !== "string" ||
          link.length > 512 ||
          !/^https?:\/\/[^\s]+$/i.test(link),
      )
    )
      return undefined;
    return {
      name: profile.name.trim(),
      avatar: profile.avatar!,
      skin: profile.skin!,
      clothing: profile.clothing!,
      hair: profile.hair!,
      bio: profile.bio,
      links: [...profile.links],
    };
  } catch {
    return undefined;
  }
}

function Campus({
  bootstrap,
  session,
  admissionSpace,
  onAcceptInvite,
  initialResumeToken,
  leave,
  logout,
  admit,
  onJoinTransfer,
  onOpenMeetupDestination,
  onPortal,
  profileBio,
  profileLinks,
  onSaveProfile,
}: {
  bootstrap: Bootstrap;
  session: { name: string; avatar: number } & AvatarAppearance & {
      userId?: string;
      allowPokes?: boolean;
    };
  admissionSpace?: { id: string; name: string };
  onAcceptInvite?: (space: Space) => void;
  initialResumeToken: string;
  leave: () => void;
  logout?: () => void;
  admit?: (
    resumeToken: string,
  ) => Promise<string | { ticket: string; worldUrl?: string }>;
  onJoinTransfer?: (mapId: string, resumeToken: string) => void;
  onOpenMeetupDestination: (spaceId: string) => boolean;
  onPortal?: (portal: Portal, sourceMapId: string) => void;
  profileBio: string;
  profileLinks: string[];
  onSaveProfile: (draft: ProfileDraft) => Promise<ProfileDraft>;
}) {
  const { language, t } = useLanguage();
  const { confirm } = useDialogActions();
  const [connection] = useState(
    () =>
      new WorldConnection(
        bootstrap.worldPath,
        session.name,
        session.avatar,
        bootstrap.map.revision,
        admit,
        session.userId,
        bootstrap.space.id,
        session.skin,
        session.clothing,
        session.hair,
        profileBio,
        profileLinks,
        session.allowPokes,
        initialResumeToken,
      ),
  );
  useEffect(() => {
    const viewport = window.visualViewport;
    const updateKeyboardInset = () => {
      const appBottom =
        document
          .querySelector<HTMLElement>(".campus-app")
          ?.getBoundingClientRect().bottom ?? window.innerHeight;
      const keyboardInset = viewport
        ? Math.max(0, appBottom - viewport.height - viewport.offsetTop)
        : 0;
      document.documentElement.style.setProperty(
        "--app-keyboard-inset",
        `${keyboardInset > 120 ? keyboardInset : 0}px`,
      );
    };

    updateKeyboardInset();
    viewport?.addEventListener("resize", updateKeyboardInset);
    viewport?.addEventListener("scroll", updateKeyboardInset);
    window.addEventListener("resize", updateKeyboardInset);
    return () => {
      viewport?.removeEventListener("resize", updateKeyboardInset);
      viewport?.removeEventListener("scroll", updateKeyboardInset);
      window.removeEventListener("resize", updateKeyboardInset);
      document.documentElement.style.removeProperty("--app-keyboard-inset");
    };
  }, []);
  const state = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
  );
  const participantName = (playerId: string) =>
    state.players.find((player) => player.id === playerId)?.name ?? "";
  const online = state.status === "online";
  const handledJoinTransfer = useRef("");
  useEffect(() => {
    const result = state.lastJoinResult;
    if (
      !result?.accepted ||
      !result.moved ||
      !result.destinationMapId ||
      handledJoinTransfer.current === result.requestId
    )
      return;
    handledJoinTransfer.current = result.requestId;
    onJoinTransfer?.(result.destinationMapId, connection.getResumeToken());
  }, [connection, onJoinTransfer, state.lastJoinResult]);
  const recordedRecentVisit = useRef("");
  useEffect(() => {
    if (
      state.status === "online" &&
      session.userId &&
      recordedRecentVisit.current !== bootstrap.space.id
    ) {
      recordedRecentVisit.current = bootstrap.space.id;
      recordRecentSpaceVisit(session.userId, bootstrap.space.id);
    }
  }, [bootstrap.space.id, session.userId, state.status]);
  const [media] = useState(
    () => new MediaController(connection, !!bootstrap.features?.media),
  );
  const mediaView = useSyncExternalStore(media.subscribe, media.getSnapshot);
  const [assetsReady, setAssetsReady] = useState(false);
  useEffect(() => {
    let live = true;
    listSpaceAssets(bootstrap.space.id)
      .then((items) => {
        if (live) replaceCustomAssets(items);
      })
      .catch(() => {
        // Preview mode and older servers do not expose custom assets; built-in assets still work.
        if (live) replaceCustomAssets([]);
      })
      .finally(() => {
        if (live) setAssetsReady(true);
      });
    return () => {
      live = false;
    };
  }, [bootstrap.space.id]);
  useEffect(() => {
    media.start();
    return () => media.stop();
  }, [media]);
  const microphoneOn =
    mediaView.microphone && (!mediaView.pushToTalk || mediaView.talking);
  useEffect(() => {
    if (
      state.status === "online" &&
      state.worldFeatures.includes("MICROPHONE_PRESENCE")
    )
      connection.setMicrophoneOn(microphoneOn);
  }, [connection, microphoneOn, state.status, state.worldFeatures]);
  const [panel, setPanel] = useState<"map" | "people" | "chat" | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem("hufs-town.sidebar-collapsed.v2");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "hufs-town.sidebar-collapsed.v2",
        String(sidebarCollapsed),
      );
    } catch {
      // The collapsed state still applies for the current visit.
    }
  }, [sidebarCollapsed]);
  const [peoplePanelTab, setPeoplePanelTab] = useState<"people" | "settings">(
    "people",
  );
  const [quickChatOpen, setQuickChatOpen] = useState(false);
  const [quickChatDraft, setQuickChatDraft] = useState("");
  const quickChatInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!quickChatOpen) return;
    const frame = window.requestAnimationFrame(() =>
      quickChatInputRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [quickChatOpen]);
  useEffect(() => {
    const openNearbyChat = (event: KeyboardEvent) => {
      if (
        event.code !== "Enter" ||
        event.repeat ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        quickChatOpen ||
        !online
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(
          'input, textarea, select, button, a, [contenteditable="true"], [role="button"], [role="dialog"]',
        )
      )
        return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setQuickChatOpen(true);
    };
    window.addEventListener("keydown", openNearbyChat, true);
    return () => window.removeEventListener("keydown", openNearbyChat, true);
  }, [online, quickChatOpen]);
  const [chatMode, setChatMode] = useState<"scope" | "dm">("scope");
  const [spaceChatPreferred, setSpaceChatPreferred] = useState(false);
  const [activeDirectConversationId, setActiveDirectConversationId] =
    useState("");
  const [documentVisible, setDocumentVisible] = useState(
    () => !document.hidden,
  );
  const [directConversations, setDirectConversations] = useState<
    DirectConversation[]
  >([]);
  const [directMessageErrorDetail, setDirectMessageErrorDetail] = useState("");
  const [directMessageErrorKey, setDirectMessageErrorKey] =
    useState<TranslationKey>();
  const directMessageError =
    language === "ko" && directMessageErrorDetail
      ? directMessageErrorDetail
      : directMessageErrorKey
        ? t(directMessageErrorKey)
        : directMessageErrorDetail;
  function setDirectMessageError(message: string) {
    setDirectMessageErrorDetail(message);
    setDirectMessageErrorKey(undefined);
  }
  function setDirectMessageErrorWithKey(key: TranslationKey, detail = "") {
    setDirectMessageErrorDetail(/[가-힣]/.test(detail) ? detail : "");
    setDirectMessageErrorKey(key);
  }
  function setDirectMessageErrorFromCause(cause: unknown, key: TranslationKey) {
    setDirectMessageErrorWithKey(
      key,
      cause instanceof Error ? cause.message : "",
    );
  }
  const [mutatingMessageId, setMutatingMessageId] = useState("");
  const [leavingGroupId, setLeavingGroupId] = useState("");
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([]);
  const [groupInvitations, setGroupInvitations] = useState<GroupInvitation[]>(
    [],
  );
  const [groupInvitationsLoading, setGroupInvitationsLoading] = useState(false);
  const [respondingInvitationId, setRespondingInvitationId] = useState("");
  const [sendingMeetupRequest, setSendingMeetupRequest] = useState(false);
  const [friendsDialogOpen, setFriendsDialogOpen] = useState(false);
  const [friendOverview, setFriendOverview] = useState<FriendOverview | null>(
    null,
  );
  const [friendActionBusy, setFriendActionBusy] = useState(false);
  const friendActionFailure = useLocalizedError();
  const friendActionError = friendActionFailure.message;
  const friendRefreshRef = useRef<() => Promise<void>>(async () => undefined);
  const [inviteGroupConversationId, setInviteGroupConversationId] =
    useState("");
  const [inviteTargetPlayerId, setInviteTargetPlayerId] = useState("");
  const [sendingGroupInvitation, setSendingGroupInvitation] = useState(false);
  const [groupManagementConversationId, setGroupManagementConversationId] =
    useState("");
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [groupMembersLoading, setGroupMembersLoading] = useState(false);
  const [groupManagementBusy, setGroupManagementBusy] = useState(false);
  const groupManagementFailure = useLocalizedError();
  const groupManagementError = groupManagementFailure.message;
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [unread, setUnread] = useState(0);
  const [directNotificationsEnabled, setDirectNotificationsEnabled] =
    useState(false);
  useEffect(() => {
    if (!session.userId || bootstrap.mode !== "sso") {
      setFriendOverview(null);
      return;
    }
    let live = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await listFriends();
        if (live) setFriendOverview(next);
      } catch {
        // A temporary network failure should not erase the last known friend state.
      } finally {
        inFlight = false;
      }
    };
    friendRefreshRef.current = refresh;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [bootstrap.mode, session.userId]);
  const [reportTarget, setReportTarget] = useState<
    | { kind: "MESSAGE"; conversationId: string; messageId: string }
    | { kind: "PLAYER"; playerId: string; playerName: string }
    | null
  >(null);
  const [reportCategory, setReportCategory] =
    useState<ReportCategory>("HARASSMENT");
  const [reportDetails, setReportDetails] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState("");
  const [reportSuccess, setReportSuccess] = useState("");
  const [playerReportNotice, setPlayerReportNotice] = useState("");
  const [moderationAccess, setModerationAccess] = useState(false);
  const [moderationDialogOpen, setModerationDialogOpen] = useState(false);
  const [chatRetentionDialogOpen, setChatRetentionDialogOpen] = useState(false);
  const [productAnalyticsDialogOpen, setProductAnalyticsDialogOpen] =
    useState(false);
  const [moderationStatusFilter, setModerationStatusFilter] =
    useState<ReportStatus>("OPEN");
  const [moderationReports, setModerationReports] = useState<
    ModerationReport[]
  >([]);
  const [moderationLoading, setModerationLoading] = useState(false);
  const [moderationError, setModerationError] = useState("");
  const [moderationNotice, setModerationNotice] = useState("");
  const [moderationBusyReportId, setModerationBusyReportId] = useState("");
  const [moderationNotes, setModerationNotes] = useState<
    Record<string, string>
  >({});
  const [moderationMuteDurations, setModerationMuteDurations] = useState<
    Record<string, number>
  >({});
  const [autoAwayEnabled, setAutoAwayEnabled] = useState(() => {
    try {
      return localStorage.getItem("hufs-town.auto-away") !== "false";
    } catch {
      return true;
    }
  });
  const [worldRenderMode, setWorldRenderMode] = useState<WorldRenderMode>(() =>
    readWorldRenderMode(),
  );
  const autoAwayPolicy = useRef(new AutoAwayPolicy(Date.now()));
  const autoAwayRestoreTimer = useRef<number | undefined>(undefined);
  const lastReadChat = useRef("");
  const lastDirectReadCursor = useRef("");
  const [emotes, setEmotes] = useState(false);
  const [acceptPokes, setAcceptPokes] = useState(
    session.allowPokes ?? connection.getPokesEnabled(),
  );
  const [pokePreferenceBusy, setPokePreferenceBusy] = useState(false);
  const pokePreferenceFailure = useLocalizedError();
  const pokePreferenceError = pokePreferenceFailure.message;
  const [pokeNotice, setPokeNotice] = useState("");
  const eventTitleDefault = t("events.live.defaultTitle");
  const previousEventTitleDefault = useRef(eventTitleDefault);
  const [eventTitleDraft, setEventTitleDraft] = useState(eventTitleDefault);
  useEffect(() => {
    const previousDefault = previousEventTitleDefault.current;
    previousEventTitleDefault.current = eventTitleDefault;
    setEventTitleDraft((current) =>
      keepEditedDraft(current, previousDefault, eventTitleDefault),
    );
  }, [eventTitleDefault]);
  const [eventDescriptionDraft, setEventDescriptionDraft] = useState("");
  const [eventResourceDraft, setEventResourceDraft] = useState("");
  const [eventAttendanceEnabled, setEventAttendanceEnabled] = useState(false);
  const [eventQuestionDraft, setEventQuestionDraft] = useState("");
  const [eventAnswerDrafts, setEventAnswerDrafts] = useState<
    Record<string, string>
  >({});
  const [pollQuestionDraft, setPollQuestionDraft] = useState("");
  const pollAgreeDefault = t("events.engagement.ui.defaultAgree");
  const pollDisagreeDefault = t("events.engagement.ui.defaultDisagree");
  const pollOptionDefaults = [pollAgreeDefault, pollDisagreeDefault];
  const previousPollOptionDefaults = useRef(pollOptionDefaults);
  const [pollOptionsDraft, setPollOptionsDraft] = useState(pollOptionDefaults);
  useEffect(() => {
    const previousDefaults = previousPollOptionDefaults.current;
    const nextDefaults = [pollAgreeDefault, pollDisagreeDefault];
    previousPollOptionDefaults.current = nextDefaults;
    setPollOptionsDraft((current) =>
      localizeUneditedChoices(current, previousDefaults, nextDefaults),
    );
  }, [pollAgreeDefault, pollDisagreeDefault]);
  const [pollModeDraft, setPollModeDraft] = useState<"POLL" | "QUIZ">("POLL");
  const [quizCorrectOptionDraft, setQuizCorrectOptionDraft] = useState(0);
  const [eventHistoryOpen, setEventHistoryOpen] = useState(false);
  const [eventControlsCollapsed, setEventControlsCollapsed] = useState(true);
  const [eventToolsEnabled, setEventToolsEnabled] = useState(() => {
    try {
      return readEventToolsEnabled(globalThis.localStorage);
    } catch {
      return false;
    }
  });
  const [eventHistory, setEventHistory] = useState<EventSummary[]>([]);
  const [eventHistoryLoading, setEventHistoryLoading] = useState(false);
  const [eventHistoryResults, setEventHistoryResults] =
    useState<EventResults>();
  const [search, setSearch] = useState("");
  const [profilePlayerId, setProfilePlayerId] = useState("");
  const [profileRequestFailed, setProfileRequestFailed] = useState(false);
  const [wardrobeOpen, setWardrobeOpen] = useState(false);
  const [wardrobeName, setWardrobeName] = useState(session.name);
  const [wardrobeAvatar, setWardrobeAvatar] = useState(session.avatar);
  const [wardrobeSkin, setWardrobeSkin] = useState(session.skin);
  const [wardrobeClothing, setWardrobeClothing] = useState(session.clothing);
  const [wardrobeHair, setWardrobeHair] = useState(session.hair);
  const [wardrobeCategory, setWardrobeCategory] = useState<
    "clothing" | "hair" | "skin"
  >("clothing");
  const [wardrobeBio, setWardrobeBio] = useState(profileBio);
  const [wardrobeLinks, setWardrobeLinks] = useState<string[]>(profileLinks);
  const [wardrobeBusy, setWardrobeBusy] = useState(false);
  const [wardrobeError, setWardrobeError] = useState("");
  const [nearbyAmbientSound, setNearbyAmbientSound] =
    useState<NearbyAmbientSound>();
  const [ambientEnabled, setAmbientEnabled] = useState(false);
  const [ambientPlaybackError, setAmbientPlaybackError] = useState("");
  const ambientAudioRef = useRef<HTMLAudioElement>(null);
  const ambientSourceRef = useRef("");
  const ambientAttemptRef = useRef(false);
  const [objectInteraction, setObjectInteraction] = useState<MapInteraction>();
  const [activeNpc, setActiveNpc] = useState<{
    title: string;
    portraitUrl?: string;
    lines: string[];
  }>();
  const [npcLine, setNpcLine] = useState(0);
  const [activeBoard, setActiveBoard] = useState<{
    id: string;
    title: string;
    description?: string;
  }>();
  const [roomNoteDialogOpen, setRoomNoteDialogOpen] = useState(false);
  const [boardMode, setBoardMode] = useState<"posts" | "whiteboard">("posts");
  const [boardPosts, setBoardPosts] = useState<SpaceBoardPost[]>([]);
  const [boardDraft, setBoardDraft] = useState("");
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardBusy, setBoardBusy] = useState(false);
  const [boardError, setBoardError] = useState("");
  const [savedBlocks, setSavedBlocks] = useState<BlockedAccount[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const blocksFailure = useLocalizedError();
  const blocksError = blocksFailure.message;
  const [worldAnnouncement, setWorldAnnouncement] = useState("");
  const lastWorldAnnouncement = useRef("");
  useEffect(() => {
    const compactViewport = window.matchMedia("(max-width: 850px)");
    const syncCollapsedState = (event?: MediaQueryListEvent) => {
      setEventControlsCollapsed(event?.matches ?? compactViewport.matches);
    };

    syncCollapsedState();
    compactViewport.addEventListener("change", syncCollapsedState);
    return () =>
      compactViewport.removeEventListener("change", syncCollapsedState);
  }, []);
  const scene = useRef<CampusScene | null>(null);
  const self = state.players.find((p) => p.id === state.selfId);
  const profilePlayer = state.players.find((p) => p.id === profilePlayerId);
  const spaceProfilePlayer = state.spaceParticipants.find(
    (player) => player.playerId === profilePlayerId,
  );
  const profileDetails =
    state.profileDetails?.playerId === profilePlayerId
      ? state.profileDetails
      : null;
  const profileCardPlayer: ProfileCardPlayer | undefined =
    profilePlayer ??
    (spaceProfilePlayer
      ? {
          id: spaceProfilePlayer.playerId,
          name: spaceProfilePlayer.name,
          avatar: spaceProfilePlayer.avatar,
          skin: spaceProfilePlayer.skin,
          clothing: spaceProfilePlayer.clothing,
          hair: spaceProfilePlayer.hair,
          status: spaceProfilePlayer.status,
          bio: profileDetails?.accepted ? profileDetails.bio : undefined,
          links: profileDetails?.accepted ? profileDetails.links : undefined,
          profileLoading:
            online && !profileRequestFailed && profileDetails === null,
          profileError: profileRequestFailed
            ? t("people.profile.error")
            : profileDetails && !profileDetails.accepted
              ? t(profileDetailsErrorKey(profileDetails.code))
              : !online && profileDetails === null
                ? t("people.profile.error.reconnect")
                : undefined,
        }
      : undefined);
  const currentMap = state.map ?? bootstrap.map;
  const openParticipantProfile = (playerId: string) => {
    setProfilePlayerId(playerId);
    setProfileRequestFailed(false);
    friendActionFailure.clear();
  };
  const performFriendAction = async (targetUserId: string) => {
    if (friendActionBusy) return;
    const relationship = friendRelationship(friendOverview, targetUserId);
    setFriendActionBusy(true);
    friendActionFailure.clear();
    try {
      if (relationship.state === "INCOMING") {
        await respondToFriendRequest(relationship.requestId, "ACCEPT");
      } else if (relationship.state === "NONE") {
        await createFriendRequest(targetUserId);
      } else {
        return;
      }
      await friendRefreshRef.current();
      setProfilePlayerId("");
      setFriendsDialogOpen(true);
    } catch (cause) {
      friendActionFailure.setFailure(cause, "friends.error.generic");
    } finally {
      setFriendActionBusy(false);
    }
  };
  const otherSpaceParticipants = state.spaceParticipants.filter(
    (participant) =>
      participant.playerId !== state.selfId &&
      !state.players.some((player) => player.id === participant.playerId) &&
      participant.name.toLowerCase().includes(search.toLowerCase()),
  );
  const profileRequestTargetId =
    profilePlayerId && !profilePlayer && spaceProfilePlayer
      ? profilePlayerId
      : "";
  useEffect(() => {
    const audio = ambientAudioRef.current;
    if (!audio) return;
    if (!nearbyAmbientSound || !ambientEnabled) {
      audio.pause();
      if (!nearbyAmbientSound) {
        audio.removeAttribute("src");
        ambientSourceRef.current = "";
        setAmbientPlaybackError("");
      }
      return;
    }
    if (ambientSourceRef.current !== nearbyAmbientSound.url) {
      ambientSourceRef.current = nearbyAmbientSound.url;
      audio.src = nearbyAmbientSound.url;
      audio.load();
      if (ambientPlaybackError) setAmbientPlaybackError("");
    }
    audio.volume = Math.max(0, Math.min(1, nearbyAmbientSound.volume));
    if (audio.paused && !ambientPlaybackError && !ambientAttemptRef.current) {
      ambientAttemptRef.current = true;
      void audio
        .play()
        .then(() => setAmbientPlaybackError(""))
        .catch(() =>
          setAmbientPlaybackError(t("campus.ambient.error.autoplay")),
        )
        .finally(() => {
          ambientAttemptRef.current = false;
        });
    }
  }, [
    nearbyAmbientSound?.url,
    nearbyAmbientSound?.volume,
    ambientEnabled,
    ambientPlaybackError,
    t,
  ]);
  useEffect(() => () => ambientAudioRef.current?.pause(), []);
  function startAmbientSound() {
    const audio = ambientAudioRef.current;
    if (!nearbyAmbientSound || !audio) {
      setAmbientEnabled(true);
      return;
    }
    if (ambientSourceRef.current !== nearbyAmbientSound.url) {
      ambientSourceRef.current = nearbyAmbientSound.url;
      audio.src = nearbyAmbientSound.url;
      audio.load();
    }
    audio.volume = Math.max(0, Math.min(1, nearbyAmbientSound.volume));
    setAmbientEnabled(true);
    setAmbientPlaybackError("");
    if (!ambientAttemptRef.current) {
      ambientAttemptRef.current = true;
      void audio
        .play()
        .catch(() => setAmbientPlaybackError(t("campus.ambient.error.file")))
        .finally(() => {
          ambientAttemptRef.current = false;
        });
    }
  }
  function toggleAmbientSound() {
    if (ambientEnabled && !ambientPlaybackError) {
      ambientAudioRef.current?.pause();
      setAmbientEnabled(false);
      setAmbientPlaybackError("");
      return;
    }
    startAmbientSound();
  }
  const interactionImageUrl =
    objectInteraction?.kind === "IMAGE" &&
    objectInteraction.assetId &&
    /^custom_[0-9a-fA-F-]{36}$/.test(objectInteraction.assetId)
      ? `/api/v1/spaces/${encodeURIComponent(bootstrap.space.id)}/assets/${encodeURIComponent(objectInteraction.assetId)}/content`
      : undefined;
  const zone = currentMap.zones.find((z) => z.id === self?.zoneId);
  const currentRoom = state.rooms.find((room) => room.zoneId === self?.zoneId);
  const placeName =
    currentRoom?.name ?? zone?.name ?? t("campus.place.commonFallback");
  useEffect(() => {
    if (zone?.kind !== "PRIVATE" || !currentRoom) setRoomNoteDialogOpen(false);
  }, [currentRoom, zone?.kind]);
  useEffect(() => {
    if (!activeBoard) {
      setBoardPosts([]);
      setBoardDraft("");
      setBoardError("");
      setBoardLoading(false);
      return;
    }
    let live = true,
      firstLoad = true,
      refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      if (firstLoad) setBoardLoading(true);
      try {
        const posts = await listSpaceBoardPosts(
          bootstrap.space.id,
          activeBoard.id,
        );
        if (live) {
          setBoardPosts(posts);
          setBoardError("");
        }
      } catch (error) {
        if (
          error instanceof AuthError &&
          [401, 403, 404].includes(error.status)
        ) {
          if (live) {
            setBoardPosts([]);
            setActiveBoard(undefined);
          }
          return;
        }
        if (live) setBoardError(t("board.error.load"));
      } finally {
        refreshing = false;
        if (firstLoad) {
          firstLoad = false;
          if (live) setBoardLoading(false);
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [bootstrap.space.id, activeBoard?.id, t]);
  useEffect(() => {
    if (!self) return;
    const next = t("campus.world.locationAnnouncement", {
      map: currentMap.name,
      place: placeName,
    });
    if (lastWorldAnnouncement.current !== next) {
      lastWorldAnnouncement.current = next;
      setWorldAnnouncement(next);
    }
  }, [currentMap.name, placeName, self, t]);
  function openWardrobe() {
    setWardrobeName(session.name);
    setWardrobeAvatar(session.avatar);
    setWardrobeSkin(session.skin);
    setWardrobeClothing(session.clothing);
    setWardrobeHair(session.hair);
    setWardrobeBio(profileBio);
    setWardrobeLinks([...profileLinks]);
    setWardrobeError("");
    setWardrobeOpen(true);
  }
  function randomizeWardrobe() {
    const pick = <T,>(values: readonly T[]) =>
      values[Math.floor(Math.random() * values.length)];
    setWardrobeAvatar(
      Math.floor(Math.random() * AVATAR_CATALOG.bodyShapes.length),
    );
    setWardrobeSkin(pick(AVATAR_CATALOG.skinTones));
    setWardrobeClothing(pick(AVATAR_CATALOG.clothing));
    setWardrobeHair(pick(AVATAR_CATALOG.hair));
  }
  async function saveWardrobe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (wardrobeBusy) return;
    const name = wardrobeName.trim();
    const bio = wardrobeBio.trim();
    const links = wardrobeLinks.map((link) => link.trim()).filter(Boolean);
    if (!name || name.length > 20 || /[\x00-\x1f\x7f]|\p{Cf}/u.test(name)) {
      setWardrobeError(t("wardrobe.error.name"));
      return;
    }
    if (Array.from(bio).length > 280 || /[\x00-\x1f\x7f]|\p{Cf}/u.test(bio)) {
      setWardrobeError(t("wardrobe.error.bio"));
      return;
    }
    if (
      links.length > 3 ||
      links.some(
        (link) => link.length > 512 || !/^https?:\/\/[^\s]+$/i.test(link),
      )
    ) {
      setWardrobeError(t("wardrobe.error.links"));
      return;
    }
    setWardrobeBusy(true);
    setWardrobeError("");
    try {
      const saved = await onSaveProfile({
        name,
        avatar: wardrobeAvatar,
        skin: wardrobeSkin,
        clothing: wardrobeClothing,
        hair: wardrobeHair,
        bio,
        links,
      });
      connection.updateProfile(
        saved.name,
        saved.avatar,
        saved,
        saved.bio,
        saved.links,
      );
      setWardrobeOpen(false);
    } catch {
      setWardrobeError(t("wardrobe.error.save"));
    } finally {
      setWardrobeBusy(false);
    }
  }
  function handleObjectInteraction(
    interaction: MapInteraction,
    objectId: string,
  ) {
    if (interaction.kind === "SOUND") {
      startAmbientSound();
      return;
    }
    if (interaction.kind === "NPC") {
      if (
        state.worldFeatures.includes("SCAVENGER_HUNT") &&
        state.engagement?.scavengerActive
      ) {
        setEventControlsCollapsed(false);
        connection.eventEngagement("SCAVENGER_TALK", objectId);
      }
      const object = currentMap.objects.find((item) => item.id === objectId),
        asset = object ? ASSETS_BY_ID.get(object.asset) : undefined,
        lines = (interaction.body ?? t("campus.npc.defaultGreeting"))
          .replace(/\r/g, "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
      setNpcLine(0);
      setActiveNpc({
        title: interaction.title,
        portraitUrl: asset?.url,
        lines: lines.length ? lines : [t("campus.npc.defaultGreeting")],
      });
      return;
    }
    if (interaction.kind === "SCAVENGER_ITEM") {
      if (
        state.worldFeatures.includes("SCAVENGER_HUNT") &&
        state.engagement?.scavengerActive
      ) {
        setEventControlsCollapsed(false);
        connection.eventEngagement("COLLECT_SCAVENGER_ITEM", objectId);
      } else {
        setObjectInteraction(interaction);
      }
      return;
    }
    if (interaction.kind === "BOARD") {
      setBoardMode("posts");
      setActiveBoard({
        id: objectId,
        title: interaction.title,
        description: interaction.body,
      });
      return;
    }
    if (interaction.kind === "NOTICE" || interaction.kind === "IMAGE") {
      setObjectInteraction(interaction);
      return;
    }
    if (interaction.url && /^https?:\/\/[^\s]+$/i.test(interaction.url))
      window.open(interaction.url, "_blank", "noopener,noreferrer");
  }
  async function submitBoardPost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeBoard || boardBusy || !boardDraft.trim()) return;
    setBoardBusy(true);
    setBoardError("");
    try {
      const post = await createSpaceBoardPost(
        bootstrap.space.id,
        activeBoard.id,
        boardDraft,
      );
      setBoardPosts((current) => [...current, post].slice(-50));
      setBoardDraft("");
    } catch (error) {
      if (
        error instanceof AuthError &&
        [401, 403, 404].includes(error.status)
      ) {
        setBoardPosts([]);
        setActiveBoard(undefined);
        return;
      }
      setBoardError(t("board.error.create"));
    } finally {
      setBoardBusy(false);
    }
  }
  async function removeBoardPost(post: SpaceBoardPost) {
    if (!activeBoard || boardBusy || !post.deletable) return;
    setBoardBusy(true);
    setBoardError("");
    try {
      await deleteSpaceBoardPost(bootstrap.space.id, activeBoard.id, post.id);
      setBoardPosts((current) => current.filter((item) => item.id !== post.id));
    } catch (error) {
      if (
        error instanceof AuthError &&
        [401, 403, 404].includes(error.status)
      ) {
        setBoardPosts([]);
        setActiveBoard(undefined);
        return;
      }
      setBoardError(t("board.error.delete"));
    } finally {
      setBoardBusy(false);
    }
  }
  useEffect(() => {
    if (profilePlayerId && !profilePlayer && !spaceProfilePlayer)
      setProfilePlayerId("");
  }, [profilePlayer, profilePlayerId, spaceProfilePlayer]);
  const isRoomHost = Boolean(
    currentRoom && currentRoom.hostPlayerId === state.selfId,
  );
  const event = state.event;
  const engagement = state.engagement;
  useEffect(() => {
    setEventControlsCollapsed(!event?.active || !eventToolsEnabled);
  }, [event?.active, eventToolsEnabled]);
  const isEventManager = Boolean(self?.eventManager);
  const isEventSpeaker = Boolean(
    event?.active && event.speakerPlayerIds.includes(state.selfId),
  );
  async function exportEventAttendance(eventId = event?.eventId) {
    if (!eventId) return;
    try {
      await downloadEventAttendance(bootstrap.space.id, eventId);
      setPokeNotice(t("events.history.exportSuccess"));
      window.setTimeout(() => setPokeNotice(""), 2600);
    } catch {
      setPokeNotice(t("events.history.exportError"));
      window.setTimeout(() => setPokeNotice(""), 3200);
    }
  }
  async function toggleEventHistory() {
    if (!isEventManager) return;
    if (eventHistoryOpen) {
      setEventHistoryOpen(false);
      setEventHistoryResults(undefined);
      return;
    }
    setEventHistoryLoading(true);
    try {
      setEventHistory(await listEventHistory(bootstrap.space.id));
      setEventHistoryOpen(true);
    } catch {
      setPokeNotice(t("events.history.loadError"));
      window.setTimeout(() => setPokeNotice(""), 3200);
    } finally {
      setEventHistoryLoading(false);
    }
  }
  async function openEventResults(eventId: string) {
    try {
      setEventHistoryResults(
        await getEventResults(bootstrap.space.id, eventId),
      );
    } catch {
      setPokeNotice(t("events.history.resultsError"));
      window.setTimeout(() => setPokeNotice(""), 3200);
    }
  }
  const canPoke = (target: (typeof state.players)[number]) => {
    if (
      !self ||
      target.id === self.id ||
      self.status !== "AVAILABLE" ||
      target.status !== "AVAILABLE" ||
      state.blockedPlayerIds.includes(target.id) ||
      Math.hypot(target.x - self.x, target.y - self.y) > 3
    )
      return false;
    const targetZone = currentMap.zones.find(
      (item) => item.id === target.zoneId,
    );
    return (
      !(zone?.kind === "PRIVATE" || targetZone?.kind === "PRIVATE") ||
      target.zoneId === self.zoneId
    );
  };
  const canRequestJoin = (target: (typeof state.players)[number]) => {
    if (
      !self ||
      target.id === self.id ||
      self.status !== "AVAILABLE" ||
      target.status !== "AVAILABLE" ||
      state.blockedPlayerIds.includes(target.id)
    )
      return false;
    const targetZone = currentMap.zones.find(
      (item) => item.id === target.zoneId,
    );
    return !(targetZone?.kind === "PRIVATE" && target.zoneId !== self.zoneId);
  };
  const scopedChatChannel =
    zone?.kind === "PRIVATE" ? "room" : spaceChatPreferred ? "space" : "nearby";
  const chatChannel =
    chatMode === "dm" && activeDirectConversationId ? "dm" : scopedChatChannel;
  const activeHistoryKey = chatHistoryKey(
    chatChannel,
    self?.zoneId ?? "",
    activeDirectConversationId,
  );
  const lastDirectMessageId =
    [...state.chatMessages].reverse().find((item) => item.channel === "dm")
      ?.messageId ?? "";
  function setManualPresence(status: "AVAILABLE" | "AWAY" | "DND") {
    const wasAutoAway = autoAwayPolicy.current.manualChange(Date.now());
    if (autoAwayRestoreTimer.current !== undefined) {
      window.clearTimeout(autoAwayRestoreTimer.current);
      autoAwayRestoreTimer.current = undefined;
    }
    if (wasAutoAway)
      window.setTimeout(
        () => connection.setPresence(status),
        AUTO_AWAY_RESTORE_DELAY_MS,
      );
    else connection.setPresence(status);
  }
  function toggleAutoAway(enabled: boolean) {
    setAutoAwayEnabled(enabled);
    try {
      localStorage.setItem("hufs-town.auto-away", String(enabled));
    } catch {
      /* The in-memory setting still applies. */
    }
    if (!enabled && autoAwayPolicy.current.hasAutomaticAwayRequest)
      setManualPresence("AVAILABLE");
  }
  function toggleEventTools(enabled: boolean) {
    setEventToolsEnabled(enabled);
    if (!enabled) setEventControlsCollapsed(true);
    try {
      writeEventToolsEnabled(enabled, globalThis.localStorage);
    } catch {
      /* The in-memory setting still applies. */
    }
  }
  function updateWorldRenderMode(mode: WorldRenderMode) {
    setWorldRenderMode(mode);
    writeWorldRenderMode(mode);
  }
  useEffect(() => {
    if (!autoAwayEnabled || state.status !== "online") return;
    autoAwayPolicy.current.startMonitoring(Date.now());

    const playerStatus = () => {
      const snapshot = connection.getSnapshot();
      return snapshot.players.find((player) => player.id === snapshot.selfId)
        ?.status;
    };
    const restoreAutomatically = () => {
      const now = Date.now();
      if (
        autoAwayRestoreTimer.current !== undefined ||
        !autoAwayPolicy.current.canRestore(playerStatus(), now)
      )
        return;
      autoAwayRestoreTimer.current = window.setTimeout(() => {
        autoAwayRestoreTimer.current = undefined;
        autoAwayPolicy.current.restore(playerStatus(), Date.now(), (status) =>
          connection.setPresence(status),
        );
      }, autoAwayPolicy.current.restoreDelayRemaining(now));
    };
    const activity = () => {
      autoAwayPolicy.current.recordActivity(Date.now());
      restoreAutomatically();
    };
    const timer = window.setInterval(() => {
      const status = playerStatus();
      const now = Date.now();
      if (
        autoAwayPolicy.current.tick(status, now, (nextStatus) =>
          connection.setPresence(nextStatus),
        ) === "restore"
      )
        restoreAutomatically();
    }, AUTO_AWAY_CHECK_INTERVAL_MS);
    window.addEventListener("pointerdown", activity, { passive: true });
    window.addEventListener("pointermove", activity, { passive: true });
    window.addEventListener("keydown", activity);
    window.addEventListener("wheel", activity, { passive: true });
    window.addEventListener("touchstart", activity, { passive: true });
    window.addEventListener("focus", activity);
    document.addEventListener("visibilitychange", activity);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("pointermove", activity);
      window.removeEventListener("keydown", activity);
      window.removeEventListener("wheel", activity);
      window.removeEventListener("touchstart", activity);
      window.removeEventListener("focus", activity);
      document.removeEventListener("visibilitychange", activity);
      if (autoAwayRestoreTimer.current !== undefined) {
        window.clearTimeout(autoAwayRestoreTimer.current);
        autoAwayRestoreTimer.current = undefined;
      }
    };
  }, [autoAwayEnabled, connection, state.status]);
  async function refreshDirectConversations() {
    if (!session.userId) return;
    try {
      setDirectConversations(await listDirectConversations());
    } catch (error) {
      setDirectMessageErrorFromCause(error, "chat.error.dmLoad");
    }
  }
  useEffect(() => {
    if (!session.userId) {
      setModerationAccess(false);
      return;
    }
    let active = true;
    getReportAccess()
      .then((access) => {
        if (active) setModerationAccess(access.administrator);
      })
      .catch(() => {
        if (active) setModerationAccess(false);
      });
    return () => {
      active = false;
    };
  }, [session.userId]);
  useEffect(() => {
    if (!moderationDialogOpen || !moderationAccess) return;
    let active = true;
    setModerationLoading(true);
    setModerationError("");
    setModerationNotice("");
    listModerationReports(moderationStatusFilter)
      .then((items) => {
        if (active) setModerationReports(items);
      })
      .catch((error) => {
        if (active)
          setModerationError(
            language === "ko" && error instanceof Error
              ? error.message
              : t("moderation.error.generic"),
          );
      })
      .finally(() => {
        if (active) setModerationLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    moderationDialogOpen,
    moderationAccess,
    moderationStatusFilter,
    language,
  ]);
  async function submitMessageReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reportTarget || reportBusy) return;
    const target = reportTarget;
    setReportBusy(true);
    setReportError("");
    try {
      if (target.kind === "MESSAGE") {
        await reportDirectMessage(
          target.messageId,
          reportCategory,
          reportDetails,
        );
        setReportSuccess(t("report.success"));
        window.setTimeout(() => setReportSuccess(""), 5000);
      } else {
        const result = await connection.reportPlayer(
          target.playerId,
          reportCategory,
          reportDetails,
        );
        if (!result.accepted) throw new Error(result.message);
        setPlayerReportNotice(t("report.success"));
        window.setTimeout(() => setPlayerReportNotice(""), 5000);
      }
      setReportTarget(null);
      setReportDetails("");
    } catch (error) {
      setReportError(
        language === "ko" && error instanceof Error
          ? error.message
          : t("report.error.generic"),
      );
    } finally {
      setReportBusy(false);
    }
  }
  async function updateModerationReport(
    report: ModerationReport,
    status: ReportStatus,
  ) {
    if (moderationBusyReportId) return;
    setModerationBusyReportId(report.reportId);
    setModerationError("");
    setModerationNotice("");
    try {
      const updated = await reviewModerationReport(
        report.reportId,
        status,
        moderationNotes[report.reportId] ?? "",
      );
      setModerationReports((items) =>
        updated.status === moderationStatusFilter
          ? items.map((item) =>
              item.reportId === updated.reportId ? updated : item,
            )
          : items.filter((item) => item.reportId !== updated.reportId),
      );
      setModerationNotes((notes) => ({ ...notes, [report.reportId]: "" }));
      setModerationNotice(t("moderation.notice.saved"));
    } catch (error) {
      setModerationError(
        language === "ko" && error instanceof Error
          ? error.message
          : t("moderation.error.generic"),
      );
    } finally {
      setModerationBusyReportId("");
    }
  }
  async function applyChatMute(report: ModerationReport) {
    if (moderationBusyReportId) return;
    setModerationBusyReportId(report.reportId);
    setModerationError("");
    setModerationNotice("");
    try {
      const result = await muteReportedUser(
        report.reportId,
        createUuid(),
        moderationMuteDurations[report.reportId] ?? 60,
        moderationNotes[report.reportId] ?? "",
      );
      const updated = result.report;
      setModerationReports((items) =>
        updated.status === moderationStatusFilter
          ? items.map((item) =>
              item.reportId === updated.reportId ? updated : item,
            )
          : items.filter((item) => item.reportId !== updated.reportId),
      );
      setModerationNotes((notes) => ({ ...notes, [report.reportId]: "" }));
      setModerationNotice(
        t("moderation.notice.chatMute", {
          name: report.targetName,
          until: formatDate(language, result.mutedUntil, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        }),
      );
    } catch (error) {
      setModerationError(
        language === "ko" && error instanceof Error
          ? error.message
          : t("moderation.error.generic"),
      );
    } finally {
      setModerationBusyReportId("");
    }
  }
  async function applyMediaMute(report: ModerationReport) {
    if (moderationBusyReportId) return;
    setModerationBusyReportId(report.reportId);
    setModerationError("");
    setModerationNotice("");
    const durationMinutes = moderationMuteDurations[report.reportId] ?? 60;
    try {
      const result = await muteReportedMedia(
        report.reportId,
        createUuid(),
        durationMinutes,
        moderationNotes[report.reportId] ?? "",
      );
      const updated = result.report;
      setModerationReports((items) =>
        updated.status === moderationStatusFilter
          ? items.map((item) =>
              item.reportId === updated.reportId ? updated : item,
            )
          : items.filter((item) => item.reportId !== updated.reportId),
      );
      setModerationNotes((notes) => ({ ...notes, [report.reportId]: "" }));
      setModerationNotice(
        t("moderation.notice.mediaMute", {
          name: report.targetName,
          until: formatDate(language, result.effectiveUntil, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        }),
      );
    } catch (error) {
      setModerationError(
        language === "ko" && error instanceof Error
          ? error.message
          : t("moderation.error.generic"),
      );
    } finally {
      setModerationBusyReportId("");
    }
  }
  async function kickReportedAccount(report: ModerationReport) {
    if (
      moderationBusyReportId ||
      !(await confirm(
        t("moderation.confirm.kick", { name: report.targetName }),
      ))
    )
      return;
    setModerationBusyReportId(report.reportId);
    setModerationError("");
    setModerationNotice("");
    try {
      const result = await kickReportedUser(
        report.reportId,
        createUuid(),
        moderationNotes[report.reportId] ?? "",
      );
      const updated = result.report;
      setModerationReports((items) =>
        updated.status === moderationStatusFilter
          ? items.map((item) =>
              item.reportId === updated.reportId ? updated : item,
            )
          : items.filter((item) => item.reportId !== updated.reportId),
      );
      setModerationNotes((notes) => ({ ...notes, [report.reportId]: "" }));
      setModerationNotice(
        t("moderation.notice.kick", {
          name: report.targetName,
          until: formatDate(language, result.effectiveUntil, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        }),
      );
    } catch (error) {
      setModerationError(
        language === "ko" && error instanceof Error
          ? error.message
          : t("moderation.error.generic"),
      );
    } finally {
      setModerationBusyReportId("");
    }
  }
  useEffect(() => {
    if (!session.userId) return;
    let active = true;
    syncDirectMessagePush()
      .then((enabled) => {
        if (active) setDirectNotificationsEnabled(enabled);
      })
      .catch(() => {
        if (active) setDirectNotificationsEnabled(false);
      });
    return () => {
      active = false;
    };
  }, [session.userId]);
  useEffect(() => {
    const openConversation = (value: unknown) => {
      if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) return;
      setPanel("chat");
      setChatMode("dm");
      setActiveDirectConversationId(value);
    };
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("dm");
    const requestedFriends = params.get("friends") === "1";
    if (requested) {
      openConversation(requested);
    }
    if (requestedFriends) setFriendsDialogOpen(true);
    if (requested || requestedFriends) {
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.hash}`,
      );
    }
    const onWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === "open-direct-conversation")
        openConversation(event.data.conversationId);
      if (event.data?.type === "open-friends") setFriendsDialogOpen(true);
      if (event.data?.type === "incoming-direct-message")
        void refreshDirectConversations();
      if (event.data?.type === "incoming-friend-request") {
        void friendRefreshRef.current();
        setFriendsDialogOpen(true);
      }
      if (event.data?.type === "friend-request-accepted")
        void friendRefreshRef.current();
    };
    navigator.serviceWorker?.addEventListener("message", onWorkerMessage);
    return () =>
      navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
  }, [session.userId]);
  async function toggleDirectNotifications() {
    if (directNotificationsEnabled) {
      try {
        await disableDirectMessagePush();
        setDirectNotificationsEnabled(false);
        setDirectMessageError("");
      } catch (error) {
        setDirectNotificationsEnabled(false);
        setDirectMessageErrorFromCause(error, "chat.error.notificationUpdate");
      }
      return;
    }
    if (!pushSupported()) {
      setDirectMessageErrorWithKey("chat.error.notificationUnsupported");
      return;
    }
    try {
      await enableDirectMessagePush();
      setDirectMessageError("");
      setDirectNotificationsEnabled(true);
    } catch (error) {
      setDirectMessageErrorFromCause(error, "chat.error.notificationUpdate");
    }
  }
  async function refreshGroupInvitations() {
    if (!session.userId) return;
    setGroupInvitationsLoading(true);
    try {
      setGroupInvitations(await listGroupInvitations());
    } catch (error) {
      setDirectMessageErrorFromCause(error, "group.error.invitationLoad");
    } finally {
      setGroupInvitationsLoading(false);
    }
  }
  async function respondToInvitation(
    invitation: GroupInvitation,
    accepted: boolean,
  ) {
    if (!session.userId || respondingInvitationId) return;
    setRespondingInvitationId(invitation.invitationId);
    setDirectMessageError("");
    try {
      const result = await respondToGroupInvitation(
        invitation.invitationId,
        accepted,
      );
      setGroupInvitations((items) =>
        items.filter((item) => item.invitationId !== invitation.invitationId),
      );
      if (result.accepted) {
        setActiveDirectConversationId(result.conversationId);
        setChatMode("dm");
        setPanel("chat");
        await refreshDirectConversations();
      }
    } catch (error) {
      setDirectMessageErrorFromCause(error, "group.error.invitationRespond");
      void refreshGroupInvitations();
    } finally {
      setRespondingInvitationId("");
    }
  }
  async function leaveGroupConversationFromCampus(conversationId: string) {
    const conversation = directConversations.find(
      (item) => item.conversationId === conversationId,
    );
    if (!session.userId || conversation?.kind !== "GROUP" || leavingGroupId)
      return;
    if (
      !(await confirm(
        t("group.leave.confirm", { name: conversation.displayName }),
      ))
    )
      return;
    setLeavingGroupId(conversationId);
    setDirectMessageError("");
    try {
      await leaveGroupConversation(conversationId);
      setActiveDirectConversationId("");
      await refreshDirectConversations();
    } catch (error) {
      setDirectMessageErrorFromCause(error, "group.error.leave");
    } finally {
      setLeavingGroupId("");
    }
  }
  async function openGroupManagement(conversationId: string) {
    const conversation = directConversations.find(
      (item) => item.conversationId === conversationId,
    );
    if (conversation?.kind !== "GROUP") return;
    setGroupManagementConversationId(conversationId);
    setGroupNameDraft(conversation.displayName);
    groupManagementFailure.clear();
    setGroupMembersLoading(true);
    try {
      setGroupMembers(await listGroupMembers(conversationId));
    } catch (error) {
      groupManagementFailure.setFailure(error, "group.members.loadError");
      setGroupMembers([]);
    } finally {
      setGroupMembersLoading(false);
    }
  }
  async function saveGroupName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const conversationId = groupManagementConversationId;
    if (!conversationId || groupManagementBusy || !groupNameDraft.trim())
      return;
    setGroupManagementBusy(true);
    groupManagementFailure.clear();
    try {
      const result = await renameGroupConversation(
        conversationId,
        groupNameDraft.trim(),
      );
      setGroupNameDraft(result.name);
      setDirectConversations((items) =>
        items.map((item) =>
          item.conversationId === conversationId
            ? { ...item, displayName: result.name }
            : item,
        ),
      );
    } catch (error) {
      groupManagementFailure.setFailure(error, "group.members.renameError");
    } finally {
      setGroupManagementBusy(false);
    }
  }
  async function kickGroupMember(member: GroupMember) {
    const conversationId = groupManagementConversationId;
    if (
      !conversationId ||
      !directConversations.find(
        (item) => item.conversationId === conversationId,
      )?.owner ||
      member.owner ||
      member.self ||
      groupManagementBusy
    )
      return;
    if (
      !(await confirm(
        t("group.members.removeConfirm", { name: member.displayName }),
      ))
    )
      return;
    setGroupManagementBusy(true);
    groupManagementFailure.clear();
    try {
      await removeGroupMember(conversationId, member.memberId);
      setGroupMembers(await listGroupMembers(conversationId));
      await refreshDirectConversations();
    } catch (error) {
      groupManagementFailure.setFailure(error, "group.members.removeError");
      try {
        setGroupMembers(await listGroupMembers(conversationId));
      } catch {
        /* Keep the current list and show the original error. */
      }
    } finally {
      setGroupManagementBusy(false);
    }
  }
  function requestDirectMessage(targetPlayerId: string) {
    setDirectMessageError("");
    if (!connection.requestDirectConversation(targetPlayerId))
      setDirectMessageErrorWithKey("chat.compose.offline");
  }
  async function requestMeetupFromConversation(conversationId: string) {
    const conversation = directConversations.find(
      (item) => item.conversationId === conversationId,
    );
    if (
      !session.userId ||
      conversation?.kind !== "DIRECT" ||
      sendingMeetupRequest
    )
      return;
    setSendingMeetupRequest(true);
    setDirectMessageError("");
    try {
      await createSocialJoinRequest(
        conversation.conversationId,
        bootstrap.space.id,
      );
      setPokeNotice(t("chat.meetup.sent"));
      window.setTimeout(() => setPokeNotice(""), 4200);
    } catch (error) {
      setDirectMessageErrorFromCause(error, "chat.error.meetupCreate");
    } finally {
      setSendingMeetupRequest(false);
    }
  }
  function mutateDirectMessage(
    conversationId: string,
    messageId: string,
    action: "EDIT" | "DELETE",
    text: string,
  ) {
    if (mutatingMessageId) return false;
    setDirectMessageError("");
    setMutatingMessageId(messageId);
    const sent = connection.mutateDirectMessage(
      conversationId,
      messageId,
      action,
      text,
    );
    if (!sent) {
      setMutatingMessageId("");
      setDirectMessageErrorWithKey("chat.compose.offline");
    }
    return sent;
  }
  function submitGroupConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (groupMemberIds.length < 2 || groupMemberIds.length > 11) return;
    setDirectMessageError("");
    if (!connection.requestGroupConversation(groupMemberIds, groupName)) {
      setDirectMessageErrorWithKey("chat.compose.offline");
      return;
    }
    setGroupDialogOpen(false);
  }
  function submitGroupInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !inviteGroupConversationId ||
      !inviteTargetPlayerId ||
      sendingGroupInvitation
    )
      return;
    setDirectMessageError("");
    setSendingGroupInvitation(true);
    if (
      !connection.requestGroupInvitation(
        inviteGroupConversationId,
        inviteTargetPlayerId,
      )
    ) {
      setSendingGroupInvitation(false);
      setDirectMessageErrorWithKey("chat.compose.offline");
    }
  }
  useEffect(() => {
    if (panel !== "people" || !session.userId) {
      setSavedBlocks([]);
      setBlocksLoading(false);
      blocksFailure.clear();
      return;
    }
    let active = true;
    setBlocksLoading(true);
    blocksFailure.clear();
    listBlockedAccounts()
      .then((items) => {
        if (active) setSavedBlocks(items);
      })
      .catch((error) => {
        if (active) blocksFailure.setFailure(error, "people.blocks.loadError");
      })
      .finally(() => {
        if (active) setBlocksLoading(false);
      });
    return () => {
      active = false;
    };
  }, [panel, session.userId, state.lastBlockAck?.requestId]);
  useEffect(() => {
    if (panel === "people" && session.userId && state.status === "online")
      void refreshGroupInvitations();
  }, [
    panel,
    session.userId,
    state.status,
    state.lastGroupInvitationEvent?.invitationId,
  ]);
  useEffect(() => {
    const invitation = state.lastGroupInvitationEvent;
    if (!invitation) return;
    setPokeNotice(
      t("group.invite.received", {
        inviter: invitation.inviterName,
        group: invitation.groupName,
      }),
    );
    const timer = setTimeout(() => setPokeNotice(""), 4200);
    return () => clearTimeout(timer);
  }, [state.lastGroupInvitationEvent]);
  useEffect(() => {
    const ack = state.lastGroupInvitationAck;
    if (!ack) return;
    setSendingGroupInvitation(false);
    if (ack.accepted) {
      setInviteGroupConversationId("");
      setPokeNotice(t("group.invite.sent"));
      setTimeout(() => setPokeNotice(""), 2600);
    } else
      setDirectMessageErrorWithKey(worldMessageErrorKey(ack.code), ack.message);
  }, [state.lastGroupInvitationAck]);
  useEffect(() => {
    const ack = state.lastDirectMessageMutationAck;
    if (!ack) return;
    setMutatingMessageId((current) =>
      current === ack.messageId ? "" : current,
    );
    if (ack.accepted) {
      setDirectMessageError("");
      void refreshDirectConversations();
    } else
      setDirectMessageErrorWithKey(worldMessageErrorKey(ack.code), ack.message);
  }, [state.lastDirectMessageMutationAck]);
  useEffect(() => {
    const expiresAt = groupInvitations.length
      ? Math.min(...groupInvitations.map((invitation) => invitation.expiresAt))
      : 0;
    if (!expiresAt) return;
    const timer = setTimeout(
      () => void refreshGroupInvitations(),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [groupInvitations]);
  async function unblockSavedAccount(block: BlockedAccount) {
    blocksFailure.clear();
    try {
      await removeBlockedAccount(block.id);
      setSavedBlocks((items) => items.filter((item) => item.id !== block.id));
    } catch (error) {
      blocksFailure.setFailure(error, "people.blocks.unblockError");
    }
  }
  async function updatePokePreference(enabled: boolean) {
    const previous = acceptPokes;
    setAcceptPokes(enabled);
    connection.setPokesEnabled(enabled);
    pokePreferenceFailure.clear();
    if (!session.userId) return;
    setPokePreferenceBusy(true);
    try {
      const account = await savePokePreference(enabled);
      setAcceptPokes(account.allowPokes);
      connection.setPokesEnabled(account.allowPokes);
    } catch (error) {
      setAcceptPokes(previous);
      connection.setPokesEnabled(previous);
      pokePreferenceFailure.setFailure(
        error,
        "people.pokePreference.saveError",
      );
    } finally {
      setPokePreferenceBusy(false);
    }
  }
  useEffect(() => {
    const event = state.lastPokeEvent;
    if (!event) return;
    setPokeNotice(t("campus.poke.received", { name: event.senderName }));
    const timer = setTimeout(() => setPokeNotice(""), 2600);
    return () => clearTimeout(timer);
  }, [state.lastPokeEvent]);
  useEffect(() => {
    const ack = state.lastPokeAck;
    if (!ack) return;
    setPokeNotice(
      worldAckMessage(ack, language, t, participantName(ack.targetId)),
    );
    const timer = setTimeout(() => setPokeNotice(""), 4200);
    return () => clearTimeout(timer);
  }, [state.lastPokeAck, language, t]);
  useEffect(() => {
    if (state.pokePreferenceState)
      setAcceptPokes(state.pokePreferenceState.enabled);
  }, [state.pokePreferenceState]);
  useEffect(() => {
    if (!state.joinRequests.length) return;
    const expiresAt = Math.min(
      ...state.joinRequests.map((request) => request.expiresAt),
    );
    const timer = setTimeout(
      () => connection.expireJoinRequests(),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [connection, state.joinRequests]);
  useEffect(() => {
    const lines = state.chatMessages;
    const latest = lines.at(-1)?.clientMessageId ?? lastReadChat.current;
    const lastIndex = lastReadChat.current
      ? lines.findIndex((line) => line.clientMessageId === lastReadChat.current)
      : -1;
    const incoming =
      lastIndex >= 0
        ? lines.slice(lastIndex + 1)
        : lastReadChat.current
          ? lines.slice(-1)
          : lines;
    if (panel === "chat") {
      lastReadChat.current = latest;
      setUnread(0);
    } else if (incoming.length) {
      setUnread((count) =>
        Math.min(
          99,
          count +
            incoming.filter(
              (line) =>
                line.channel !== "dm" &&
                line.senderId !== state.selfId &&
                !line.own &&
                line.delivery === "sent" &&
                !line.history,
            ).length,
        ),
      );
      lastReadChat.current = latest;
    }
  }, [state.chatMessages, state.selfId, panel, session.userId]);
  useEffect(() => {
    if (!session.userId || state.status !== "online") return;
    const timer = setTimeout(() => void refreshDirectConversations(), 300);
    return () => clearTimeout(timer);
  }, [lastDirectMessageId, session.userId, state.status]);
  useEffect(() => {
    const ack = state.lastDirectMessageReadAck;
    if (
      !ack?.accepted ||
      ack.conversationId !== activeDirectConversationId ||
      panel !== "chat" ||
      chatMode !== "dm"
    )
      return;
    void refreshDirectConversations();
  }, [
    activeDirectConversationId,
    chatMode,
    panel,
    state.lastDirectMessageReadAck,
  ]);
  useEffect(() => {
    connection.connect();
    return () => connection.disconnect();
  }, [connection]);
  useEffect(() => {
    const syncVisibility = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", syncVisibility);
    return () =>
      document.removeEventListener("visibilitychange", syncVisibility);
  }, []);
  useEffect(() => {
    if (
      panel === "chat" &&
      chatMode === "scope" &&
      state.status === "online" &&
      session.userId
    )
      void connection.loadChatHistory(scopedChatChannel, self?.zoneId ?? "");
  }, [
    chatMode,
    connection,
    panel,
    scopedChatChannel,
    self?.zoneId,
    session.userId,
    state.status,
  ]);
  useEffect(() => {
    if (state.status !== "online") {
      lastDirectReadCursor.current = "";
      return;
    }
    if (
      !session.userId ||
      !documentVisible ||
      panel !== "chat" ||
      chatMode !== "dm" ||
      !activeDirectConversationId
    )
      return;
    const latest = [...state.chatMessages]
      .reverse()
      .find(
        (line) =>
          line.channel === "dm" &&
          line.conversationId === activeDirectConversationId &&
          line.delivery === "sent",
      );
    if (!latest) return;
    const key = `${activeDirectConversationId}:${latest.messageId}`;
    if (lastDirectReadCursor.current === key) return;
    const timer = window.setTimeout(() => {
      if (document.hidden || lastDirectReadCursor.current === key) return;
      if (
        connection.markDirectMessageRead(
          activeDirectConversationId,
          latest.messageId,
        )
      )
        lastDirectReadCursor.current = key;
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    activeDirectConversationId,
    chatMode,
    connection,
    documentVisible,
    panel,
    session.userId,
    state.chatMessages,
    state.status,
  ]);
  useEffect(() => {
    const result = state.lastDirectConversationResult;
    if (!result) return;
    if (!result.accepted) {
      setDirectMessageErrorWithKey(
        worldMessageErrorKey(result.code),
        result.message,
      );
      return;
    }
    setDirectMessageError("");
    setActiveDirectConversationId(result.conversationId);
    setChatMode("dm");
    setPanel("chat");
  }, [state.lastDirectConversationResult]);
  useEffect(() => {
    if (
      panel === "chat" &&
      chatMode === "dm" &&
      activeDirectConversationId &&
      state.status === "online"
    ) {
      void connection
        .loadDirectMessageHistory(activeDirectConversationId)
        .then(() => refreshDirectConversations());
    }
  }, [
    activeDirectConversationId,
    chatMode,
    connection,
    panel,
    session.userId,
    state.status,
  ]);
  useEffect(() => {
    if (!online || !profileRequestTargetId) return;
    setProfileRequestFailed(!connection.requestProfile(profileRequestTargetId));
  }, [connection, online, profileRequestTargetId]);
  const totalUnread = Math.min(
    99,
    unread +
      directConversations.reduce(
        (count, conversation) => count + conversation.unreadCount,
        0,
      ),
  );
  const groupManagementConversation = directConversations.find(
    (item) => item.conversationId === groupManagementConversationId,
  );
  return (
    <div className="campus-app">
      <header className="app-header">
        <Brand />
        <span className="header-divider" />
        <div className="space-heading">
          {bootstrap.space.name} <ChevronDown size={14} />
        </div>
        <span className="local-tag">
          {bootstrap.mode === "sso"
            ? t("campus.mode.sso")
            : t("campus.mode.preview")}
        </span>
        <div className="header-end">
          <LanguagePicker />
          {logout && (
            <button
              className="icon-button"
              aria-label={t("campus.logout")}
              title={t("campus.logout")}
              onClick={logout}
            >
              <LogOut size={18} />
            </button>
          )}
          <span
            className={`connection-status ${online ? "is-online" : ""}`}
            role="status"
          >
            <span />
            {online
              ? t("connection.status.connected")
              : state.status === "offline"
                ? t("connection.status.offline")
                : state.status === "reconnecting"
                  ? t("connection.status.reconnecting")
                  : t("connection.status.connecting")}
          </span>
          <span
            className="online-count"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={t("campus.participants.count", {
              count: formatNumber(language, state.players.length),
              capacity: formatNumber(language, bootstrap.space.capacity),
            })}
          >
            <Users size={15} aria-hidden="true" />
            <b data-testid="participant-count" aria-hidden="true">
              {state.players.length}
            </b>
            <span aria-hidden="true">/ {bootstrap.space.capacity}</span>
          </span>
        </div>
      </header>
      <div className="app-body">
        {sidebarCollapsed ? (
          <button
            type="button"
            className="sidebar-expand-button"
            aria-label={t("campus.sidebar.expand")}
            title={t("campus.sidebar.expand")}
            onClick={() => setSidebarCollapsed(false)}
          >
            <ChevronRight size={20} aria-hidden="true" />
          </button>
        ) : (
          <nav className="side-rail" aria-label={t("campus.nav.label")}>
            <PanelDisclosureButton
              className={`rail-button ${panel === "map" ? "active" : ""}`}
              controlsId="campus-info-panel"
              expanded={panel === "map"}
              onClick={() => setPanel((p) => (p === "map" ? null : "map"))}
              aria-label={t("campus.nav.map")}
            >
              <Map size={21} />
              <span>{t("campus.nav.mapShort")}</span>
            </PanelDisclosureButton>
            <PanelDisclosureButton
              className={`rail-button ${panel === "people" ? "active" : ""}`}
              controlsId="campus-info-panel"
              expanded={panel === "people"}
              onClick={() =>
                setPanel((p) => (p === "people" ? null : "people"))
              }
              aria-label={t("campus.nav.people")}
            >
              <Users size={21} />
              <span>{t("campus.nav.peopleShort")}</span>
            </PanelDisclosureButton>
            <PanelDisclosureButton
              className={`rail-button ${panel === "chat" ? "active" : ""}`}
              controlsId="campus-info-panel"
              expanded={panel === "chat"}
              onClick={() => setPanel((p) => (p === "chat" ? null : "chat"))}
              aria-label={
                totalUnread
                  ? t("campus.nav.chatUnread", { count: totalUnread })
                  : t("campus.nav.chat")
              }
            >
              <MessageCircle size={21} />
              <span>{t("campus.nav.chatShort")}</span>
              {totalUnread > 0 && (
                <b className="chat-unread">
                  {totalUnread > 9 ? "9+" : totalUnread}
                </b>
              )}
            </PanelDisclosureButton>
            <div className="rail-spacer" />
            <button
              type="button"
              className="rail-collapse-button"
              aria-label={t("campus.sidebar.collapse")}
              title={t("campus.sidebar.collapse")}
              onClick={() => {
                setPanel(null);
                setSidebarCollapsed(true);
              }}
            >
              <ChevronLeft size={19} aria-hidden="true" />
            </button>
            <img className="rail-mark" src={ASSET_GROUPS.brand.mark} alt="" />
            <span className="rail-caption">
              HUFS
              <br />
              TOWN
            </span>
          </nav>
        )}
        <main className="world-stage">
          <audio
            ref={ambientAudioRef}
            preload="none"
            loop
            aria-hidden="true"
            onError={() => {
              if (nearbyAmbientSound)
                setAmbientPlaybackError(t("campus.ambient.error.load"));
            }}
          />
          {assetsReady ? (
            <WorldCanvas
              map={currentMap}
              connection={connection}
              sceneRef={scene}
              renderMode={worldRenderMode}
              onPortal={onPortal}
              onInteraction={handleObjectInteraction}
              onAmbientSoundChange={setNearbyAmbientSound}
            />
          ) : (
            <div className="world-loading" role="status">
              {t("campus.world.assetsLoading")}
            </div>
          )}
          <section className="sr-only" aria-label={t("campus.world.info")}>
            <h2>{t("campus.world.info")}</h2>
            <p>{t("campus.world.map", { name: currentMap.name })}</p>
            <p>{t("campus.world.place", { name: placeName })}</p>
            {self && (
              <p>
                {t("campus.world.coordinates", {
                  x: self.x.toFixed(1),
                  y: self.y.toFixed(1),
                })}
              </p>
            )}
            <p>
              {t("campus.world.participants", {
                count: formatNumber(language, state.players.length),
              })}
            </p>
            <p>
              {t("campus.world.media", {
                microphone: t(
                  mediaView.microphone ? "campus.world.on" : "campus.world.off",
                ),
                camera: t(
                  mediaView.camera ? "campus.world.on" : "campus.world.off",
                ),
                screen: t(
                  mediaView.screen ? "campus.world.on" : "campus.world.off",
                ),
              })}
            </p>
            <p id="world-controls-description">{t("campus.world.controls")}</p>
            <p role="status" aria-live="polite" aria-atomic="true">
              {worldAnnouncement}
            </p>
          </section>
          {!panel && <MobileMovementPad sceneRef={scene} />}
          {(admissionSpace || onAcceptInvite) && (
            <AdmissionRequestOverlay
              spaceId={admissionSpace?.id}
              spaceName={admissionSpace?.name}
              onAcceptInvite={onAcceptInvite}
            />
          )}
          {pokeNotice && (
            <div className="social-toast" role="status">
              {pokeNotice}
            </div>
          )}
          {state.joinRequests.length > 0 && (
            <div
              className="join-request-toast"
              role="status"
              aria-live="polite"
            >
              {state.joinRequests.map((request) => (
                <div className="join-request-item" key={request.requestId}>
                  <p>
                    {t("campus.joinRequest.text", {
                      name: request.senderName,
                    })}
                  </p>
                  <div>
                    <button
                      type="button"
                      onClick={() =>
                        connection.respondToJoinRequest(
                          request.requestId,
                          false,
                        )
                      }
                    >
                      {t("campus.action.decline")}
                    </button>
                    <button
                      type="button"
                      className="accept"
                      onClick={() =>
                        connection.respondToJoinRequest(request.requestId, true)
                      }
                    >
                      {t("campus.action.accept")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {zone?.kind === "PRIVATE" && currentRoom && (
            <div
              className="room-controls"
              aria-label={t("campus.room.controls")}
            >
              <div className="room-controls-heading">
                <strong>{currentRoom.name}</strong>
                <span>
                  {t("campus.room.occupants", {
                    occupants: formatNumber(language, currentRoom.occupants),
                    capacity: formatNumber(language, currentRoom.capacity),
                  })}
                </span>
              </div>
              <button
                type="button"
                className="room-note-open"
                aria-haspopup="dialog"
                onClick={() => setRoomNoteDialogOpen(true)}
              >
                <FileText size={14} aria-hidden="true" />
                {t("roomNote.open")}
              </button>
              <RoomRecordingControls
                connection={connection}
                spaceId={bootstrap.space.id}
                canViewArchive={Boolean(session.userId)}
                zoneId={currentRoom.zoneId}
                roomName={currentRoom.name}
                isHost={isRoomHost}
                selfId={state.selfId}
                online={online}
                recording={state.roomRecordingState}
                ack={state.lastRoomRecordingAck}
              />
              {isRoomHost ? (
                <>
                  <label>
                    {t("campus.room.capacity")}
                    <select
                      value={currentRoom.capacity}
                      onChange={(event) =>
                        connection.setRoomCapacity(
                          currentRoom.zoneId,
                          Number(event.target.value),
                        )
                      }
                    >
                      {[
                        ...new Set([
                          2,
                          4,
                          8,
                          12,
                          20,
                          50,
                          100,
                          currentRoom.capacity,
                        ]),
                      ]
                        .sort((a, b) => a - b)
                        .map((capacity) => (
                          <option key={capacity} value={capacity}>
                            {t("campus.room.personCount", {
                              count: formatNumber(language, capacity),
                            })}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className={currentRoom.locked ? "locked" : ""}
                    onClick={() =>
                      connection.setRoomLocked(
                        currentRoom.zoneId,
                        !currentRoom.locked,
                        currentRoom.capacity,
                      )
                    }
                  >
                    {t(
                      currentRoom.locked
                        ? "campus.room.unlock"
                        : "campus.room.lock",
                    )}
                  </button>
                  {state.players.filter(
                    (player) =>
                      player.zoneId === currentRoom.zoneId &&
                      player.id !== state.selfId,
                  ).length > 0 && (
                    <div className="room-member-list">
                      <small>{t("campus.room.members")}</small>
                      {state.players
                        .filter(
                          (player) =>
                            player.zoneId === currentRoom.zoneId &&
                            player.id !== state.selfId,
                        )
                        .map((player) => (
                          <div className="room-member-row" key={player.id}>
                            <span>{player.name}</span>
                            <button
                              type="button"
                              onClick={() =>
                                connection.kickRoomMember(
                                  currentRoom.zoneId,
                                  player.id,
                                  currentRoom.capacity,
                                )
                              }
                              aria-label={t("campus.room.kickLabel", {
                                name: player.name,
                              })}
                            >
                              {t("campus.room.kick")}
                            </button>
                          </div>
                        ))}
                    </div>
                  )}
                </>
              ) : (
                <small>
                  {currentRoom.locked
                    ? t("campus.room.lockedHint")
                    : t("campus.room.mediaHint")}
                </small>
              )}
              {isRoomHost && currentRoom.pendingKnocks.length > 0 && (
                <div className="room-knock-list" aria-live="polite">
                  {currentRoom.pendingKnocks.map((knock) => (
                    <div className="room-knock-item" key={knock.knockId}>
                      <span>
                        {t("campus.room.knockText", {
                          name: knock.playerName,
                        })}
                      </span>
                      <div>
                        <button
                          type="button"
                          onClick={() =>
                            connection.respondToRoomKnock(
                              currentRoom.zoneId,
                              knock.knockId,
                              false,
                            )
                          }
                        >
                          {t("campus.action.decline")}
                        </button>
                        <button
                          type="button"
                          className="accept"
                          onClick={() =>
                            connection.respondToRoomKnock(
                              currentRoom.zoneId,
                              knock.knockId,
                              true,
                            )
                          }
                        >
                          {t("campus.action.accept")}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {state.lastRoomKnockResult && (
            <div className="social-toast room-result-toast" role="status">
              {worldAckMessage(state.lastRoomKnockResult, language, t)}
            </div>
          )}
          {state.lastRoomActionAck && !state.lastRoomActionAck.accepted && (
            <div className="social-toast room-result-toast" role="status">
              {worldAckMessage(state.lastRoomActionAck, language, t)}
            </div>
          )}
          {eventToolsEnabled && (event?.active || isEventManager) && (
            <div
              className={`event-controls${eventControlsCollapsed ? " is-collapsed" : ""}`}
              aria-label={t("events.live.label")}
            >
              <div className="event-controls-heading">
                <span className="event-live-dot" />
                <strong>
                  {event?.active ? event.title : t("events.live.label")}
                </strong>
                {event?.active && (
                  <small>
                    {t("events.live.speakerCount", {
                      count: formatNumber(
                        language,
                        event.speakerPlayerIds.length,
                      ),
                    })}{" "}
                    ·{" "}
                    {event.attendanceEnabled
                      ? t("events.live.attendeeCount", {
                          count: formatNumber(language, event.attendeeCount),
                        })
                      : t("events.live.attendanceDisabled")}
                  </small>
                )}
                {isEventManager && event?.eventId && (
                  <button
                    type="button"
                    className="event-export"
                    aria-label={t("events.history.currentCsv")}
                    onClick={() => void exportEventAttendance()}
                  >
                    {t("events.history.currentCsv")}
                  </button>
                )}
                {isEventManager && (
                  <button
                    type="button"
                    className="event-export"
                    onClick={() => void toggleEventHistory()}
                  >
                    {eventHistoryLoading
                      ? t("events.history.loading")
                      : eventHistoryOpen
                        ? t("events.history.close")
                        : t("events.history.open")}
                  </button>
                )}
                <button
                  type="button"
                  className="event-controls-toggle"
                  aria-expanded={!eventControlsCollapsed}
                  aria-controls="event-controls-body"
                  onClick={() =>
                    setEventControlsCollapsed((collapsed) => !collapsed)
                  }
                >
                  {eventControlsCollapsed
                    ? t("events.live.expandTools")
                    : t("events.live.collapseTools")}
                </button>
              </div>
              {event?.active && (
                <div className="event-attendance-notice" role="status">
                  {event.attendancePersistent
                    ? event.attendanceEnabled
                      ? t("events.live.notice.attendance")
                      : t("events.live.notice.resultsOnly")
                    : t("events.live.notice.preview")}
                </div>
              )}
              <div
                id="event-controls-body"
                className="event-controls-body"
                hidden={eventControlsCollapsed}
              >
                {event?.active ? (
                  <div className="event-actions">
                    <button
                      type="button"
                      className={isEventSpeaker ? "active" : ""}
                      disabled={isEventSpeaker && !isEventManager}
                      onClick={() =>
                        connection.eventAction(
                          isEventSpeaker && isEventManager
                            ? "REVOKE_SPEAKER"
                            : event.raisedHandPlayerIds.includes(state.selfId)
                              ? "LOWER_HAND"
                              : "RAISE_HAND",
                          isEventSpeaker && isEventManager ? state.selfId : "",
                        )
                      }
                    >
                      {isEventSpeaker && isEventManager
                        ? t("events.live.speaker.leave")
                        : isEventSpeaker
                          ? t("events.live.speaker.active")
                          : event.raisedHandPlayerIds.includes(state.selfId)
                            ? t("events.live.hand.lower")
                            : t("events.live.hand.raise")}
                    </button>
                    {isEventManager && (
                      <button
                        type="button"
                        className="event-stop"
                        onClick={() => connection.eventAction("STOP")}
                      >
                        {t("events.live.end")}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="event-start-row">
                    <div className="event-start-fields">
                      <input
                        aria-label={t("events.live.field.title")}
                        value={eventTitleDraft}
                        maxLength={80}
                        onChange={(e) => setEventTitleDraft(e.target.value)}
                      />
                      <textarea
                        aria-label={t("events.live.field.description")}
                        value={eventDescriptionDraft}
                        maxLength={280}
                        rows={2}
                        placeholder={t("events.live.descriptionPlaceholder")}
                        onChange={(e) =>
                          setEventDescriptionDraft(e.target.value)
                        }
                      />
                      <input
                        aria-label={t("events.live.field.resource")}
                        value={eventResourceDraft}
                        maxLength={512}
                        placeholder={t("events.live.resourcePlaceholder")}
                        onChange={(e) => setEventResourceDraft(e.target.value)}
                      />
                      <label className="event-attendance-toggle">
                        <input
                          type="checkbox"
                          checked={eventAttendanceEnabled}
                          onChange={(e) =>
                            setEventAttendanceEnabled(e.target.checked)
                          }
                        />{" "}
                        {t("events.live.attendanceToggle")}
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        connection.eventAction(
                          "START",
                          "",
                          eventTitleDraft,
                          eventDescriptionDraft,
                          eventResourceDraft,
                          eventAttendanceEnabled,
                        )
                      }
                    >
                      {t("events.live.start")}
                    </button>
                  </div>
                )}
                {isEventManager &&
                  event?.active &&
                  event.raisedHandPlayerIds.length > 0 && (
                    <div className="event-hands">
                      <small>{t("events.live.hands")}</small>
                      {event.raisedHandPlayerIds.map((id) => {
                        const participant = event.participants.find(
                          (item) => item.playerId === id,
                        );
                        return (
                          <div className="event-hand-row" key={id}>
                            <span>
                              {participant?.name ??
                                t("events.live.participantFallback")}
                              {participant && (
                                <small>
                                  {participant.mapName === currentMap.name
                                    ? t("events.live.currentMap")
                                    : participant.mapName}
                                </small>
                              )}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                connection.eventAction("GRANT_SPEAKER", id)
                              }
                            >
                              {t("events.live.grantSpeaker")}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                {event?.active && engagement?.active && (
                  <div className="event-engagement">
                    {state.worldFeatures.includes("SCAVENGER_HUNT") && (
                      <section
                        className="event-scavenger"
                        aria-label={t("events.scavenger.label")}
                      >
                        <div className="event-scavenger-heading">
                          <div>
                            <strong>{t("events.scavenger.label")}</strong>
                            <small>
                              {engagement.scavengerActive
                                ? t("events.scavenger.state.active")
                                : engagement.scavengerConfigured
                                  ? t("events.scavenger.state.ended")
                                  : t("events.scavenger.state.description")}
                            </small>
                          </div>
                          {isEventManager &&
                            (!engagement.scavengerConfigured ||
                              !engagement.scavengerActive) && (
                              <button
                                type="button"
                                disabled={
                                  engagement.scavengerAvailableItems < 1 ||
                                  engagement.scavengerAvailableNpcs < 1
                                }
                                onClick={() =>
                                  connection.eventEngagement(
                                    "START_SCAVENGER_HUNT",
                                  )
                                }
                              >
                                {engagement.scavengerConfigured
                                  ? t("events.scavenger.startNewRound")
                                  : t("events.scavenger.start")}
                              </button>
                            )}
                          {isEventManager && engagement.scavengerActive && (
                            <button
                              type="button"
                              onClick={() =>
                                connection.eventEngagement(
                                  "STOP_SCAVENGER_HUNT",
                                )
                              }
                            >
                              {t("events.scavenger.stop")}
                            </button>
                          )}
                        </div>

                        {(!engagement.scavengerConfigured ||
                          !engagement.scavengerActive) &&
                          isEventManager && (
                            <p className="event-scavenger-help">
                              {t("events.scavenger.setup")}{" "}
                              {engagement.scavengerConfigured &&
                                t("events.scavenger.resetNotice")}{" "}
                              <span>
                                {t("events.scavenger.available", {
                                  npcs: formatNumber(
                                    language,
                                    engagement.scavengerAvailableNpcs,
                                  ),
                                  items: formatNumber(
                                    language,
                                    engagement.scavengerAvailableItems,
                                  ),
                                })}
                              </span>
                            </p>
                          )}

                        {engagement.scavengerConfigured && (
                          <>
                            <div className="event-scavenger-progress">
                              <span>
                                {engagement.scavengerMapName ||
                                  t("events.live.currentMap")}
                              </span>
                              <strong>
                                {t("events.scavenger.myScore", {
                                  score: formatNumber(
                                    language,
                                    engagement.scavengerMyScore,
                                  ),
                                })}
                              </strong>
                            </div>
                            {engagement.scavengerActive ? (
                              engagement.scavengerUnlocked ? (
                                <>
                                  <p className="event-scavenger-help">
                                    {t("events.scavenger.collectInstruction")}
                                  </p>
                                  <div className="event-scavenger-items">
                                    {engagement.scavengerItems.length > 0 ? (
                                      engagement.scavengerItems.map((item) => {
                                        const collected =
                                          engagement.scavengerMyCollectedObjectIds.includes(
                                            item.objectId,
                                          );
                                        return (
                                          <div
                                            className={`event-scavenger-item${collected ? " collected" : ""}`}
                                            key={item.objectId}
                                          >
                                            <span aria-hidden="true">
                                              {collected ? "✓" : "◇"}
                                            </span>
                                            <div>
                                              <strong>{item.title}</strong>
                                              <small>{item.clue}</small>
                                            </div>
                                            <small>
                                              {collected
                                                ? t(
                                                    "events.scavenger.collected",
                                                  )
                                                : t(
                                                    "events.scavenger.notCollected",
                                                  )}
                                            </small>
                                          </div>
                                        );
                                      })
                                    ) : (
                                      <p className="event-scavenger-help">
                                        {t("events.scavenger.emptyItems")}
                                      </p>
                                    )}
                                  </div>
                                </>
                              ) : (
                                <p className="event-scavenger-help">
                                  {t("events.scavenger.unlockInstruction")}
                                </p>
                              )
                            ) : (
                              <p className="event-scavenger-help">
                                {t("events.scavenger.endedInstruction")}
                              </p>
                            )}
                            {engagement.scavengerCompleted && (
                              <p
                                className="event-scavenger-complete"
                                role="status"
                              >
                                {t("events.scavenger.completed")}
                              </p>
                            )}
                            {engagement.scavengerScores.length > 0 && (
                              <ol
                                className="event-scavenger-scores"
                                aria-label={t("events.scavenger.ranking")}
                              >
                                {engagement.scavengerScores.map(
                                  (score, index) => (
                                    <li key={`${score.name}-${index}`}>
                                      <span>
                                        {index + 1}. {score.name}
                                      </span>
                                      <b>
                                        {t("events.scavenger.score", {
                                          score: formatNumber(
                                            language,
                                            score.score,
                                          ),
                                        })}
                                      </b>
                                    </li>
                                  ),
                                )}
                              </ol>
                            )}
                          </>
                        )}

                        {state.lastEventEngagementAck && (
                          <p
                            className={`event-scavenger-feedback${state.lastEventEngagementAck.accepted ? " accepted" : " rejected"}`}
                            role="status"
                            aria-live="polite"
                          >
                            {t(
                              eventEngagementMessageKey(
                                state.lastEventEngagementAck,
                              ),
                            )}
                          </p>
                        )}
                      </section>
                    )}
                    <form
                      className="event-question-compose"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const text = eventQuestionDraft.trim();
                        if (!text) return;
                        if (connection.eventEngagement("ASK_QUESTION", text))
                          setEventQuestionDraft("");
                      }}
                    >
                      <input
                        aria-label={t("events.engagement.ui.questionLabel")}
                        maxLength={280}
                        value={eventQuestionDraft}
                        onChange={(e) => setEventQuestionDraft(e.target.value)}
                        placeholder={t(
                          "events.engagement.ui.questionPlaceholder",
                        )}
                      />
                      <button
                        type="submit"
                        disabled={!eventQuestionDraft.trim()}
                      >
                        {t("events.engagement.ui.questionSend")}
                      </button>
                    </form>
                    {engagement.questions.length > 0 && (
                      <div className="event-question-list">
                        {engagement.questions.map((question) => (
                          <div className="event-question-row" key={question.id}>
                            <p>
                              <strong>{question.askerName}</strong>{" "}
                              {question.text}
                            </p>
                            {question.answered ? (
                              <small>
                                {t("events.engagement.ui.answerBy", {
                                  name: question.answererName,
                                  answer: question.answer,
                                })}
                              </small>
                            ) : isEventManager ? (
                              <div className="event-answer-row">
                                <input
                                  aria-label={t(
                                    "events.engagement.ui.answerLabel",
                                    { name: question.askerName },
                                  )}
                                  maxLength={280}
                                  value={eventAnswerDrafts[question.id] ?? ""}
                                  onChange={(e) =>
                                    setEventAnswerDrafts((current) => ({
                                      ...current,
                                      [question.id]: e.target.value,
                                    }))
                                  }
                                  placeholder={t(
                                    "events.engagement.ui.answerPlaceholder",
                                  )}
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    const answer = (
                                      eventAnswerDrafts[question.id] ?? ""
                                    ).trim();
                                    if (!answer) return;
                                    if (
                                      connection.eventEngagement(
                                        "ANSWER_QUESTION",
                                        answer,
                                        question.id,
                                      )
                                    )
                                      setEventAnswerDrafts((current) => ({
                                        ...current,
                                        [question.id]: "",
                                      }));
                                  }}
                                >
                                  {t("events.engagement.ui.answerSend")}
                                </button>
                              </div>
                            ) : (
                              <small>
                                {t("events.engagement.ui.answerWaiting")}
                              </small>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {engagement.pollId && (
                      <div className="event-poll">
                        <div className="event-poll-heading">
                          <strong>{engagement.pollQuestion}</strong>
                          <small>
                            {engagement.pollMode === "QUIZ"
                              ? t("events.history.quiz")
                              : t("events.history.poll")}
                            {" · "}
                            {engagement.pollClosed
                              ? t("events.engagement.ui.pollClosed")
                              : t("events.engagement.ui.pollActive")}
                          </small>
                        </div>
                        {engagement.pollOptions.map((option, index) => (
                          <button
                            type="button"
                            className={`event-poll-option${engagement.pollMyOptionIndex === index ? " selected" : ""}${engagement.pollMode === "QUIZ" && engagement.pollClosed && engagement.pollCorrectOptionIndex === index ? " correct" : ""}`}
                            disabled={
                              engagement.pollClosed ||
                              engagement.pollMyOptionIndex >= 0
                            }
                            key={`${engagement.pollId}-${index}`}
                            onClick={() =>
                              connection.eventEngagement(
                                "VOTE_POLL",
                                "",
                                "",
                                "",
                                [],
                                index,
                              )
                            }
                          >
                            <span>
                              {option}
                              {engagement.pollMode === "QUIZ" &&
                                engagement.pollClosed &&
                                engagement.pollCorrectOptionIndex === index && (
                                  <em>{t("events.engagement.ui.correct")}</em>
                                )}
                              {engagement.pollMyOptionIndex === index && (
                                <i>{t("events.engagement.ui.myResponse")}</i>
                              )}
                            </span>
                            {(engagement.pollMode !== "QUIZ" ||
                              engagement.pollClosed) && (
                              <b>
                                {formatNumber(
                                  language,
                                  engagement.pollCounts[index] ?? 0,
                                )}
                              </b>
                            )}
                          </button>
                        ))}
                        {engagement.pollMode === "QUIZ" &&
                          engagement.pollClosed && (
                            <div
                              className="event-quiz-score"
                              aria-live="polite"
                            >
                              <strong>
                                {t("events.engagement.ui.quizMyScore", {
                                  score: formatNumber(
                                    language,
                                    engagement.myQuizScore,
                                  ),
                                })}
                              </strong>
                              {engagement.quizScores.length > 0 && (
                                <ol
                                  aria-label={t(
                                    "events.engagement.ui.quizRanking",
                                  )}
                                >
                                  {engagement.quizScores.map((score, index) => (
                                    <li key={`${score.name}-${index}`}>
                                      <span>
                                        {index + 1}. {score.name}
                                      </span>
                                      <b>
                                        {t("events.engagement.ui.quizScore", {
                                          score: formatNumber(
                                            language,
                                            score.score,
                                          ),
                                        })}
                                      </b>
                                    </li>
                                  ))}
                                </ol>
                              )}
                            </div>
                          )}
                        {!engagement.pollClosed &&
                          engagement.pollMyOptionIndex >= 0 && (
                            <small className="event-poll-response">
                              {t("events.engagement.ui.responseRecorded")}
                            </small>
                          )}
                        {isEventManager && !engagement.pollClosed && (
                          <button
                            type="button"
                            className="event-poll-close"
                            onClick={() =>
                              connection.eventEngagement("CLOSE_POLL")
                            }
                          >
                            {engagement.pollMode === "QUIZ"
                              ? t("events.engagement.ui.closeQuiz")
                              : t("events.engagement.ui.closePoll")}
                          </button>
                        )}
                      </div>
                    )}
                    {isEventManager &&
                      (!engagement.pollId || engagement.pollClosed) && (
                        <form
                          className="event-poll-create"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const question = pollQuestionDraft.trim();
                            const options = pollOptionsDraft
                              .map((option) => option.trim())
                              .filter(Boolean)
                              .filter(
                                (option, index, items) =>
                                  items.indexOf(option) === index,
                              );
                            const correctOption =
                              pollOptionsDraft[
                                quizCorrectOptionDraft
                              ]?.trim() ?? "";
                            const correctOptionIndex =
                              options.indexOf(correctOption);
                            if (
                              !question ||
                              options.length < 2 ||
                              options.length > 6 ||
                              (pollModeDraft === "QUIZ" &&
                                correctOptionIndex < 0)
                            )
                              return;
                            if (
                              connection.eventEngagement(
                                pollModeDraft === "QUIZ"
                                  ? "CREATE_QUIZ"
                                  : "CREATE_POLL",
                                "",
                                "",
                                question,
                                options,
                                0,
                                correctOptionIndex,
                              )
                            )
                              setPollQuestionDraft("");
                          }}
                        >
                          <div
                            className="event-poll-mode"
                            role="group"
                            aria-label={t("events.engagement.ui.createMode")}
                          >
                            <button
                              type="button"
                              aria-pressed={pollModeDraft === "POLL"}
                              onClick={() => setPollModeDraft("POLL")}
                            >
                              {t("events.history.poll")}
                            </button>
                            <button
                              type="button"
                              aria-pressed={pollModeDraft === "QUIZ"}
                              onClick={() => setPollModeDraft("QUIZ")}
                            >
                              {t("events.history.quiz")}
                            </button>
                          </div>
                          <input
                            className="event-poll-question"
                            aria-label={
                              pollModeDraft === "QUIZ"
                                ? t("events.engagement.ui.questionQuiz")
                                : t("events.engagement.ui.questionPoll")
                            }
                            maxLength={160}
                            value={pollQuestionDraft}
                            onChange={(e) =>
                              setPollQuestionDraft(e.target.value)
                            }
                            placeholder={
                              pollModeDraft === "QUIZ"
                                ? t("events.engagement.ui.questionQuiz")
                                : t("events.engagement.ui.questionPoll")
                            }
                          />
                          {pollOptionsDraft.map((option, index) => (
                            <div
                              className="event-poll-option-input"
                              key={index}
                            >
                              <input
                                aria-label={t(
                                  pollModeDraft === "QUIZ"
                                    ? "events.engagement.ui.optionQuiz"
                                    : "events.engagement.ui.optionPoll",
                                  { index: formatNumber(language, index + 1) },
                                )}
                                maxLength={80}
                                value={option}
                                onChange={(e) =>
                                  setPollOptionsDraft((current) =>
                                    current.map((item, itemIndex) =>
                                      itemIndex === index
                                        ? e.target.value
                                        : item,
                                    ),
                                  )
                                }
                              />
                              {pollOptionsDraft.length > 2 && (
                                <button
                                  type="button"
                                  className="event-poll-remove-option"
                                  aria-label={t(
                                    "events.engagement.ui.removeOption",
                                    {
                                      index: formatNumber(language, index + 1),
                                    },
                                  )}
                                  onClick={() => {
                                    setPollOptionsDraft((current) =>
                                      current.filter(
                                        (_, itemIndex) => itemIndex !== index,
                                      ),
                                    );
                                    setQuizCorrectOptionDraft((current) =>
                                      current === index
                                        ? 0
                                        : current > index
                                          ? current - 1
                                          : current,
                                    );
                                  }}
                                >
                                  ×
                                </button>
                              )}
                            </div>
                          ))}
                          {pollModeDraft === "QUIZ" && (
                            <select
                              aria-label={t(
                                "events.engagement.ui.correctOption",
                              )}
                              value={quizCorrectOptionDraft}
                              onChange={(event) =>
                                setQuizCorrectOptionDraft(
                                  Number(event.target.value),
                                )
                              }
                            >
                              {pollOptionsDraft.map((option, index) => (
                                <option key={index} value={index}>
                                  {t("events.engagement.ui.optionChoice", {
                                    index: formatNumber(language, index + 1),
                                    value:
                                      option.trim() ||
                                      t("events.engagement.ui.optionEmpty"),
                                  })}
                                </option>
                              ))}
                            </select>
                          )}
                          <button
                            type="button"
                            className="event-poll-add-option"
                            disabled={pollOptionsDraft.length >= 6}
                            onClick={() =>
                              setPollOptionsDraft((current) => [...current, ""])
                            }
                          >
                            {t("events.engagement.ui.addOption")}
                          </button>
                          <button
                            type="submit"
                            disabled={
                              !pollQuestionDraft.trim() ||
                              new Set(
                                pollOptionsDraft
                                  .map((option) => option.trim())
                                  .filter(Boolean),
                              ).size < 2 ||
                              (pollModeDraft === "QUIZ" &&
                                !pollOptionsDraft[
                                  quizCorrectOptionDraft
                                ]?.trim())
                            }
                          >
                            {pollModeDraft === "QUIZ"
                              ? t("events.engagement.ui.startQuiz")
                              : t("events.engagement.ui.startPoll")}
                          </button>
                        </form>
                      )}
                  </div>
                )}
                {isEventManager && eventHistoryOpen && (
                  <EventHistoryPanel
                    history={eventHistory}
                    results={eventHistoryResults}
                    onOpenEvent={(eventId) => void openEventResults(eventId)}
                    onDownloadAttendance={(eventId) =>
                      void exportEventAttendance(eventId)
                    }
                  />
                )}
              </div>
            </div>
          )}
          {state.lastEventActionAck && !state.lastEventActionAck.accepted && (
            <div className="social-toast room-result-toast" role="status">
              {t(eventActionMessageKey(state.lastEventActionAck))}
            </div>
          )}
          {state.lastEventEngagementAck &&
            !state.lastEventEngagementAck.accepted && (
              <div className="social-toast room-result-toast" role="status">
                {t(eventEngagementMessageKey(state.lastEventEngagementAck))}
              </div>
            )}
          <Suspense fallback={null}>
            <MediaStage
              controller={media}
              view={mediaView}
              policy={state.media}
              event={state.event}
              players={state.players}
              selfId={state.selfId}
              currentMapName={currentMap.name}
            />
          </Suspense>
          {!online && (
            <div className="connection-overlay" role="alert">
              <Radio size={26} />
              <strong>
                {state.status === "offline"
                  ? t("connection.overlay.paused")
                  : t("connection.overlay.connecting")}
              </strong>
              <p>
                {state.messageKey
                  ? language === "ko" && state.message
                    ? state.message
                    : t(state.messageKey)
                  : state.message || t("connection.overlay.waiting")}
              </p>
              {state.status === "offline" && (
                <button onClick={() => connection.retry()}>
                  {t("connection.action.retry")}
                </button>
              )}
            </div>
          )}
          <div className="world-bottom">
            {zone && zone.kind !== "PUBLIC" && (
              <div className="zone-chip">
                <span
                  className={`zone-dot ${zone.kind === "PRIVATE" ? "private" : ""}`}
                />
                <div>
                  <strong>{zone.name}</strong>
                  <small>
                    {zone.kind === "PRIVATE"
                      ? t("campus.zone.private")
                      : t("campus.zone.silent")}
                  </small>
                </div>
              </div>
            )}
            <div className="map-actions">
              <button
                aria-label={t("campus.zoom.out")}
                onClick={() => scene.current?.setZoom(-0.1)}
              >
                <Minus size={17} />
              </button>
              <button
                aria-label={t("campus.zoom.recenter")}
                onClick={() => scene.current?.recenter()}
              >
                <LocateFixed size={17} />
              </button>
              <button
                aria-label={t("campus.zoom.in")}
                onClick={() => scene.current?.setZoom(0.1)}
              >
                <Plus size={17} />
              </button>
            </div>
          </div>
          <div className="movement-hint">
            <kbd>W A S D</kbd> {t("campus.movement.keys")} <span>·</span>{" "}
            {t("campus.movement.click")} <span>·</span> <kbd>Shift</kbd>{" "}
            {t("campus.movement.run")} <span>·</span> <kbd>Z</kbd>{" "}
            {t("campus.movement.poke")}
          </div>
          {online && (
            <div className={`map-quick-chat ${quickChatOpen ? "is-open" : ""}`}>
              {quickChatOpen ? (
                <form
                  className="map-quick-chat-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!quickChatDraft.trim()) return;
                    const sent = connection.sendChat(
                      quickChatDraft,
                      "nearby",
                      self?.zoneId ?? "",
                    );
                    if (sent) {
                      setQuickChatDraft("");
                      setQuickChatOpen(false);
                    }
                  }}
                >
                  <div className="map-quick-chat-heading">
                    <span>
                      <MessageCircle size={16} aria-hidden="true" />
                      {t("campus.quickChat.title")}
                    </span>
                    <button
                      type="button"
                      aria-label={t("campus.quickChat.close")}
                      onClick={() => setQuickChatOpen(false)}
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="map-quick-chat-compose">
                    <input
                      ref={quickChatInputRef}
                      type="text"
                      maxLength={500}
                      value={quickChatDraft}
                      onChange={(event) =>
                        setQuickChatDraft(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setQuickChatOpen(false);
                        }
                      }}
                      placeholder={t("campus.quickChat.placeholder")}
                      aria-label={t("campus.quickChat.inputLabel")}
                    />
                    <button
                      type="submit"
                      disabled={!quickChatDraft.trim()}
                      aria-label={t("campus.quickChat.send")}
                    >
                      <Send size={18} aria-hidden="true" />
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  className="map-quick-chat-trigger"
                  aria-label={t("campus.quickChat.open")}
                  onClick={() => setQuickChatOpen(true)}
                >
                  <MessageCircle size={17} aria-hidden="true" />
                  <span className="map-quick-chat-wide">
                    {t("campus.quickChat.open")}
                  </span>
                  <span className="map-quick-chat-short">
                    {t("campus.quickChat.openShort")}
                  </span>
                  <kbd>Enter</kbd>
                </button>
              )}
            </div>
          )}
        </main>
        {panel && (
          <aside
            className="info-panel"
            id="campus-info-panel"
            aria-labelledby="campus-panel-title"
          >
            <div className="panel-heading">
              <div>
                <h2 id="campus-panel-title">
                  {panel === "map"
                    ? t("campus.panel.title.map")
                    : panel === "people"
                      ? peoplePanelTab === "settings"
                        ? t("people.tab.settings")
                        : t("campus.panel.title.people")
                      : t("campus.panel.title.chat")}{" "}
                  {panel === "people" && peoplePanelTab === "people" && (
                    <span>{state.players.length}</span>
                  )}
                </h2>
              </div>
              <button
                className="icon-button"
                aria-label={t("campus.panel.close")}
                onClick={() => setPanel(null)}
              >
                <X size={17} />
              </button>
            </div>
            {panel === "map" ? (
              <MiniMapPanel
                map={currentMap}
                players={state.players}
                selfId={state.selfId}
                selfZoneId={self?.zoneId ?? ""}
                rooms={state.rooms}
                onFocus={(x, y) => scene.current?.focusAt(x, y)}
              />
            ) : panel === "people" ? (
              <>
                <div
                  className="chat-tabs people-tabs"
                  role="tablist"
                  aria-label={t("people.tabs.aria")}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                      return;
                    const nextTab =
                      peoplePanelTab === "people" ? "settings" : "people";
                    event.preventDefault();
                    setPeoplePanelTab(nextTab);
                    document.getElementById(`people-${nextTab}-tab`)?.focus();
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    id="people-people-tab"
                    aria-controls="people-panel-content"
                    aria-selected={peoplePanelTab === "people"}
                    tabIndex={peoplePanelTab === "people" ? 0 : -1}
                    className={peoplePanelTab === "people" ? "active" : ""}
                    onClick={() => setPeoplePanelTab("people")}
                  >
                    {t("people.tab.people")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="people-settings-tab"
                    aria-controls="people-panel-content"
                    aria-selected={peoplePanelTab === "settings"}
                    tabIndex={peoplePanelTab === "settings" ? 0 : -1}
                    className={peoplePanelTab === "settings" ? "active" : ""}
                    onClick={() => setPeoplePanelTab("settings")}
                  >
                    {t("people.tab.settings")}
                  </button>
                </div>
                <div
                  id="people-panel-content"
                  className="people-panel-content"
                  role="tabpanel"
                  aria-labelledby={`people-${peoplePanelTab}-tab`}
                >
                  {peoplePanelTab === "people" && (
                    <>
                      <label className="search-label">
                        <Users size={15} />
                        <input
                          aria-label={t("people.search.aria")}
                          placeholder={t("people.search.placeholder")}
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </label>
                      {session.userId && bootstrap.mode === "sso" && (
                        <button
                          className="friends-open"
                          type="button"
                          onClick={() => setFriendsDialogOpen(true)}
                        >
                          <UserPlus size={15} />
                          {t("friends.title")}
                          {Boolean(friendOverview?.incoming.length) && (
                            <span
                              aria-label={t("friends.incoming.title", {
                                count: formatNumber(
                                  language,
                                  friendOverview?.incoming.length ?? 0,
                                ),
                              })}
                            >
                              {friendOverview?.incoming.length}
                            </span>
                          )}
                        </button>
                      )}
                      {session.userId && (
                        <button
                          className="group-chat-start"
                          type="button"
                          disabled={
                            !online ||
                            state.players.filter(
                              (p) =>
                                p.id !== state.selfId &&
                                p.directMessageEnabled &&
                                !state.blockedPlayerIds.includes(p.id),
                            ).length < 2
                          }
                          onClick={() => {
                            setGroupName("");
                            setGroupMemberIds([]);
                            setDirectMessageError("");
                            setGroupDialogOpen(true);
                          }}
                        >
                          <Users size={15} /> {t("people.group.start")}
                        </button>
                      )}
                      {session.userId && (
                        <section
                          className="group-invitation-inbox"
                          aria-label={t("people.group.invitationInbox")}
                        >
                          <div className="group-invitation-heading">
                            <strong>{t("people.group.invitationInbox")}</strong>
                            {groupInvitationsLoading && (
                              <small>{t("people.group.loading")}</small>
                            )}
                          </div>
                          {groupInvitations.map((invitation) => (
                            <article
                              className="group-invitation-card"
                              key={invitation.invitationId}
                            >
                              <div>
                                <strong>{invitation.groupName}</strong>
                                <small>
                                  {t("people.group.invitedByUntil", {
                                    name: invitation.inviterName,
                                    date: formatDate(
                                      language,
                                      invitation.expiresAt,
                                    ),
                                  })}
                                </small>
                              </div>
                              <div className="group-invitation-actions">
                                <button
                                  type="button"
                                  onClick={() =>
                                    void respondToInvitation(invitation, false)
                                  }
                                  disabled={respondingInvitationId !== ""}
                                >
                                  {t("people.group.decline")}
                                </button>
                                <button
                                  type="button"
                                  className="accept"
                                  onClick={() =>
                                    void respondToInvitation(invitation, true)
                                  }
                                  disabled={respondingInvitationId !== ""}
                                >
                                  {respondingInvitationId ===
                                  invitation.invitationId
                                    ? t("people.group.processing")
                                    : t("people.group.accept")}
                                </button>
                              </div>
                            </article>
                          ))}
                          {!groupInvitationsLoading &&
                            !groupInvitations.length && (
                              <small className="group-invitation-empty">
                                {t("people.group.empty")}
                              </small>
                            )}
                          {directMessageError && (
                            <p className="poke-feedback error" role="status">
                              {directMessageError}
                            </p>
                          )}
                        </section>
                      )}
                      {session.userId && (
                        <MeetupRequestInbox
                          onOpenDestination={onOpenMeetupDestination}
                        />
                      )}
                    </>
                  )}
                  {peoplePanelTab === "settings" && (
                    <>
                      <label className="poke-preference">
                        <input
                          type="checkbox"
                          checked={eventToolsEnabled}
                          onChange={(event) =>
                            toggleEventTools(event.target.checked)
                          }
                        />
                        <span>
                          <strong>{t("people.eventTools.title")}</strong>
                          <small>{t("people.eventTools.description")}</small>
                        </span>
                      </label>
                      {session.userId && (
                        <button
                          type="button"
                          className="direct-notification-setting"
                          aria-pressed={directNotificationsEnabled}
                          onClick={() => void toggleDirectNotifications()}
                        >
                          <Bell size={15} />
                          <span>
                            <strong>
                              {directNotificationsEnabled
                                ? t("people.notifications.enabled")
                                : t("people.notifications.enable")}
                            </strong>
                            <small>
                              {t("people.notifications.description")}{" "}
                              {t("people.notifications.secureContext")}
                            </small>
                          </span>
                        </button>
                      )}
                      <label className="presence-setting">
                        <span>{t("people.presence.label")}</span>
                        <select
                          aria-label={t("people.presence.label")}
                          value={self?.status ?? "AVAILABLE"}
                          disabled={!online}
                          onChange={(event) =>
                            setManualPresence(
                              event.target.value as
                                | "AVAILABLE"
                                | "AWAY"
                                | "DND",
                            )
                          }
                        >
                          <option value="AVAILABLE">
                            {t("people.presence.available")}
                          </option>
                          <option value="AWAY">
                            {t("people.presence.away")}
                          </option>
                          <option value="DND">
                            {t("people.presence.dnd")}
                          </option>
                        </select>
                        <small>{t("people.presence.hint")}</small>
                      </label>
                      <label className="poke-preference auto-away-preference">
                        <input
                          type="checkbox"
                          checked={autoAwayEnabled}
                          onChange={(event) =>
                            toggleAutoAway(event.target.checked)
                          }
                        />
                        <span>
                          <strong>{t("people.presence.autoAway.title")}</strong>
                          <small>
                            {t("people.presence.autoAway.description")}
                          </small>
                        </span>
                      </label>
                      <label className="poke-preference">
                        <input
                          type="checkbox"
                          checked={worldRenderMode === "low-spec"}
                          onChange={(event) =>
                            updateWorldRenderMode(
                              event.target.checked ? "low-spec" : "standard",
                            )
                          }
                        />
                        <span>
                          <strong>{t("people.render.lowSpec.title")}</strong>
                          <small>
                            {t("people.render.lowSpec.description")}
                          </small>
                        </span>
                      </label>
                      {state.lastPresenceAck && (
                        <p
                          className={`poke-feedback ${state.lastPresenceAck.accepted ? "success" : "error"}`}
                          role="status"
                        >
                          {worldAckMessage(state.lastPresenceAck, language, t)}
                        </p>
                      )}
                      <label className="poke-preference">
                        <input
                          type="checkbox"
                          checked={acceptPokes}
                          disabled={pokePreferenceBusy}
                          onChange={(event) =>
                            void updatePokePreference(event.target.checked)
                          }
                        />
                        <span>
                          <strong>{t("people.pokePreference.title")}</strong>
                          <small>
                            {session.userId
                              ? t("people.pokePreference.account")
                              : t("people.pokePreference.browser")}
                          </small>
                        </span>
                      </label>
                      {pokePreferenceError && (
                        <p className="poke-feedback error" role="alert">
                          {pokePreferenceError}
                        </p>
                      )}
                    </>
                  )}
                  {peoplePanelTab === "people" && (
                    <>
                      {playerReportNotice && (
                        <p className="poke-feedback success" role="status">
                          {playerReportNotice}
                        </p>
                      )}
                      {state.lastJoinRequestAck && (
                        <p
                          className={`poke-feedback ${state.lastJoinRequestAck.accepted ? "success" : "error"}`}
                          role="status"
                        >
                          {worldAckMessage(
                            state.lastJoinRequestAck,
                            language,
                            t,
                          )}
                        </p>
                      )}
                      {state.lastDirectConversationResult &&
                        !state.lastDirectConversationResult.accepted && (
                          <p className="poke-feedback error" role="status">
                            {worldAckMessage(
                              state.lastDirectConversationResult,
                              language,
                              t,
                            )}
                          </p>
                        )}
                      {state.lastJoinResult && (
                        <p
                          className={`poke-feedback ${state.lastJoinResult.moved ? "success" : "error"}`}
                          role="status"
                        >
                          {worldAckMessage(
                            state.lastJoinResult,
                            language,
                            t,
                            participantName(state.lastJoinResult.targetId),
                          )}
                        </p>
                      )}
                      {state.lastBlockAck && (
                        <p
                          className={`poke-feedback ${state.lastBlockAck.accepted ? "success" : "error"}`}
                          role="status"
                        >
                          {worldAckMessage(
                            state.lastBlockAck,
                            language,
                            t,
                            participantName(state.lastBlockAck.targetId),
                          )}
                        </p>
                      )}
                      <div className="participant-list">
                        {state.players
                          .filter((p) =>
                            p.name.toLowerCase().includes(search.toLowerCase()),
                          )
                          .map((p) => (
                            <div
                              className={`participant ${state.blockedPlayerIds.includes(p.id) ? "is-blocked" : ""}`}
                              key={p.id}
                            >
                              <button
                                type="button"
                                className="participant-profile-trigger"
                                onClick={() => openParticipantProfile(p.id)}
                                aria-label={
                                  p.microphoneOn === undefined
                                    ? t("people.participant.profile", {
                                        name: p.name,
                                      })
                                    : t("people.participant.profileWithMic", {
                                        name: p.name,
                                        status: t(
                                          p.microphoneOn
                                            ? "people.participant.micOn"
                                            : "people.participant.micOff",
                                        ),
                                      })
                                }
                              >
                                <span
                                  className={`participant-avatar color-${p.avatar}`}
                                >
                                  <Avatar
                                    id={p.avatar}
                                    size={36}
                                    appearance={p}
                                  />
                                </span>
                                <span className="participant-profile-copy">
                                  <strong>
                                    {p.name}
                                    {p.id === state.selfId && (
                                      <em>{t("people.participant.self")}</em>
                                    )}
                                    {p.microphoneOn !== undefined && (
                                      <span
                                        className={`participant-microphone ${p.microphoneOn ? "is-on" : "is-off"}`}
                                        title={t(
                                          p.microphoneOn
                                            ? "people.participant.micOn"
                                            : "people.participant.micOff",
                                        )}
                                        aria-hidden="true"
                                      >
                                        {p.microphoneOn ? (
                                          <Mic size={13} strokeWidth={2.2} />
                                        ) : (
                                          <MicOff size={13} strokeWidth={2.2} />
                                        )}
                                      </span>
                                    )}
                                  </strong>
                                  <small>
                                    {currentMap.zones.find(
                                      (z) => z.id === p.zoneId,
                                    )?.name ??
                                      t("people.participant.fallbackPlace")}
                                    {p.status === "AWAY"
                                      ? ` · ${t("people.participant.away")}`
                                      : p.status === "DND"
                                        ? ` · ${t("people.participant.dnd")}`
                                        : ""}
                                  </small>
                                </span>
                              </button>
                              <span
                                className={`presence-dot ${p.status.toLowerCase()}`}
                                role="img"
                                aria-label={t(
                                  p.status === "AVAILABLE"
                                    ? "people.presence.available"
                                    : p.status === "AWAY"
                                      ? "people.presence.away"
                                      : "people.presence.dnd",
                                )}
                              />
                              <button
                                className="participant-message"
                                type="button"
                                aria-label={t("people.participant.message", {
                                  name: p.name,
                                })}
                                title={t("people.participant.messageTitle")}
                                disabled={
                                  !online ||
                                  !session.userId ||
                                  p.id === state.selfId ||
                                  state.blockedPlayerIds.includes(p.id)
                                }
                                onClick={() => requestDirectMessage(p.id)}
                              >
                                <MessageCircle size={14} />
                              </button>
                              <button
                                className={`participant-block ${state.blockedPlayerIds.includes(p.id) ? "active" : ""}`}
                                type="button"
                                aria-label={t(
                                  state.blockedPlayerIds.includes(p.id)
                                    ? "people.participant.unblockLabel"
                                    : "people.participant.blockLabel",
                                  { name: p.name },
                                )}
                                aria-pressed={state.blockedPlayerIds.includes(
                                  p.id,
                                )}
                                title={t("people.participant.blockTitle")}
                                disabled={
                                  !online ||
                                  !session.userId ||
                                  p.id === state.selfId
                                }
                                onClick={() =>
                                  connection.setBlocked(
                                    p.id,
                                    !state.blockedPlayerIds.includes(p.id),
                                  )
                                }
                              >
                                {state.blockedPlayerIds.includes(p.id)
                                  ? t("people.blocks.unblock")
                                  : t("people.participant.block")}
                              </button>
                              <button
                                className="participant-poke"
                                type="button"
                                aria-label={t("people.participant.poke", {
                                  name: p.name,
                                })}
                                title={t("people.participant.pokeTitle")}
                                disabled={!online || !canPoke(p)}
                                onClick={() => connection.poke(p.id)}
                              >
                                👉
                              </button>
                              <button
                                className="participant-report"
                                type="button"
                                aria-label={t("report.participant.label", {
                                  name: p.name,
                                })}
                                title={t("report.participant.title")}
                                disabled={
                                  !online ||
                                  !session.userId ||
                                  p.id === state.selfId ||
                                  !state.worldFeatures.includes(
                                    "PARTICIPANT_REPORTS",
                                  )
                                }
                                onClick={() => {
                                  setReportTarget({
                                    kind: "PLAYER",
                                    playerId: p.id,
                                    playerName: p.name,
                                  });
                                  setReportCategory("HARASSMENT");
                                  setReportDetails("");
                                  setReportError("");
                                }}
                              >
                                <Flag size={14} />
                              </button>
                              <button
                                className="participant-join"
                                type="button"
                                aria-label={t("people.participant.joinLabel", {
                                  name: p.name,
                                })}
                                title={t("people.participant.joinTitle")}
                                disabled={!online || !canRequestJoin(p)}
                                onClick={() => connection.requestJoin(p.id)}
                              >
                                {t("people.participant.join")}
                              </button>
                            </div>
                          ))}
                        {!state.players.length && (
                          <p className="muted small">
                            {t("people.participant.empty")}
                          </p>
                        )}
                        {state.players.length > 0 &&
                          !state.players.some((p) =>
                            p.name.toLowerCase().includes(search.toLowerCase()),
                          ) && (
                            <p className="muted small">
                              {t("people.participant.noMatch")}
                            </p>
                          )}
                        {!!otherSpaceParticipants.length && (
                          <section
                            className="space-participant-section"
                            aria-label={t("people.otherSpace.title")}
                          >
                            <h3>{t("people.otherSpace.title")}</h3>
                            {otherSpaceParticipants.map((participant) => {
                              const blocked = state.blockedPlayerIds.includes(
                                participant.playerId,
                              );
                              const place =
                                participant.mapId === currentMap.id
                                  ? t("people.otherSpace.currentMapOtherPlace")
                                  : participant.mapName;
                              return (
                                <div
                                  className={`participant space-participant ${blocked ? "is-blocked" : ""}`}
                                  key={participant.playerId}
                                >
                                  <button
                                    className="participant-profile-trigger"
                                    type="button"
                                    aria-label={t(
                                      "people.participant.profile",
                                      {
                                        name: participant.name,
                                      },
                                    )}
                                    onClick={() =>
                                      openParticipantProfile(
                                        participant.playerId,
                                      )
                                    }
                                  >
                                    <span
                                      className={`participant-avatar color-${participant.avatar}`}
                                      aria-hidden="true"
                                    >
                                      <Avatar
                                        id={participant.avatar}
                                        size={36}
                                        appearance={participant}
                                      />
                                    </span>
                                    <span className="participant-profile-copy">
                                      <strong>{participant.name}</strong>
                                      <small>
                                        {place}
                                        {participant.status === "AWAY"
                                          ? ` · ${t("people.participant.away")}`
                                          : participant.status === "DND"
                                            ? ` · ${t("people.participant.dnd")}`
                                            : ""}
                                      </small>
                                    </span>
                                  </button>
                                  <span
                                    className={`presence-dot ${participant.status.toLowerCase()}`}
                                    role="img"
                                    aria-label={
                                      participant.status === "AVAILABLE"
                                        ? t("people.presence.available")
                                        : participant.status === "AWAY"
                                          ? t("people.presence.away")
                                          : t("people.presence.dnd")
                                    }
                                  />
                                  <button
                                    className="participant-message"
                                    type="button"
                                    aria-label={t(
                                      "people.participant.message",
                                      {
                                        name: participant.name,
                                      },
                                    )}
                                    title={t("people.participant.messageTitle")}
                                    disabled={
                                      !online ||
                                      !session.userId ||
                                      blocked ||
                                      !participant.directMessageEnabled
                                    }
                                    onClick={() =>
                                      requestDirectMessage(participant.playerId)
                                    }
                                  >
                                    <MessageCircle size={14} />
                                  </button>
                                  <button
                                    className="participant-report"
                                    type="button"
                                    aria-label={t("report.participant.label", {
                                      name: participant.name,
                                    })}
                                    title={t("report.participant.title")}
                                    disabled={
                                      !online ||
                                      !session.userId ||
                                      !state.worldFeatures.includes(
                                        "PARTICIPANT_REPORTS",
                                      )
                                    }
                                    onClick={() => {
                                      setReportTarget({
                                        kind: "PLAYER",
                                        playerId: participant.playerId,
                                        playerName: participant.name,
                                      });
                                      setReportCategory("HARASSMENT");
                                      setReportDetails("");
                                      setReportError("");
                                    }}
                                  >
                                    <Flag size={14} />
                                  </button>
                                  <button
                                    className="participant-join"
                                    type="button"
                                    aria-label={t(
                                      "people.participant.joinLabel",
                                      {
                                        name: participant.name,
                                      },
                                    )}
                                    title={t("people.participant.joinTitle")}
                                    disabled={
                                      !online ||
                                      !self ||
                                      self.status !== "AVAILABLE" ||
                                      participant.status !== "AVAILABLE" ||
                                      blocked
                                    }
                                    onClick={() =>
                                      connection.requestJoin(
                                        participant.playerId,
                                      )
                                    }
                                  >
                                    {t("people.participant.join")}
                                  </button>
                                </div>
                              );
                            })}
                          </section>
                        )}
                      </div>
                      {session.userId && (
                        <details className="saved-blocks">
                          <summary>
                            {t("people.blocks.summary", {
                              count: formatNumber(language, savedBlocks.length),
                            })}
                          </summary>
                          {blocksLoading ? (
                            <p className="muted small">
                              {t("people.blocks.loading")}
                            </p>
                          ) : savedBlocks.length ? (
                            <ul>
                              {savedBlocks.map((block) => (
                                <li key={block.id}>
                                  <span>
                                    <strong>{block.displayName}</strong>
                                    <small>
                                      {t("people.blocks.blockedAt", {
                                        date: formatDate(
                                          language,
                                          block.createdAt,
                                        ),
                                      })}
                                    </small>
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void unblockSavedAccount(block)
                                    }
                                  >
                                    {t("people.blocks.unblock")}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="muted small">
                              {t("people.blocks.empty")}
                            </p>
                          )}
                          {blocksError && (
                            <p className="poke-feedback error" role="alert">
                              {blocksError}
                            </p>
                          )}
                        </details>
                      )}
                      {moderationAccess && (
                        <div className="moderation-tools">
                          <button
                            type="button"
                            className="moderation-open-button"
                            onClick={() => setModerationDialogOpen(true)}
                          >
                            <Flag size={14} /> {t("moderation.button.review")}
                          </button>
                          <button
                            type="button"
                            className="moderation-open-button"
                            onClick={() => setChatRetentionDialogOpen(true)}
                          >
                            <Settings2 size={14} />{" "}
                            {t("moderation.button.retention")}
                          </button>
                          <button
                            type="button"
                            className="moderation-open-button"
                            onClick={() => setProductAnalyticsDialogOpen(true)}
                          >
                            <Compass size={14} />{" "}
                            {t("moderation.button.analytics")}
                          </button>
                        </div>
                      )}
                      <div className="media-pending">
                        <Radio size={16} />
                        <p>{t("campus.media.hint")}</p>
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : (
              <ChatPanel
                messages={state.chatMessages}
                channel={chatChannel}
                mode={chatMode}
                conversations={directConversations}
                conversationId={
                  chatMode === "dm" ? activeDirectConversationId : ""
                }
                authenticated={!!session.userId}
                error={directMessageError}
                zoneName={zone?.name ?? t("chat.zone.privateFallback")}
                zoneId={self?.zoneId ?? ""}
                selfId={state.selfId}
                onScopeChannelChange={(channel) =>
                  setSpaceChatPreferred(channel === "space")
                }
                persistHistory={!!session.userId}
                online={online}
                historyPage={
                  state.chatHistoryPages[activeHistoryKey] ?? {
                    beforeId: "",
                    hasMore: false,
                    loading: false,
                    error: "",
                    canReload: false,
                  }
                }
                leavingGroup={leavingGroupId === activeDirectConversationId}
                mutationAck={state.lastDirectMessageMutationAck}
                mutatingMessageId={mutatingMessageId}
                reportSuccess={reportSuccess}
                onInviteGroup={(conversationId) => {
                  setInviteGroupConversationId(conversationId);
                  setInviteTargetPlayerId("");
                  setDirectMessageError("");
                }}
                onManageGroup={(conversationId) =>
                  void openGroupManagement(conversationId)
                }
                onRequestMeetup={(conversationId) =>
                  void requestMeetupFromConversation(conversationId)
                }
                meetupRequestBusy={sendingMeetupRequest}
                onModeChange={(mode) => {
                  setChatMode(mode);
                  setActiveDirectConversationId("");
                  setDirectMessageError("");
                }}
                onSelectConversation={(id) => {
                  setActiveDirectConversationId(id);
                  setDirectMessageError("");
                }}
                onBack={() => setActiveDirectConversationId("")}
                onLeaveGroup={(conversationId) =>
                  void leaveGroupConversationFromCampus(conversationId)
                }
                onLoadOlder={() =>
                  chatChannel === "dm"
                    ? connection.loadOlderDirectMessageHistory(
                        activeDirectConversationId,
                      )
                    : connection.loadOlderChatHistory(
                        scopedChatChannel,
                        self?.zoneId ?? "",
                      )
                }
                onReloadHistory={() =>
                  chatChannel === "dm"
                    ? connection.loadDirectMessageHistory(
                        activeDirectConversationId,
                      )
                    : connection.loadChatHistory(
                        scopedChatChannel,
                        self?.zoneId ?? "",
                      )
                }
                onMutateMessage={mutateDirectMessage}
                onLoadMessageRevisions={listDirectMessageRevisions}
                onReportMessage={(conversationId, messageId) => {
                  setReportTarget({
                    kind: "MESSAGE",
                    conversationId,
                    messageId,
                  });
                  setReportCategory("HARASSMENT");
                  setReportDetails("");
                  setReportError("");
                }}
                onSend={(text, channel, zoneId, conversationId) =>
                  connection.sendChat(text, channel, zoneId, conversationId)
                }
              />
            )}
          </aside>
        )}
      </div>
      <footer className="control-bar">
        <div className="self-profile">
          <span className={`profile-avatar color-${session.avatar}`}>
            <Avatar id={session.avatar} size={36} appearance={session} />
          </span>
          <div>
            <strong>{session.name}</strong>
          </div>
        </div>
        <div className="media-controls">
          <Suspense fallback={null}>
            <MediaControls controller={media} view={mediaView} />
          </Suspense>
          <button
            type="button"
            className="control"
            onClick={openWardrobe}
            aria-label={t("campus.wardrobe.openLabel")}
          >
            <Pencil size={20} />
            <span>{t("campus.wardrobe.open")}</span>
          </button>
          {nearbyAmbientSound && (
            <button
              type="button"
              className={`control ${ambientEnabled && !ambientPlaybackError ? "selected" : ""}`}
              onClick={toggleAmbientSound}
              aria-pressed={ambientEnabled && !ambientPlaybackError}
              aria-label={t("campus.ambient.aria", {
                name: nearbyAmbientSound.title,
                action: t(
                  ambientEnabled && !ambientPlaybackError
                    ? "campus.ambient.stopAction"
                    : "campus.ambient.playAction",
                ),
              })}
              title={ambientPlaybackError || nearbyAmbientSound.title}
            >
              {ambientEnabled && !ambientPlaybackError ? (
                <Volume2 size={21} />
              ) : (
                <VolumeX size={21} />
              )}
              <span>
                {ambientPlaybackError
                  ? t("campus.ambient.retry")
                  : ambientEnabled
                    ? t("campus.ambient.stop")
                    : t("campus.ambient.play")}
              </span>
            </button>
          )}
          <span className="sr-only" role="status" aria-live="polite">
            {ambientPlaybackError}
          </span>
          <span className="control-divider" />
          <div className="emote-anchor">
            <button
              className={`control ${emotes ? "selected" : ""}`}
              onClick={() => setEmotes((v) => !v)}
              aria-expanded={emotes}
              aria-label={t("campus.emote.toggle")}
              disabled={!online}
            >
              <Smile size={21} />
              <span>{t("campus.emote.toggle")}</span>
            </button>
            {emotes && (
              <div
                className="emote-picker"
                role="group"
                aria-label={t("campus.emote.picker")}
              >
                {availableEmotes(state.worldFeatures).map(
                  ([value, icon, labelKey], index) => {
                    const shortcut =
                      index < 10 ? String((index + 1) % 10) : undefined;
                    const label =
                      value === "sit" && self?.sitting
                        ? t("campus.emote.stand")
                        : t(labelKey);
                    return (
                      <button
                        key={value}
                        aria-label={label}
                        aria-keyshortcuts={shortcut}
                        aria-pressed={
                          value === "sit" ? Boolean(self?.sitting) : undefined
                        }
                        title={shortcut ? `${label} (${shortcut})` : label}
                        onClick={() => {
                          connection.emote(value);
                          setEmotes(false);
                        }}
                      >
                        {icon}
                        {shortcut && (
                          <kbd className="emote-shortcut" aria-hidden="true">
                            {shortcut}
                          </kbd>
                        )}
                      </button>
                    );
                  },
                )}
              </div>
            )}
          </div>
        </div>
        <button
          className="leave-button"
          aria-label={t("campus.leave")}
          onClick={() => {
            connection.disconnect();
            leave();
          }}
        >
          <DoorOpen size={18} />
          <span>{t("campus.leave")}</span>
        </button>
      </footer>
      {activeNpc && (
        <Dialog title={activeNpc.title} close={() => setActiveNpc(undefined)}>
          <section className="npc-conversation">
            {activeNpc.portraitUrl && (
              <img
                src={activeNpc.portraitUrl}
                alt={t("campus.npc.portraitAlt", { name: activeNpc.title })}
                decoding="async"
              />
            )}
            <div className="npc-dialogue-bubble">
              <strong>{activeNpc.title}</strong>
              <p>{activeNpc.lines[npcLine]}</p>
            </div>
            <div className="npc-dialogue-actions">
              <span role="status">
                {npcLine + 1} / {activeNpc.lines.length}
              </span>
              <button
                type="button"
                onClick={() =>
                  npcLine + 1 < activeNpc.lines.length
                    ? setNpcLine(npcLine + 1)
                    : setActiveNpc(undefined)
                }
              >
                {npcLine + 1 < activeNpc.lines.length
                  ? t("campus.npc.next")
                  : t("campus.npc.finish")}
              </button>
            </div>
          </section>
        </Dialog>
      )}
      {wardrobeOpen && (
        <Dialog
          title={t("wardrobe.title")}
          close={() => setWardrobeOpen(false)}
          size="wide"
        >
          <form
            className="wardrobe-form"
            onSubmit={(event) => void saveWardrobe(event)}
          >
            <div className="wardrobe-main">
              <aside className="wardrobe-preview">
                <div className="wardrobe-preview-stage">
                  <Avatar
                    id={wardrobeAvatar}
                    size={144}
                    appearance={{
                      skin: wardrobeSkin,
                      clothing: wardrobeClothing,
                      hair: wardrobeHair,
                    }}
                  />
                </div>
                <strong>
                  {wardrobeName.trim() || t("wardrobe.preview.name")}
                </strong>
                <p>{t("wardrobe.preview.description")}</p>
                <label className="wardrobe-shape">
                  {t("wardrobe.shape")}
                  <select
                    value={wardrobeAvatar}
                    onChange={(event) =>
                      setWardrobeAvatar(Number(event.target.value))
                    }
                  >
                    {AVATAR_CATALOG.bodyShapes.map((shape, index) => (
                      <option key={shape} value={index}>
                        {avatarPartLabel(shape, (word) =>
                          t(`avatarPart.${word}` as TranslationKey),
                        )}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="avatar-randomize"
                  onClick={randomizeWardrobe}
                >
                  <Shuffle size={15} /> {t("wardrobe.randomize")}
                </button>
              </aside>
              <section className="wardrobe-item-editor">
                <div
                  className="wardrobe-category-tabs"
                  role="group"
                  aria-label={t("wardrobe.items")}
                >
                  {(
                    [
                      ["clothing", t("wardrobe.category.clothing")],
                      ["hair", t("wardrobe.category.hair")],
                      ["skin", t("wardrobe.category.skin")],
                    ] as const
                  ).map(([category, label]) => (
                    <button
                      key={category}
                      type="button"
                      aria-pressed={wardrobeCategory === category}
                      className={
                        wardrobeCategory === category ? "selected" : ""
                      }
                      onClick={() => setWardrobeCategory(category)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="wardrobe-items-heading">
                  {t("wardrobe.items")}
                  <span>
                    {formatNumber(
                      language,
                      wardrobeCategory === "clothing"
                        ? AVATAR_CATALOG.clothing.length
                        : wardrobeCategory === "hair"
                          ? AVATAR_CATALOG.hair.length
                          : AVATAR_CATALOG.skinTones.length,
                    )}
                  </span>
                </p>
                {wardrobeCategory === "skin" ? (
                  <div className="wardrobe-skin-grid" role="group">
                    {AVATAR_CATALOG.skinTones.map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={`wardrobe-skin-choice ${wardrobeSkin === value ? "selected" : ""}`}
                        aria-label={avatarPartLabel(value, (word) =>
                          t(`avatarPart.${word}` as TranslationKey),
                        )}
                        aria-pressed={wardrobeSkin === value}
                        onClick={() => setWardrobeSkin(value)}
                      >
                        <span
                          className={`skin-swatch skin-${value}`}
                          aria-hidden="true"
                        />
                        <small>
                          {avatarPartLabel(value, (word) =>
                            t(`avatarPart.${word}` as TranslationKey),
                          )}
                        </small>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div
                    className="wardrobe-item-grid"
                    role="group"
                    aria-label={t("wardrobe.items")}
                  >
                    {(wardrobeCategory === "clothing"
                      ? AVATAR_CATALOG.clothing
                      : AVATAR_CATALOG.hair
                    ).map((value) => {
                      const selected =
                        wardrobeCategory === "clothing"
                          ? wardrobeClothing === value
                          : wardrobeHair === value;
                      const label = avatarPartLabel(
                        wardrobeCategory === "hair" ? value.slice(5) : value,
                        (word) => t(`avatarPart.${word}` as TranslationKey),
                      );
                      return (
                        <button
                          key={value}
                          type="button"
                          className={`wardrobe-item-choice ${selected ? "selected" : ""}`}
                          aria-label={`${label}${selected ? ` · ${t("wardrobe.selected")}` : ""}`}
                          aria-pressed={selected}
                          title={label}
                          onClick={() =>
                            wardrobeCategory === "clothing"
                              ? setWardrobeClothing(value)
                              : setWardrobeHair(value)
                          }
                        >
                          <Avatar
                            id={wardrobeAvatar}
                            size={52}
                            appearance={{
                              skin: wardrobeSkin,
                              clothing:
                                wardrobeCategory === "clothing"
                                  ? value
                                  : wardrobeClothing,
                              hair:
                                wardrobeCategory === "hair"
                                  ? value
                                  : wardrobeHair,
                            }}
                          />
                          <small>{label}</small>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
            <label className="wardrobe-field">
              {t("wardrobe.name")}
              <input
                autoComplete="nickname"
                maxLength={20}
                value={wardrobeName}
                onChange={(event) =>
                  setWardrobeName(
                    event.target.value.replace(/[\x00-\x1f\x7f]/g, ""),
                  )
                }
              />
            </label>
            <label className="wardrobe-field">
              {t("wardrobe.bio")}{" "}
              <span>{Array.from(wardrobeBio).length}/280</span>
              <textarea
                rows={3}
                maxLength={280}
                value={wardrobeBio}
                onChange={(event) => setWardrobeBio(event.target.value)}
              />
            </label>
            <div className="wardrobe-links">
              <div className="wardrobe-links-heading">
                <strong>{t("wardrobe.links")}</strong>
                <button
                  type="button"
                  disabled={wardrobeLinks.length >= 3}
                  onClick={() => setWardrobeLinks((links) => [...links, ""])}
                >
                  {t("wardrobe.links.add")}
                </button>
              </div>
              {wardrobeLinks.map((link, index) => (
                <div className="wardrobe-link-row" key={index}>
                  <input
                    type="url"
                    maxLength={512}
                    placeholder="https://example.com"
                    aria-label={t("wardrobe.links.label", {
                      index: formatNumber(language, index + 1),
                    })}
                    value={link}
                    onChange={(event) =>
                      setWardrobeLinks((links) =>
                        links.map((item, itemIndex) =>
                          itemIndex === index ? event.target.value : item,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("wardrobe.links.remove", {
                      index: formatNumber(language, index + 1),
                    })}
                    onClick={() =>
                      setWardrobeLinks((links) =>
                        links.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
            {wardrobeError && (
              <p className="wardrobe-error" role="alert">
                {wardrobeError}
              </p>
            )}
            <div className="wardrobe-actions">
              <button type="button" onClick={() => setWardrobeOpen(false)}>
                {t("group.create.cancel")}
              </button>
              <button type="submit" disabled={wardrobeBusy}>
                {wardrobeBusy ? t("wardrobe.saving") : t("wardrobe.save")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {activeBoard && (
        <Dialog
          title={activeBoard.title}
          close={() => setActiveBoard(undefined)}
        >
          <section className="space-board">
            <div
              className="space-board-tabs"
              role="group"
              aria-label={t("board.view")}
            >
              <button
                type="button"
                aria-pressed={boardMode === "posts"}
                onClick={() => setBoardMode("posts")}
              >
                {t("board.posts")}
              </button>
              <button
                type="button"
                aria-pressed={boardMode === "whiteboard"}
                onClick={() => setBoardMode("whiteboard")}
              >
                {t("whiteboard.label")}
              </button>
            </div>
            {boardMode === "whiteboard" ? (
              <SharedWhiteboard
                spaceId={bootstrap.space.id}
                boardId={activeBoard.id}
              />
            ) : (
              <>
                {activeBoard.description && (
                  <p className="space-board-description">
                    {activeBoard.description}
                  </p>
                )}
                {boardLoading ? (
                  <p className="space-board-empty" role="status">
                    {t("board.loading")}
                  </p>
                ) : boardPosts.length ? (
                  <ol
                    className="space-board-posts"
                    aria-label={t("board.posts")}
                    aria-live="polite"
                  >
                    {boardPosts.map((post) => (
                      <li key={post.id}>
                        <div className="space-board-post-meta">
                          <strong>
                            {post.authorName}
                            {post.own ? t("people.participant.self") : ""}
                          </strong>
                          <time
                            dateTime={new Date(post.createdAt).toISOString()}
                          >
                            {formatDate(language, post.createdAt, {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </time>
                        </div>
                        <p>{post.body}</p>
                        {post.deletable && (
                          <button
                            className="space-board-delete"
                            type="button"
                            disabled={boardBusy}
                            aria-label={t("board.deleteLabel", {
                              name: post.authorName,
                            })}
                            onClick={() => void removeBoardPost(post)}
                          >
                            <Trash2 size={14} /> {t("board.delete")}
                          </button>
                        )}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="space-board-empty">{t("board.empty")}</p>
                )}
                {boardError && (
                  <p className="space-board-error" role="alert">
                    {boardError}
                  </p>
                )}
                <form
                  className="space-board-compose"
                  onSubmit={(event) => void submitBoardPost(event)}
                >
                  <label>
                    {t("board.compose")}
                    <textarea
                      value={boardDraft}
                      maxLength={1000}
                      rows={3}
                      disabled={boardBusy}
                      placeholder={t("board.placeholder")}
                      onChange={(event) =>
                        setBoardDraft(
                          Array.from(event.target.value).slice(0, 500).join(""),
                        )
                      }
                    />
                  </label>
                  <div>
                    <small>
                      {t("board.characterCount", {
                        count: formatNumber(
                          language,
                          Array.from(boardDraft.trim()).length,
                        ),
                      })}{" "}
                      · {t("board.latestPosts")}
                    </small>
                    <button
                      type="submit"
                      disabled={boardBusy || !boardDraft.trim()}
                    >
                      {boardBusy
                        ? t("group.members.loading")
                        : t("board.publish")}
                    </button>
                  </div>
                </form>
              </>
            )}
          </section>
        </Dialog>
      )}
      {roomNoteDialogOpen && zone?.kind === "PRIVATE" && currentRoom && (
        <RoomNoteDialog
          key={currentRoom.zoneId}
          roomName={currentRoom.name}
          roomNote={state.roomNoteState}
          ack={state.lastRoomNoteAck}
          connection={connection}
          online={online}
          close={() => setRoomNoteDialogOpen(false)}
        />
      )}
      {objectInteraction && (
        <Dialog
          title={objectInteraction.title}
          close={() => setObjectInteraction(undefined)}
        >
          <div className="map-interaction-dialog">
            {objectInteraction.kind === "IMAGE" &&
              (interactionImageUrl ? (
                <img
                  className="map-interaction-image"
                  src={interactionImageUrl}
                  alt={objectInteraction.title}
                  decoding="async"
                />
              ) : (
                <p role="status">{t("mapInteraction.imageError")}</p>
              ))}
            {objectInteraction.body && <p>{objectInteraction.body}</p>}
            <button
              type="button"
              className="map-interaction-close"
              onClick={() => setObjectInteraction(undefined)}
            >
              {t("dialog.close")}
            </button>
          </div>
        </Dialog>
      )}
      {friendsDialogOpen && (
        <FriendsDialog
          close={() => setFriendsDialogOpen(false)}
          onChanged={() => void friendRefreshRef.current()}
        />
      )}
      {profileCardPlayer && (
        <Dialog
          title={t("people.profile.title", { name: profileCardPlayer.name })}
          close={() => setProfilePlayerId("")}
        >
          <ParticipantProfileCard
            player={profileCardPlayer}
            selfId={state.selfId}
            zoneName={
              profilePlayer
                ? (currentMap.zones.find(
                    (item) => item.id === profilePlayer.zoneId,
                  )?.name ?? t("people.participant.fallbackPlace"))
                : (spaceProfilePlayer?.mapName ??
                  t("people.profile.spaceFallback"))
            }
            online={online}
            blocked={state.blockedPlayerIds.includes(profileCardPlayer.id)}
            canMessage={
              profilePlayer?.directMessageEnabled ??
              spaceProfilePlayer?.directMessageEnabled ??
              false
            }
            canBlock={
              Boolean(session.userId) && profileCardPlayer.id !== state.selfId
            }
            canPoke={profilePlayer ? canPoke(profilePlayer) : false}
            canJoin={
              profilePlayer
                ? canRequestJoin(profilePlayer)
                : Boolean(
                    self?.status === "AVAILABLE" &&
                    spaceProfilePlayer?.status === "AVAILABLE" &&
                    !state.blockedPlayerIds.includes(profileCardPlayer.id),
                  )
            }
            friendState={
              friendRelationship(friendOverview, profileCardPlayer.id).state
            }
            canFriend={
              bootstrap.mode === "sso" &&
              Boolean(session.userId) &&
              profileCardPlayer.id !== state.selfId &&
              isAccountId(profileCardPlayer.id)
            }
            friendBusy={friendActionBusy}
            friendError={friendActionError}
            onClose={() => setProfilePlayerId("")}
            onMessage={() => {
              setProfilePlayerId("");
              requestDirectMessage(profileCardPlayer.id);
            }}
            onBlock={() =>
              connection.setBlocked(
                profileCardPlayer.id,
                !state.blockedPlayerIds.includes(profileCardPlayer.id),
              )
            }
            onPoke={() => {
              connection.poke(profileCardPlayer.id);
              setProfilePlayerId("");
            }}
            onJoin={() => {
              connection.requestJoin(profileCardPlayer.id);
              setProfilePlayerId("");
            }}
            onFriend={() => void performFriendAction(profileCardPlayer.id)}
          />
        </Dialog>
      )}
      {groupDialogOpen && (
        <Dialog
          title={t("group.create.title")}
          close={() => setGroupDialogOpen(false)}
        >
          <form
            className="group-dialog-form"
            onSubmit={submitGroupConversation}
          >
            <label className="group-name-field">
              <span>{t("group.create.name")}</span>
              <input
                autoFocus
                maxLength={32}
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder={t("group.create.placeholder")}
                required
              />
            </label>
            <fieldset className="group-member-picker">
              <legend>{t("group.create.participants")}</legend>
              <div className="group-member-list">
                {state.players
                  .filter(
                    (player) =>
                      player.id !== state.selfId &&
                      player.directMessageEnabled &&
                      !state.blockedPlayerIds.includes(player.id),
                  )
                  .map((player) => {
                    const checked = groupMemberIds.includes(player.id);
                    const atLimit = !checked && groupMemberIds.length >= 11;
                    return (
                      <label className="group-member-option" key={player.id}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={atLimit}
                          onChange={(event) => {
                            const selected = event.target.checked;
                            setGroupMemberIds((current) =>
                              selected
                                ? [...current, player.id]
                                : current.filter((id) => id !== player.id),
                            );
                          }}
                        />
                        <span
                          className={`participant-avatar color-${player.avatar}`}
                        >
                          <Avatar
                            id={player.avatar}
                            size={28}
                            appearance={player}
                          />
                        </span>
                        <span className="group-member-name">{player.name}</span>
                        <small>
                          {currentMap.zones.find(
                            (zone) => zone.id === player.zoneId,
                          )?.name ?? t("people.participant.fallbackPlace")}
                        </small>
                      </label>
                    );
                  })}
                {!state.players.some(
                  (player) =>
                    player.id !== state.selfId &&
                    player.directMessageEnabled &&
                    !state.blockedPlayerIds.includes(player.id),
                ) && <p className="muted small">{t("group.create.empty")}</p>}
              </div>
            </fieldset>
            <p className="group-dialog-note">{t("group.create.help")}</p>
            {directMessageError && (
              <p className="poke-feedback error" role="status">
                {directMessageError}
              </p>
            )}
            <div className="group-dialog-actions">
              <button
                type="button"
                className="group-cancel"
                onClick={() => setGroupDialogOpen(false)}
              >
                {t("group.create.cancel")}
              </button>
              <button
                className="group-create"
                type="submit"
                disabled={
                  !online ||
                  !groupName.trim() ||
                  groupMemberIds.length < 2 ||
                  groupMemberIds.length > 11
                }
              >
                {t("group.create.submit")} <ArrowRight size={15} />
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {reportTarget && (
        <Dialog
          title={t(
            reportTarget.kind === "PLAYER"
              ? "report.dialog.playerTitle"
              : "report.dialog.messageTitle",
          )}
          closeLabel={t("dialog.close")}
          close={() => {
            if (!reportBusy) {
              setReportTarget(null);
              setReportError("");
            }
          }}
        >
          <form
            className="group-dialog-form moderation-form"
            onSubmit={(event) => void submitMessageReport(event)}
          >
            {reportTarget.kind === "PLAYER" && (
              <p className="group-dialog-note">
                {t("report.playerNotice", { name: reportTarget.playerName })}
              </p>
            )}
            <label className="group-name-field">
              <span>{t("report.field.category")}</span>
              <select
                value={reportCategory}
                onChange={(event) =>
                  setReportCategory(event.target.value as ReportCategory)
                }
              >
                {Object.entries(reportCategoryKeys).map(([value, key]) => (
                  <option key={value} value={value}>
                    {t(key)}
                  </option>
                ))}
              </select>
            </label>
            <label className="group-name-field">
              <span>{t("report.field.details")}</span>
              <textarea
                value={reportDetails}
                maxLength={1000}
                rows={4}
                onChange={(event) => setReportDetails(event.target.value)}
                placeholder={t("report.detailsPlaceholder")}
              />
            </label>
            <p className="group-dialog-note">
              {reportTarget.kind === "MESSAGE"
                ? t("report.messagePrivacy")
                : t("report.playerLimits")}
            </p>
            {reportError && (
              <p className="poke-feedback error" role="alert">
                {reportError}
              </p>
            )}
            <div className="group-dialog-actions">
              <button
                type="button"
                className="group-cancel"
                onClick={() => setReportTarget(null)}
                disabled={reportBusy}
              >
                {t("report.cancel")}
              </button>
              <button
                className="group-create"
                type="submit"
                disabled={reportBusy}
              >
                {reportBusy ? t("report.submitting") : t("report.submit")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {moderationDialogOpen && (
        <Dialog
          title={t("moderation.title")}
          closeLabel={t("dialog.close")}
          close={() => setModerationDialogOpen(false)}
        >
          <div className="moderation-queue">
            <div
              className="moderation-filters"
              role="group"
              aria-label={t("moderation.filter.label")}
            >
              {(["OPEN", "REVIEWING", "RESOLVED", "DISMISSED"] as const).map(
                (status) => (
                  <button
                    key={status}
                    type="button"
                    className={
                      moderationStatusFilter === status ? "active" : ""
                    }
                    aria-pressed={moderationStatusFilter === status}
                    onClick={() => setModerationStatusFilter(status)}
                  >
                    {t(reportStatusKeys[status])}
                  </button>
                ),
              )}
            </div>
            {moderationError && (
              <p className="poke-feedback error" role="alert">
                {moderationError}
              </p>
            )}
            {moderationNotice && (
              <p className="poke-feedback success" role="status">
                {moderationNotice}
              </p>
            )}
            {moderationLoading ? (
              <p className="muted small">{t("moderation.loading")}</p>
            ) : (
              <div className="moderation-report-list">
                {moderationReports.map((report) => (
                  <article className="moderation-report" key={report.reportId}>
                    <header>
                      <strong>{t(reportCategoryKeys[report.category])}</strong>
                      <span>{t(reportStatusKeys[report.status])}</span>
                    </header>
                    <small>
                      {t("moderation.summary", {
                        reporter: report.reporterName,
                        targetType:
                          report.targetType === "GUEST"
                            ? t("moderation.guestPrefix")
                            : "",
                        target: report.targetName,
                        date: formatDate(language, report.createdAt, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }),
                      })}
                    </small>
                    <small>
                      {report.sourceType === "PLAYER"
                        ? t("moderation.source.player", {
                            spaceId:
                              report.spaceId ?? t("moderation.spaceMissing"),
                          })
                        : t("moderation.source.message")}
                    </small>
                    {report.evidenceText && (
                      <blockquote>{report.evidenceText}</blockquote>
                    )}
                    <p>{report.details || t("moderation.details.empty")}</p>
                    {(report.status === "OPEN" ||
                      report.status === "REVIEWING") && (
                      <>
                        <textarea
                          aria-label={t("moderation.reviewNote.label", {
                            reportId: report.reportId,
                          })}
                          maxLength={1000}
                          rows={2}
                          value={moderationNotes[report.reportId] ?? ""}
                          onChange={(event) =>
                            setModerationNotes((notes) => ({
                              ...notes,
                              [report.reportId]: event.target.value,
                            }))
                          }
                          placeholder={t("moderation.reviewNote.placeholder")}
                        />
                        <div className="moderation-actions">
                          {report.status === "OPEN" && (
                            <button
                              type="button"
                              disabled={!!moderationBusyReportId}
                              onClick={() =>
                                void updateModerationReport(report, "REVIEWING")
                              }
                            >
                              {t("moderation.action.startReview")}
                            </button>
                          )}
                          <select
                            aria-label={t("moderation.action.duration")}
                            value={
                              moderationMuteDurations[report.reportId] ?? 60
                            }
                            onChange={(event) =>
                              setModerationMuteDurations((durations) => ({
                                ...durations,
                                [report.reportId]: Number(event.target.value),
                              }))
                            }
                          >
                            <option value={10}>
                              {t("moderation.duration.minutes")}
                            </option>
                            <option value={60}>
                              {t("moderation.duration.hour")}
                            </option>
                            <option value={1440}>
                              {t("moderation.duration.day")}
                            </option>
                            <option value={10080}>
                              {t("moderation.duration.week")}
                            </option>
                          </select>
                          <button
                            type="button"
                            className="restrict"
                            disabled={!!moderationBusyReportId}
                            onClick={() => void applyChatMute(report)}
                          >
                            {t("moderation.action.chatMute")}
                          </button>
                          <button
                            type="button"
                            className="restrict"
                            disabled={!!moderationBusyReportId}
                            onClick={() => void applyMediaMute(report)}
                          >
                            {t("moderation.action.mediaMute")}
                          </button>
                          <button
                            type="button"
                            className="dismiss"
                            disabled={!!moderationBusyReportId}
                            onClick={() => void kickReportedAccount(report)}
                          >
                            {t("moderation.action.kick")}
                          </button>
                          <button
                            type="button"
                            className="resolve"
                            disabled={!!moderationBusyReportId}
                            onClick={() =>
                              void updateModerationReport(report, "RESOLVED")
                            }
                          >
                            {t("moderation.action.resolve")}
                          </button>
                          <button
                            type="button"
                            className="dismiss"
                            disabled={!!moderationBusyReportId}
                            onClick={() =>
                              void updateModerationReport(report, "DISMISSED")
                            }
                          >
                            {t("moderation.action.dismiss")}
                          </button>
                        </div>
                      </>
                    )}
                    {report.status === "RESOLVED" ||
                    report.status === "DISMISSED" ? (
                      <small className="moderation-review-note">
                        {report.reviewerName ??
                          t("moderation.review.defaultAdmin")}{" "}
                        · {report.reviewNote || t("moderation.review.noNote")}
                      </small>
                    ) : null}
                  </article>
                ))}
                {!moderationReports.length && (
                  <p className="muted small">{t("moderation.empty")}</p>
                )}
              </div>
            )}
          </div>
        </Dialog>
      )}
      {chatRetentionDialogOpen && moderationAccess && (
        <ChatRetentionSettingsDialog
          close={() => setChatRetentionDialogOpen(false)}
        />
      )}
      {productAnalyticsDialogOpen && moderationAccess && (
        <ProductAnalyticsDialog
          close={() => setProductAnalyticsDialogOpen(false)}
        />
      )}
      {inviteGroupConversationId && (
        <Dialog
          title={t("group.invite.title")}
          close={() => {
            if (!sendingGroupInvitation) setInviteGroupConversationId("");
          }}
        >
          <form className="group-invite-form" onSubmit={submitGroupInvitation}>
            <label>
              <span>{t("group.invite.participants")}</span>
              <select
                value={inviteTargetPlayerId}
                onChange={(event) =>
                  setInviteTargetPlayerId(event.target.value)
                }
                required
              >
                <option value="">{t("group.invite.choose")}</option>
                {state.players
                  .filter(
                    (player) =>
                      player.id !== state.selfId &&
                      player.directMessageEnabled &&
                      !state.blockedPlayerIds.includes(player.id),
                  )
                  .map((player) => (
                    <option key={player.id} value={player.id}>
                      {player.name}
                    </option>
                  ))}
              </select>
            </label>
            <p className="group-dialog-note">{t("group.invite.help")}</p>
            {directMessageError && (
              <p className="poke-feedback error" role="status">
                {directMessageError}
              </p>
            )}
            <div className="group-dialog-actions">
              <button
                type="button"
                className="group-cancel"
                onClick={() => setInviteGroupConversationId("")}
                disabled={sendingGroupInvitation}
              >
                {t("group.invite.cancel")}
              </button>
              <button
                className="group-create"
                type="submit"
                disabled={
                  !online || !inviteTargetPlayerId || sendingGroupInvitation
                }
              >
                {sendingGroupInvitation
                  ? t("group.invite.sending")
                  : t("group.invite.send")}{" "}
                <ArrowRight size={15} />
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {groupManagementConversationId && (
        <Dialog
          title={t("group.members.title")}
          close={() => {
            if (!groupManagementBusy) setGroupManagementConversationId("");
          }}
        >
          <div className="group-management">
            {groupManagementConversation?.owner ? (
              <form
                className="group-name-edit"
                onSubmit={(event) => void saveGroupName(event)}
              >
                <label>
                  <span>{t("group.members.name")}</span>
                  <input
                    value={groupNameDraft}
                    maxLength={32}
                    onChange={(event) => setGroupNameDraft(event.target.value)}
                    required
                  />
                </label>
                <button
                  type="submit"
                  disabled={groupManagementBusy || !groupNameDraft.trim()}
                >
                  {t("group.members.save")}
                </button>
              </form>
            ) : (
              <p className="group-dialog-note">
                {t("group.members.ownerHelp")}
              </p>
            )}
            {groupManagementError && (
              <p className="poke-feedback error" role="status">
                {groupManagementError}
              </p>
            )}
            {groupMembersLoading ? (
              <p className="muted small">{t("group.members.loading")}</p>
            ) : (
              <div className="group-managed-members">
                {groupMembers.map((member) => (
                  <div className="group-managed-member" key={member.memberId}>
                    <Avatar
                      id={member.avatar}
                      size={32}
                      appearance={{
                        skin: member.skin,
                        clothing: member.clothing,
                        hair: member.hair,
                      }}
                    />
                    <span>
                      <strong>
                        {member.displayName}
                        {member.self ? t("group.members.self") : ""}
                      </strong>
                      <small>
                        {member.owner
                          ? t("group.members.owner")
                          : t("group.members.member")}
                      </small>
                    </span>
                    {groupManagementConversation?.owner &&
                      !member.owner &&
                      !member.self && (
                        <button
                          type="button"
                          onClick={() => void kickGroupMember(member)}
                          disabled={groupManagementBusy}
                        >
                          {t("group.members.remove")}
                        </button>
                      )}
                  </div>
                ))}
                {!groupMembers.length && !groupManagementError && (
                  <p className="muted small">{t("group.members.empty")}</p>
                )}
              </div>
            )}
            <p className="group-dialog-note">
              {t("group.members.ownerTransfer")}
            </p>
            <div className="group-dialog-actions">
              <button
                type="button"
                className="group-cancel"
                onClick={() => setGroupManagementConversationId("")}
                disabled={groupManagementBusy}
              >
                {t("group.members.close")}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
