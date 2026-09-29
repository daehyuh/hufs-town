import type {
  ClientMessage,
  Join,
  ProfileUpdate,
  PlayerView,
  ServerMessage,
  Snapshot,
  MapDefinition,
  MediaState,
  MediaRequest,
  ChatEvent,
  PlayerReportRequest,
  PlayerReportAck,
  PokeAck,
  PokeEvent,
  PokePreferenceState,
  BlockAck,
  PresenceAck,
  JoinRequestAck,
  JoinRequestEvent,
  JoinResult,
  DirectConversationResult,
  GroupConversationRequest,
  GroupInvitationAck,
  GroupInvitationEvent,
  DirectMessageMutationAck,
  DirectMessageMutationEvent,
  DirectMessageReadAck,
  DirectMessageReadEvent,
  RoomActionAck,
  RoomKnockResult,
  RoomNoteAck,
  RoomNoteState,
  RoomRecordingAck,
  RoomRecordingRequest,
  RoomRecordingState,
  RoomView,
  EventAction,
  EventActionAck,
  EventState,
  EventEngagement,
  EventEngagementAck,
  EventEngagementState,
  SpaceParticipant,
  ProfileDetails,
} from "../generated/protocol";
import type { EmoteValue } from "./emoteOptions";
import { AuthError } from "../auth/client";
import { createUuid } from "../ids";
import { resolveWorldSocketUrl } from "./worldSocketUrl";
import type { TranslationKey } from "../i18n/language";
const SNAPSHOT_VIEW_NOTIFY_INTERVAL_MS = 250;
export type ConnectionStatus =
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline"
  | "closed";
export interface ConnectionView {
  status: ConnectionStatus;
  message: string;
  messageKey?: TranslationKey;
  worldFeatures: string[];
  players: PlayerView[];
  spaceParticipants: SpaceParticipant[];
  profileDetails: ProfileDetails | null;
  selfId: string;
  map?: MapDefinition;
  media?: MediaState;
  event?: EventState;
  engagement?: EventEngagementState;
  chatMessages: ChatLine[];
  chatHistoryPages: Record<string, ChatHistoryPage>;
  lastPokeAck: PokeAck | null;
  lastPokeEvent: PokeEvent | null;
  pokePreferenceState: PokePreferenceState | null;
  blockedPlayerIds: string[];
  lastBlockAck: BlockAck | null;
  lastPresenceAck: PresenceAck | null;
  joinRequests: JoinRequestEvent[];
  lastJoinRequestAck: JoinRequestAck | null;
  lastJoinResult: JoinResult | null;
  lastDirectConversationResult: DirectConversationResult | null;
  lastGroupInvitationAck: GroupInvitationAck | null;
  lastGroupInvitationEvent: GroupInvitationEvent | null;
  lastDirectMessageMutationAck: DirectMessageMutationAck | null;
  lastDirectMessageReadAck: DirectMessageReadAck | null;
  rooms: RoomView[];
  lastRoomActionAck: RoomActionAck | null;
  lastRoomKnockResult: RoomKnockResult | null;
  roomNoteState: RoomNoteState | null;
  lastRoomNoteAck: RoomNoteAck | null;
  roomRecordingState: RoomRecordingState | null;
  lastRoomRecordingAck: RoomRecordingAck | null;
  lastEventActionAck: EventActionAck | null;
  lastEventEngagementAck: EventEngagementAck | null;
}
export interface ChatHistoryPage {
  beforeId: string;
  hasMore: boolean;
  loading: boolean;
  error: TranslationKey | "";
  canReload: boolean;
}
export interface ChatLine extends Omit<ChatEvent, "type"> {
  delivery: "pending" | "sent" | "failed";
  history?: boolean;
  own?: boolean;
  error?: string;
  readByCount?: number;
}
export class MediaError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export class WorldConnection {
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private terminal = false;
  private profileUpdatePending = false;
  private profileRequestId = "";
  private attempts = 0;
  private generation = 0;
  private token = "";
  private epoch = 0;
  private seq = 0;
  private snapshotTick = -1;
  private replayedChatEpoch = -1;
  private listeners = new Set<() => void>();
  private snapshotListenerTimer?: ReturnType<typeof setTimeout>;
  private snapshots = new Set<(snapshot: Snapshot) => void>();
  private chatEvents = new Set<(message: ChatEvent) => void>();
  private pokeEvents = new Set<(event: PokeEvent) => void>();
  private loadedChatHistory = new Set<string>();
  private loadingChatHistory = new Set<string>();
  private directMessageReadCursors = new Map<
    string,
    Map<string, { messageId: string; sentAt: number }>
  >();
  private playerReportRequests = new Map<
    string,
    {
      resolve: (value: PlayerReportAck) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private mediaRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (e: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private roomRecordingRequests = new Map<string, string>();
  private view: ConnectionView = {
    status: "connecting",
    message: "",
    messageKey: undefined,
    worldFeatures: [],
    players: [],
    spaceParticipants: [],
    profileDetails: null,
    selfId: "",
    chatMessages: [],
    chatHistoryPages: {},
    lastPokeAck: null,
    lastPokeEvent: null,
    pokePreferenceState: null,
    blockedPlayerIds: [],
    lastBlockAck: null,
    lastPresenceAck: null,
    joinRequests: [],
    lastJoinRequestAck: null,
    lastJoinResult: null,
    lastDirectConversationResult: null,
    lastGroupInvitationAck: null,
    lastGroupInvitationEvent: null,
    lastDirectMessageMutationAck: null,
    lastDirectMessageReadAck: null,
    rooms: [],
    lastRoomActionAck: null,
    lastRoomKnockResult: null,
    roomNoteState: null,
    lastRoomNoteAck: null,
    roomRecordingState: null,
    lastRoomRecordingAck: null,
    lastEventActionAck: null,
    lastEventEngagementAck: null,
  };
  private pokesEnabled = (() => {
    try {
      return localStorage.getItem("hufs-town.allow-pokes") !== "false";
    } catch {
      return true;
    }
  })();
  constructor(
    private path: string,
    private name: string,
    private avatar: number,
    private revision: string,
    private admit?: (
      resumeToken: string,
    ) => Promise<string | { ticket: string; worldUrl?: string }>,
    private userId = "",
    private spaceId = "",
    private skin = "light",
    private clothing = "casual_white",
    private hair = "hair_short_black",
    private bio = "",
    private links: string[] = [],
    initialPokesAllowed?: boolean,
    initialResumeToken = "",
  ) {
    // Preview profiles live in this browser, so reapply their bio and links
    // after each join. SSO profiles come from the authenticated server session.
    this.profileUpdatePending = !userId;
    this.token = initialResumeToken;
    if (initialPokesAllowed !== undefined)
      this.pokesEnabled = initialPokesAllowed;
  }
  getResumeToken() {
    return this.token;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.view;
  onSnapshot(listener: (snapshot: Snapshot) => void) {
    this.snapshots.add(listener);
    return () => {
      this.snapshots.delete(listener);
    };
  }
  onChatEvent(listener: (message: ChatEvent) => void) {
    this.chatEvents.add(listener);
    return () => {
      this.chatEvents.delete(listener);
    };
  }
  onPokeEvent(listener: (event: PokeEvent) => void) {
    this.pokeEvents.add(listener);
    return () => {
      this.pokeEvents.delete(listener);
    };
  }
  private update(patch: Partial<ConnectionView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  // Keep the latest positions available immediately. Phaser receives every
  // snapshot through onSnapshot; React panels only need the coalesced view.
  private updateFromSnapshot(
    players: PlayerView[],
    rooms: RoomView[],
    zoneChanged: boolean,
  ) {
    this.view = {
      ...this.view,
      players,
      rooms,
      ...(zoneChanged
        ? {
            roomNoteState: null,
            lastRoomNoteAck: null,
            roomRecordingState: null,
            lastRoomRecordingAck: null,
          }
        : {}),
    };
    if (this.snapshotListenerTimer !== undefined) return;
    this.snapshotListenerTimer = setTimeout(() => {
      this.snapshotListenerTimer = undefined;
      this.listeners.forEach((fn) => fn());
    }, SNAPSHOT_VIEW_NOTIFY_INTERVAL_MS);
  }
  async connect() {
    this.rejectMedia();
    this.rejectPlayerReports(
      new Error("월드 연결이 바뀌어 신고 요청이 취소됐어요."),
    );
    this.roomRecordingRequests.clear();
    const generation = ++this.generation;
    clearTimeout(this.timer);
    clearTimeout(this.snapshotListenerTimer);
    this.snapshotListenerTimer = undefined;
    const previous = this.socket;
    this.socket = undefined;
    previous?.close();
    this.stopped = false;
    this.terminal = false;
    this.profileRequestId = "";
    this.update({
      status: this.token ? "reconnecting" : "connecting",
      message: "",
      messageKey: undefined,
      worldFeatures: [],
      profileDetails: null,
      media: undefined,
      event: undefined,
      joinRequests: [],
      rooms: [],
      lastRoomKnockResult: null,
      roomNoteState: null,
      lastRoomNoteAck: null,
      roomRecordingState: null,
      lastRoomRecordingAck: null,
      lastEventActionAck: null,
      lastEventEngagementAck: null,
    });
    let ticket: string | undefined;
    let worldUrl = "";
    try {
      const admission = this.admit ? await this.admit(this.token) : undefined;
      if (typeof admission === "string") ticket = admission;
      else if (admission) {
        ticket = admission.ticket;
        worldUrl = admission.worldUrl ?? "";
      }
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      if (
        error instanceof AuthError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        this.terminal = true;
        this.update({
          status: "offline",
          message: error.message,
          messageKey:
            error.status === 401
              ? "connection.message.authRequired"
              : error.status === 403
                ? "connection.message.accessDenied"
                : "connection.message.serverError",
        });
      } else this.reconnect();
      return;
    }
    if (this.stopped || generation !== this.generation) return;
    const ws = new WebSocket(
      resolveWorldSocketUrl(
        worldUrl,
        this.path,
        `${location.protocol}//${location.host}${location.pathname || "/"}`,
      ),
      ticket ? ["hufs-town-v2", `hufs-ticket.${ticket}`] : [],
    );
    this.socket = ws;
    ws.onopen = () => {
      if (this.socket === ws && !this.stopped)
        this.send({
          type: "join",
          protocolVersion: 2,
          name: this.name,
          avatar: this.avatar,
          skin: this.skin as Join["skin"],
          clothing: this.clothing,
          hair: this.hair,
          resumeToken: this.token,
        });
    };
    ws.onmessage = (event) => {
      if (this.socket !== ws || this.stopped) return;
      const data = JSON.parse(event.data) as ServerMessage;
      if (data.type === "blockAck") {
        this.update({ lastBlockAck: data });
      } else if (data.type === "presenceAck") {
        this.update({ lastPresenceAck: data });
      } else if (data.type === "spaceParticipants") {
        this.update({ spaceParticipants: data.participants });
      } else if (
        data.type === "profileDetails" &&
        data.requestId === this.profileRequestId
      ) {
        this.update({ profileDetails: data });
      } else if (data.type === "joinRequestAck") {
        this.update({ lastJoinRequestAck: data });
      } else if (data.type === "joinRequestEvent") {
        this.update({
          joinRequests: [
            ...this.view.joinRequests.filter(
              (item) => item.requestId !== data.requestId,
            ),
            data,
          ].slice(-4),
        });
      } else if (data.type === "joinResult") {
        this.update({ lastJoinResult: data });
      } else if (data.type === "roomActionAck") {
        this.update({ lastRoomActionAck: data });
      } else if (data.type === "roomKnockResult") {
        this.update({ lastRoomKnockResult: data });
        window.setTimeout(() => {
          if (this.view.lastRoomKnockResult?.requestId === data.requestId)
            this.update({ lastRoomKnockResult: null });
        }, 5000);
      } else if (data.type === "roomNoteAck") {
        if (data.zoneId === this.currentZoneId())
          this.update({ lastRoomNoteAck: data });
      } else if (data.type === "roomNoteState") {
        if (data.zoneId !== this.currentZoneId()) return;
        const current = this.view.roomNoteState;
        if (!current || data.revision >= current.revision)
          this.update({ roomNoteState: data });
      } else if (data.type === "roomRecordingAck") {
        const zoneId = this.roomRecordingRequests.get(data.requestId);
        if (!zoneId) return;
        this.roomRecordingRequests.delete(data.requestId);
        if (zoneId === this.currentZoneId())
          this.update({ lastRoomRecordingAck: data });
      } else if (data.type === "roomRecordingState") {
        if (data.zoneId !== this.currentZoneId()) return;
        this.update({ roomRecordingState: data });
      } else if (data.type === "eventActionAck") {
        this.update({ lastEventActionAck: data });
        window.setTimeout(() => {
          if (this.view.lastEventActionAck?.requestId === data.requestId)
            this.update({ lastEventActionAck: null });
        }, 5000);
      } else if (data.type === "eventState") {
        this.update({ event: data });
      } else if (data.type === "eventEngagementAck") {
        this.update({ lastEventEngagementAck: data });
        window.setTimeout(() => {
          if (this.view.lastEventEngagementAck?.requestId === data.requestId)
            this.update({ lastEventEngagementAck: null });
        }, 5000);
      } else if (data.type === "eventEngagementState") {
        this.update({ engagement: data });
      } else if (data.type === "directConversationResult") {
        this.update({ lastDirectConversationResult: data });
      } else if (data.type === "groupInvitationAck") {
        this.update({ lastGroupInvitationAck: data });
      } else if (data.type === "groupInvitationEvent") {
        this.update({ lastGroupInvitationEvent: data });
      } else if (data.type === "directMessageMutationAck") {
        this.update({ lastDirectMessageMutationAck: data });
      } else if (data.type === "directMessageReadAck") {
        this.update({ lastDirectMessageReadAck: data });
      } else if (data.type === "directMessageMutationEvent") {
        const chatMessages = this.view.chatMessages.map((line) =>
          line.channel === "dm" &&
          line.conversationId === data.conversationId &&
          line.messageId === data.messageId &&
          line.revision <= data.revision
            ? {
                ...line,
                text: data.text,
                revision: data.revision,
                editedAt: data.editedAt,
                deleted: data.deleted,
              }
            : line,
        );
        this.update({ chatMessages: retainLoadedHistory(chatMessages) });
      } else if (data.type === "directMessageReadEvent") {
        const cursors =
          this.directMessageReadCursors.get(data.conversationId) ??
          new Map<string, { messageId: string; sentAt: number }>();
        const current = cursors.get(data.readerMemberId);
        if (!current || compareReadCursor(data, current) > 0) {
          cursors.set(data.readerMemberId, {
            messageId: data.messageId,
            sentAt: data.sentAt,
          });
          this.directMessageReadCursors.set(data.conversationId, cursors);
          this.update({
            chatMessages: retainLoadedHistory(
              this.withDirectReadCounts(this.view.chatMessages),
            ),
          });
        }
      } else if (data.type === "blockState") {
        this.update({ blockedPlayerIds: data.playerIds });
      } else if (data.type === "pokeAck") {
        this.update({ lastPokeAck: data });
      } else if (data.type === "playerReportAck") {
        const pending = this.playerReportRequests.get(data.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.playerReportRequests.delete(data.requestId);
          pending.resolve(data);
        }
      } else if (data.type === "pokePreferenceState") {
        this.update({ pokePreferenceState: data });
      } else if (data.type === "pokeEvent") {
        this.update({ lastPokeEvent: data });
        this.pokeEvents.forEach((listener) => listener(data));
      } else if (data.type === "mediaState") {
        this.update({ media: data });
      } else if (data.type === "chatAck") {
        this.update({
          chatMessages: this.view.chatMessages.map((line) =>
            line.clientMessageId === data.clientMessageId
              ? {
                  ...line,
                  delivery: data.accepted ? "sent" : "failed",
                  error: data.accepted ? undefined : data.message,
                }
              : line,
          ),
        });
      } else if (data.type === "chatEvent") {
        const current = this.view.chatMessages;
        const key = chatLineKey(data);
        const existing = current.find((line) => chatLineKey(line) === key);
        const line: ChatLine = {
          ...data,
          delivery: "sent",
          history: existing?.history,
          own: existing?.own,
        };
        const chatMessages = existing
          ? current.map((item) => (chatLineKey(item) === key ? line : item))
          : [...current, line];
        this.update({
          chatMessages: retainLoadedHistory(
            this.withDirectReadCounts(chatMessages),
          ),
        });
        if (!existing || existing.delivery !== "sent")
          this.chatEvents.forEach((listener) => listener(data));
      } else if (data.type === "mediaReply") {
        const pending = this.mediaRequests.get(data.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.mediaRequests.delete(data.requestId);
          if (data.ok) {
            try {
              pending.resolve(JSON.parse(data.dataJson));
            } catch {
              pending.reject(
                new MediaError("MEDIA_INVALID", "통화 응답을 읽을 수 없어요."),
              );
            }
          } else pending.reject(new MediaError(data.code, data.message));
        }
      } else if (data.type === "mapChanged") {
        this.revision = data.map.revision;
        this.snapshotTick = -1;
        this.update({
          map: data.map,
          players: [],
          roomNoteState: null,
          lastRoomNoteAck: null,
          roomRecordingState: null,
          lastRoomRecordingAck: null,
        });
      } else if (data.type === "welcome") {
        if (data.protocolVersion !== 2 || data.mapRevision !== this.revision) {
          this.terminal = true;
          this.update({
            status: "offline",
            message: "지도가 변경되었습니다. 나갔다가 다시 입장해 주세요.",
            messageKey: "connection.message.mapChanged",
          });
          ws.close();
          return;
        }
        this.token = data.resumeToken;
        this.epoch = data.epoch;
        this.update({ worldFeatures: data.features ?? [] });
        this.seq = 0;
        this.snapshotTick = -1;
        this.replayedChatEpoch = -1;
        this.attempts = 0;
        this.send({
          type: "pokePreference",
          epoch: this.epoch,
          enabled: this.pokesEnabled,
        });
        this.loadedChatHistory.clear();
        this.update({
          status: "online",
          selfId: data.playerId,
          message: "",
          messageKey: undefined,
          blockedPlayerIds: [],
          lastBlockAck: null,
          lastPresenceAck: null,
          event: undefined,
          roomNoteState: null,
          lastRoomNoteAck: null,
          lastEventActionAck: null,
          lastEventEngagementAck: null,
          engagement: undefined,
        });
        this.sendPendingProfileUpdate();
      } else if (data.type === "snapshot") {
        if (data.mapRevision !== this.revision) return;
        if (data.tick <= this.snapshotTick) return;
        let players: PlayerView[];
        if (data.full) players = data.players;
        else {
          if (data.baseTick !== this.snapshotTick) {
            this.send({ type: "snapshotAck", tick: data.tick, applied: false });
            return;
          }
          const merged = new Map(
            this.view.players.map((player) => [player.id, player]),
          );
          data.removedPlayerIds.forEach((id) => merged.delete(id));
          data.players.forEach((player) => merged.set(player.id, player));
          players = [...merged.values()];
        }
        this.snapshotTick = data.tick;
        const applied: Snapshot = {
          ...data,
          full: true,
          baseTick: data.tick,
          players,
          removedPlayerIds: [],
        };
        const previousSelfZoneId = this.currentZoneId();
        const nextSelfZoneId =
          players.find((player) => player.id === this.view.selfId)?.zoneId ??
          "";
        const zoneChanged = previousSelfZoneId !== nextSelfZoneId;
        this.updateFromSnapshot(players, data.rooms ?? [], zoneChanged);
        this.snapshots.forEach((fn) => fn(applied));
        this.send({ type: "snapshotAck", tick: data.tick, applied: true });
        if (data.full && this.replayedChatEpoch !== this.epoch) {
          this.replayedChatEpoch = this.epoch;
          for (const line of this.view.chatMessages) {
            // A server restart can expire the old player ID while preserving the account's pending UI rows.
            if (line.delivery !== "pending" || line.history) continue;
            this.send({
              type: "chatSend",
              clientMessageId: line.clientMessageId,
              epoch: this.epoch,
              channel: line.channel,
              conversationId: line.conversationId,
              text: line.text,
            });
          }
        }
      } else if (data.type === "error") {
        this.terminal = true;
        this.update({
          status: "offline",
          message: data.message,
          messageKey: "connection.message.serverError",
        });
        ws.close();
      }
    };
    ws.onclose = () => {
      if (this.socket === ws) this.rejectMedia();
      if (this.stopped || this.socket !== ws || this.terminal) return;
      this.reconnect();
    };
  }
  private reconnect() {
    if (this.attempts >= 5) {
      this.update({
        status: "offline",
        message:
          "서버에 연결할 수 없어요. 서버 상태를 확인한 후 다시 연결해 주세요.",
        messageKey: "connection.message.offline",
      });
      return;
    }
    this.update({
      status: "reconnecting",
      message: "연결이 끊겼어요. 같은 위치로 다시 연결하고 있어요.",
      messageKey: "connection.message.reconnecting",
    });
    this.timer = setTimeout(
      () => this.connect(),
      Math.min(500 * 2 ** this.attempts++, 4000),
    );
  }
  private send(message: ClientMessage) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }
  private currentZoneId() {
    return (
      this.view.players.find((player) => player.id === this.view.selfId)
        ?.zoneId ?? ""
    );
  }
  loadRoomNote() {
    const zoneId = this.currentZoneId();
    if (this.view.status !== "online" || !zoneId) return false;
    const requestId = createUuid();
    this.update({ lastRoomNoteAck: null });
    return this.send({
      type: "roomNoteRequest",
      requestId,
      epoch: this.epoch,
      action: "LOAD",
      baseRevision: 0,
      body: "",
    })
      ? requestId
      : false;
  }
  saveRoomNote(body: string, baseRevision: number) {
    const zoneId = this.currentZoneId();
    if (
      this.view.status !== "online" ||
      !zoneId ||
      !Number.isInteger(baseRevision) ||
      baseRevision < 0 ||
      [...body].length > 4000 ||
      this.view.roomNoteState?.zoneId !== zoneId
    )
      return false;
    const requestId = createUuid();
    this.update({ lastRoomNoteAck: null });
    return this.send({
      type: "roomNoteRequest",
      requestId,
      epoch: this.epoch,
      action: "SAVE",
      baseRevision,
      body,
    })
      ? requestId
      : false;
  }
  requestRoomRecording(
    zoneId: string,
    action: RoomRecordingRequest["action"],
    recordingId = "",
    sources: RoomRecordingRequest["sources"] = [],
    accepted = false,
    transcribe = false,
  ) {
    if (
      this.view.status !== "online" ||
      !zoneId ||
      this.currentZoneId() !== zoneId ||
      (action === "START" && (recordingId !== "" || sources.length === 0)) ||
      (action !== "START" && (!recordingId || sources.length > 0))
    )
      return false;
    const requestId = createUuid();
    const request: RoomRecordingRequest = {
      type: "roomRecordingRequest",
      requestId,
      epoch: this.epoch,
      zoneId,
      action,
      recordingId: action === "START" ? "" : recordingId,
      sources: action === "START" ? [...new Set(sources)] : [],
      ...(action === "START" && transcribe ? { transcribe: true } : {}),
      accepted: action === "CONSENT" && accepted,
    };
    this.update({ lastRoomRecordingAck: null });
    this.roomRecordingRequests.set(requestId, zoneId);
    if (!this.send(request)) {
      this.roomRecordingRequests.delete(requestId);
      return false;
    }
    return requestId;
  }
  mediaRequest<T>(
    policyEpoch: number,
    method: MediaRequest["method"],
    data: object,
  ): Promise<T> {
    if (
      this.view.status !== "online" ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return Promise.reject(
        new MediaError("MEDIA_UNAVAILABLE", "월드 연결을 기다리고 있어요."),
      );
    if (this.mediaRequests.size >= 8)
      return Promise.reject(
        new MediaError("MEDIA_BUSY", "통화 요청을 준비하고 있어요."),
      );
    const dataJson = JSON.stringify(data);
    if (dataJson.length > 32768)
      return Promise.reject(
        new MediaError("MEDIA_INVALID", "통화 요청이 너무 커요."),
      );
    const requestId = createUuid();
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.mediaRequests.delete(requestId);
        reject(new MediaError("MEDIA_TIMEOUT", "통화 연결 시간이 초과됐어요."));
      }, 5000);
      this.mediaRequests.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.send({
        type: "mediaRequest",
        requestId,
        policyEpoch,
        method,
        dataJson,
      });
    });
  }
  private rejectMedia() {
    for (const p of this.mediaRequests.values()) {
      clearTimeout(p.timeout);
      p.reject(new MediaError("MEDIA_UNAVAILABLE", "월드 연결이 바뀌었어요."));
    }
    this.mediaRequests.clear();
  }
  private rejectPlayerReports(error: Error) {
    for (const pending of this.playerReportRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.playerReportRequests.clear();
  }
  move(dx: number, dy: number, running: boolean) {
    if (this.view.status !== "online") return undefined;
    const seq = this.seq;
    const sent = this.send({
      type: "move",
      epoch: this.epoch,
      seq,
      dx,
      dy,
      running,
    });
    if (!sent) return undefined;
    this.seq++;
    return seq;
  }
  updateProfile(
    name: string,
    avatar: number,
    appearance: { skin: string; clothing: string; hair: string },
    bio: string,
    links: string[],
  ) {
    this.name = name;
    this.avatar = avatar;
    this.skin = appearance.skin;
    this.clothing = appearance.clothing;
    this.hair = appearance.hair;
    this.bio = bio;
    this.links = [...links];
    this.profileUpdatePending = true;
    this.sendPendingProfileUpdate();
  }
  private sendPendingProfileUpdate() {
    if (!this.profileUpdatePending || this.view.status !== "online") return;
    const update: ProfileUpdate = {
      type: "profileUpdate",
      epoch: this.epoch,
      name: this.name,
      avatar: this.avatar,
      skin: this.skin as ProfileUpdate["skin"],
      clothing: this.clothing,
      hair: this.hair,
      bio: this.bio,
      links: [...this.links],
    };
    if (this.send(update)) this.profileUpdatePending = false;
  }
  emote(emoji: EmoteValue) {
    if (this.view.status === "online")
      this.send({ type: "emote", epoch: this.epoch, emoji });
  }
  getPokesEnabled() {
    return this.pokesEnabled;
  }
  setPokesEnabled(enabled: boolean) {
    this.pokesEnabled = enabled;
    try {
      localStorage.setItem("hufs-town.allow-pokes", String(enabled));
    } catch {
      // Session preference still applies for this connection if storage is unavailable.
    }
    if (this.view.status === "online")
      this.send({
        type: "pokePreference",
        epoch: this.epoch,
        enabled,
      });
  }
  setMicrophoneOn(enabled: boolean) {
    if (this.view.status !== "online") return false;
    return this.send({ type: "microphoneSet", epoch: this.epoch, enabled });
  }
  poke(targetId: string) {
    if (this.view.status !== "online") return false;
    const requestId = createUuid();
    const sent = this.send({
      type: "poke",
      requestId,
      epoch: this.epoch,
      targetId,
    });
    if (sent) this.update({ lastPokeAck: null });
    return sent;
  }
  reportPlayer(
    targetId: string,
    category: PlayerReportRequest["category"],
    details: string,
  ): Promise<PlayerReportAck> {
    if (this.view.status !== "online")
      return Promise.reject(new Error("월드에 연결한 뒤 다시 신고해 주세요."));
    const requestId = createUuid();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.playerReportRequests.delete(requestId);
        reject(
          new Error("신고 결과를 받지 못했어요. 잠시 후 다시 시도해 주세요."),
        );
      }, 10_000);
      this.playerReportRequests.set(requestId, { resolve, reject, timeout });
      const sent = this.send({
        type: "playerReportRequest",
        requestId,
        epoch: this.epoch,
        targetId,
        category,
        details,
      });
      if (!sent) {
        clearTimeout(timeout);
        this.playerReportRequests.delete(requestId);
        reject(new Error("신고 요청을 보내지 못했어요. 다시 시도해 주세요."));
      }
    });
  }
  setBlocked(targetId: string, blocked: boolean) {
    if (this.view.status !== "online") return false;
    const sent = this.send({
      type: "blockAction",
      requestId: createUuid(),
      epoch: this.epoch,
      targetId,
      blocked,
    });
    if (sent) this.update({ lastBlockAck: null });
    return sent;
  }
  setPresence(status: "AVAILABLE" | "AWAY" | "DND") {
    if (this.view.status !== "online") return false;
    const sent = this.send({
      type: "presenceSet",
      requestId: createUuid(),
      epoch: this.epoch,
      status,
    });
    if (sent) this.update({ lastPresenceAck: null });
    return sent;
  }
  requestJoin(targetId: string) {
    if (this.view.status !== "online") return false;
    const sent = this.send({
      type: "joinRequest",
      requestId: createUuid(),
      epoch: this.epoch,
      targetId,
    });
    if (sent) this.update({ lastJoinRequestAck: null, lastJoinResult: null });
    return sent;
  }
  requestProfile(targetId: string) {
    if (this.view.status !== "online" || !targetId) return false;
    const requestId = createUuid();
    this.profileRequestId = requestId;
    const sent = this.send({
      type: "profileRequest",
      requestId,
      epoch: this.epoch,
      targetId,
    });
    this.update({ profileDetails: null });
    if (!sent) this.profileRequestId = "";
    return sent;
  }
  respondToJoinRequest(requestId: string, accepted: boolean) {
    if (this.view.status !== "online") return false;
    const sent = this.send({
      type: "joinResponse",
      requestId,
      epoch: this.epoch,
      accepted,
    });
    if (sent)
      this.update({
        joinRequests: this.view.joinRequests.filter(
          (item) => item.requestId !== requestId,
        ),
      });
    return sent;
  }
  setRoomLocked(zoneId: string, locked: boolean, capacity: number) {
    if (this.view.status !== "online") return false;
    this.update({ lastRoomActionAck: null });
    return this.send({
      type: "roomAction",
      requestId: createUuid(),
      epoch: this.epoch,
      zoneId,
      action: locked ? "LOCK" : "UNLOCK",
      capacity,
      targetPlayerId: "",
    });
  }
  setRoomCapacity(zoneId: string, capacity: number) {
    if (this.view.status !== "online") return false;
    this.update({ lastRoomActionAck: null });
    return this.send({
      type: "roomAction",
      requestId: createUuid(),
      epoch: this.epoch,
      zoneId,
      action: "SET_CAPACITY",
      capacity,
      targetPlayerId: "",
    });
  }
  kickRoomMember(zoneId: string, targetPlayerId: string, capacity: number) {
    if (this.view.status !== "online") return false;
    this.update({ lastRoomActionAck: null });
    return this.send({
      type: "roomAction",
      requestId: createUuid(),
      epoch: this.epoch,
      zoneId,
      action: "KICK",
      capacity,
      targetPlayerId,
    });
  }
  respondToRoomKnock(zoneId: string, knockId: string, accepted: boolean) {
    if (this.view.status !== "online") return false;
    return this.send({
      type: "roomKnockResponse",
      requestId: createUuid(),
      epoch: this.epoch,
      zoneId,
      knockId,
      accepted,
    });
  }
  eventAction(
    action: EventAction["action"],
    targetPlayerId = "",
    title = "",
    description = "",
    resourceUrl = "",
    attendanceEnabled = false,
  ) {
    if (this.view.status !== "online") return false;
    this.update({ lastEventActionAck: null });
    return this.send({
      type: "eventAction",
      epoch: this.epoch,
      requestId: createUuid(),
      action,
      targetPlayerId,
      title,
      description,
      resourceUrl,
      attendanceEnabled,
    });
  }
  eventEngagement(
    action: EventEngagement["action"],
    text = "",
    questionId = "",
    pollQuestion = "",
    pollOptions: string[] = [],
    optionIndex = 0,
    correctOptionIndex = 0,
  ) {
    if (this.view.status !== "online") return false;
    this.update({ lastEventEngagementAck: null });
    return this.send({
      type: "eventEngagement",
      epoch: this.epoch,
      requestId: createUuid(),
      action,
      questionId,
      text,
      pollQuestion,
      pollOptions,
      optionIndex,
      correctOptionIndex,
    });
  }
  expireJoinRequests() {
    const now = Date.now();
    this.update({
      joinRequests: this.view.joinRequests.filter(
        (item) => item.expiresAt > now,
      ),
    });
  }
  requestDirectConversation(targetPlayerId: string) {
    if (this.view.status !== "online") return false;
    this.update({ lastDirectConversationResult: null });
    return this.send({
      type: "directConversationRequest",
      requestId: createUuid(),
      epoch: this.epoch,
      targetPlayerId,
    });
  }
  requestGroupConversation(memberPlayerIds: string[], groupName: string) {
    if (this.view.status !== "online") return false;
    this.update({ lastDirectConversationResult: null });
    const request: GroupConversationRequest = {
      type: "groupConversationRequest",
      requestId: createUuid(),
      epoch: this.epoch,
      memberPlayerIds,
      groupName: groupName.trim(),
    };
    return this.send(request);
  }
  requestGroupInvitation(conversationId: string, targetPlayerId: string) {
    if (this.view.status !== "online") return false;
    this.update({ lastGroupInvitationAck: null });
    return this.send({
      type: "groupInvitationRequest",
      requestId: createUuid(),
      epoch: this.epoch,
      conversationId,
      targetPlayerId,
    });
  }
  sendChat(
    text: string,
    channel: "nearby" | "room" | "space" | "dm",
    zoneId: string,
    conversationId = "",
  ) {
    const normalized = text.trim();
    if (
      this.view.status !== "online" ||
      !normalized ||
      [...normalized].length > 500
    )
      return false;
    const clientMessageId = createUuid();
    const player = this.view.players.find(
      (item) => item.id === this.view.selfId,
    );
    const pending: ChatLine = {
      messageId: clientMessageId,
      clientMessageId,
      channel,
      conversationId,
      senderId: this.view.selfId,
      senderName: player?.name ?? this.name,
      avatar: player?.avatar ?? this.avatar,
      skin: (player?.skin ?? this.skin) as Join["skin"],
      clothing: player?.clothing ?? this.clothing,
      hair: player?.hair ?? this.hair,
      text: normalized,
      sentAt: Date.now(),
      zoneId,
      revision: 0,
      editedAt: 0,
      deleted: false,
      delivery: "pending",
    };
    const sent = this.send({
      type: "chatSend",
      clientMessageId,
      epoch: this.epoch,
      channel,
      conversationId,
      text: normalized,
    });
    if (!sent) return false;
    this.update({
      chatMessages: retainLoadedHistory([...this.view.chatMessages, pending]),
    });
    return true;
  }
  mutateDirectMessage(
    conversationId: string,
    messageId: string,
    action: "EDIT" | "DELETE",
    text = "",
  ) {
    const normalized = action === "EDIT" ? text.trim() : "";
    if (
      this.view.status !== "online" ||
      !conversationId ||
      !messageId ||
      (action === "EDIT" && (!normalized || [...normalized].length > 500))
    )
      return false;
    this.update({ lastDirectMessageMutationAck: null });
    return this.send({
      type: "directMessageMutationRequest",
      epoch: this.epoch,
      requestId: createUuid(),
      conversationId,
      messageId,
      action,
      text: normalized,
    });
  }
  markDirectMessageRead(conversationId: string, messageId: string) {
    if (
      this.view.status !== "online" ||
      !this.userId ||
      !conversationId ||
      !messageId
    )
      return false;
    this.update({ lastDirectMessageReadAck: null });
    return this.send({
      type: "directMessageReadRequest",
      epoch: this.epoch,
      requestId: createUuid(),
      conversationId,
      messageId,
    });
  }
  async loadChatHistory(channel: "nearby" | "room" | "space", zoneId: string) {
    if (!this.userId || !this.spaceId || this.view.status !== "online") return;
    const key = chatHistoryKey(channel, zoneId);
    const query = new URLSearchParams({ channel, limit: "50" });
    if (channel === "room") query.set("zoneId", zoneId);
    const url = `/api/v1/spaces/${encodeURIComponent(this.spaceId)}/chat?${query}`;
    await this.loadInitialHistory(key, url);
  }
  async loadDirectMessageHistory(conversationId: string) {
    if (!this.userId || !conversationId || this.view.status !== "online")
      return;
    const query = new URLSearchParams({ limit: "50" });
    await this.loadInitialHistory(
      `dm:${conversationId}`,
      `/api/v1/dms/${encodeURIComponent(conversationId)}/messages?${query}`,
    );
  }
  async loadOlderChatHistory(
    channel: "nearby" | "room" | "space",
    zoneId: string,
  ) {
    if (!this.spaceId) return;
    const key = chatHistoryKey(channel, zoneId);
    const query = new URLSearchParams({ channel, limit: "50" });
    if (channel === "room") query.set("zoneId", zoneId);
    await this.loadOlderHistoryPage(
      key,
      `/api/v1/spaces/${encodeURIComponent(this.spaceId)}/chat`,
      query,
    );
  }
  async loadOlderDirectMessageHistory(conversationId: string) {
    if (!conversationId) return;
    await this.loadOlderHistoryPage(
      `dm:${conversationId}`,
      `/api/v1/dms/${encodeURIComponent(conversationId)}/messages`,
      new URLSearchParams({ limit: "50" }),
    );
  }
  private async loadInitialHistory(key: string, url: string) {
    if (this.loadedChatHistory.has(key) || this.loadingChatHistory.has(key))
      return;
    this.loadingChatHistory.add(key);
    this.setChatHistoryPage(key, {
      beforeId: "",
      hasMore: false,
      loading: true,
      error: "",
      canReload: false,
    });
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("chat.history.error.load");
      const entries = (await response.json()) as Array<
        Omit<ChatEvent, "type"> & { own: boolean; readByCount?: number }
      >;
      const history = entries.map(
        (entry): ChatLine => ({
          ...entry,
          delivery: "sent",
          history: true,
          own: entry.own,
          readByCount: entry.readByCount ?? 0,
        }),
      );
      this.loadedChatHistory.add(key);
      this.update({
        chatMessages: retainLoadedHistory(
          this.withDirectReadCounts(
            mergeHistory(this.view.chatMessages, history),
          ),
        ),
        chatHistoryPages: {
          ...this.view.chatHistoryPages,
          [key]: {
            beforeId: history[0]?.messageId ?? "",
            hasMore: entries.length === 50,
            loading: false,
            error: "",
            canReload: false,
          },
        },
      });
    } catch {
      this.setChatHistoryPage(key, {
        beforeId: "",
        hasMore: false,
        loading: false,
        error: "chat.history.error.load",
        canReload: true,
      });
    } finally {
      this.loadingChatHistory.delete(key);
      const current = this.view.chatHistoryPages[key];
      if (current?.loading)
        this.setChatHistoryPage(key, { ...current, loading: false });
    }
  }
  private async loadOlderHistoryPage(
    key: string,
    url: string,
    query: URLSearchParams,
  ) {
    const page = this.view.chatHistoryPages[key];
    if (
      !page?.hasMore ||
      !page.beforeId ||
      !this.userId ||
      this.view.status !== "online" ||
      this.loadingChatHistory.has(key)
    )
      return;
    this.loadingChatHistory.add(key);
    this.setChatHistoryPage(key, { ...page, loading: true, error: "" });
    query.set("beforeId", page.beforeId);
    try {
      const response = await fetch(`${url}?${query}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        const expired = response.status === 400;
        const inaccessible = response.status === 404;
        const error: TranslationKey = expired
          ? "chat.history.error.expired"
          : inaccessible
            ? "chat.history.error.accessDenied"
            : "chat.history.error.load";
        if (expired) {
          this.loadedChatHistory.delete(key);
          this.update({
            chatMessages: this.view.chatMessages.filter(
              (line) => !line.history || !chatHistoryContains(key, line),
            ),
            chatHistoryPages: {
              ...this.view.chatHistoryPages,
              [key]: {
                beforeId: "",
                hasMore: false,
                loading: false,
                error,
                canReload: true,
              },
            },
          });
        } else {
          this.setChatHistoryPage(key, {
            ...page,
            hasMore: !inaccessible,
            loading: false,
            error,
            canReload: false,
          });
        }
        return;
      }
      const entries = (await response.json()) as Array<
        Omit<ChatEvent, "type"> & { own: boolean; readByCount?: number }
      >;
      const history = entries.map(
        (entry): ChatLine => ({
          ...entry,
          delivery: "sent",
          history: true,
          own: entry.own,
          readByCount: entry.readByCount ?? 0,
        }),
      );
      this.update({
        chatMessages: retainLoadedHistory(
          this.withDirectReadCounts(
            mergeHistory(this.view.chatMessages, history),
          ),
        ),
        chatHistoryPages: {
          ...this.view.chatHistoryPages,
          [key]: {
            beforeId: history[0]?.messageId ?? page.beforeId,
            hasMore: entries.length === 50,
            loading: false,
            error: "",
            canReload: false,
          },
        },
      });
    } catch {
      this.setChatHistoryPage(key, {
        ...page,
        loading: false,
        error: "chat.history.error.load",
        canReload: false,
      });
    } finally {
      this.loadingChatHistory.delete(key);
      const current = this.view.chatHistoryPages[key];
      if (current?.loading)
        this.setChatHistoryPage(key, { ...current, loading: false });
    }
  }
  private setChatHistoryPage(key: string, page: ChatHistoryPage) {
    this.update({
      chatHistoryPages: { ...this.view.chatHistoryPages, [key]: page },
    });
  }
  private withDirectReadCounts(lines: ChatLine[]) {
    return lines.map((line) => {
      if (
        line.channel !== "dm" ||
        (!line.own && line.senderId !== this.view.selfId)
      )
        return line;
      const cursors = this.directMessageReadCursors.get(line.conversationId);
      if (!cursors?.size) return line;
      const liveCount = [...cursors.values()].filter(
        (cursor) => compareReadCursor(cursor, line) >= 0,
      ).length;
      return {
        ...line,
        readByCount: Math.max(line.readByCount ?? 0, liveCount),
      };
    });
  }
  retry() {
    clearTimeout(this.timer);
    this.attempts = 0;
    this.socket?.close();
    this.connect();
  }
  disconnect() {
    this.rejectMedia();
    this.rejectPlayerReports(
      new Error("월드에서 나가 신고 요청이 취소됐어요."),
    );
    this.roomRecordingRequests.clear();
    this.generation++;
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.snapshotListenerTimer);
    this.snapshotListenerTimer = undefined;
    this.socket?.close();
    this.update({
      status: "closed",
      players: [],
      roomNoteState: null,
      lastRoomNoteAck: null,
      roomRecordingState: null,
      lastRoomRecordingAck: null,
    });
  }
}

export function chatHistoryKey(
  channel: "nearby" | "room" | "space" | "dm",
  zoneId = "",
  conversationId = "",
) {
  return channel === "dm"
    ? `dm:${conversationId}`
    : `chat:${channel === "room" ? `${channel}:${zoneId}` : channel}`;
}

function chatHistoryContains(key: string, line: ChatLine) {
  return chatHistoryKey(line.channel, line.zoneId, line.conversationId) === key;
}

function compareReadCursor(
  left: Pick<DirectMessageReadEvent, "messageId" | "sentAt">,
  right: Pick<DirectMessageReadEvent, "messageId" | "sentAt">,
) {
  if (left.sentAt !== right.sentAt) return left.sentAt - right.sentAt;
  return left.messageId === right.messageId
    ? 0
    : left.messageId < right.messageId
      ? -1
      : 1;
}

function mergeHistory(current: ChatLine[], history: ChatLine[]) {
  const merged = new Map(current.map((line) => [chatLineKey(line), line]));
  for (const entry of history) {
    const key = chatLineKey(entry);
    const existing = merged.get(key);
    if (existing && !existing.history && existing.delivery === "sent")
      merged.set(key, {
        ...existing,
        history: true,
        own: entry.own,
        readByCount: Math.max(
          existing.readByCount ?? 0,
          entry.readByCount ?? 0,
        ),
      });
    else merged.set(key, entry);
  }
  return [...merged.values()].sort(
    (left, right) =>
      left.sentAt - right.sentAt ||
      left.messageId.localeCompare(right.messageId),
  );
}

function retainLoadedHistory(messages: ChatLine[]) {
  const loaded = messages.filter((line) => line.history);
  const recent = messages.filter((line) => !line.history).slice(-100);
  const merged = new Map<string, ChatLine>();
  for (const line of [...loaded, ...recent])
    merged.set(chatLineKey(line), line);
  return [...merged.values()].sort(
    (left, right) =>
      left.sentAt - right.sentAt ||
      left.messageId.localeCompare(right.messageId),
  );
}

function chatLineKey(
  line: Pick<ChatLine, "channel" | "conversationId" | "clientMessageId">,
) {
  return line.channel === "dm"
    ? `dm:${line.conversationId}:${line.clientMessageId}`
    : `${line.channel}:${line.clientMessageId}`;
}
