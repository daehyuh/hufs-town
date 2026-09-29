// Generated from contracts/world.schema.json. Do not edit.
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface MapObject {
  id: string;
  asset: string;
  x: number;
  y: number;
  scale: number;
  direction?: "down" | "left" | "up" | "right";
  interaction?: MapInteraction;
}
export interface MapInteraction {
  kind: "NOTICE" | "LINK" | "VIDEO" | "IMAGE" | "BOARD" | "NPC" | "SOUND" | "SCAVENGER_ITEM";
  title: string;
  body?: string;
  url?: string;
  assetId?: string;
  radius?: number;
  volume?: number;
}
export interface Zone {
  id: string;
  name: string;
  kind: "PRIVATE" | "SILENT" | "PUBLIC" | "STAGE";
  bounds: Rect;
  capacity?: number;
}
export interface MapDefinition {
  schemaVersion: 2;
  id: string;
  revision: string;
  name: string;
  width: number;
  height: number;
  spawnX: number;
  spawnY: number;
  collisions: Array<Rect>;
  objects: Array<MapObject>;
  zones: Array<Zone>;
  floors: Array<FloorPatch>;
  walls: Array<Wall>;
  labels: Array<MapLabel>;
  portals?: Array<Portal>;
}
export interface Join {
  type: "join";
  protocolVersion: 2;
  name: string;
  avatar: number;
  skin: "black" | "blue" | "dark" | "green" | "light" | "medium" | "purple" | "red" | "white" | "yellow";
  clothing: string;
  hair: string;
  resumeToken: string;
}
export interface ProfileUpdate {
  type: "profileUpdate";
  epoch: number;
  name: string;
  avatar: number;
  skin: "black" | "blue" | "dark" | "green" | "light" | "medium" | "purple" | "red" | "white" | "yellow";
  clothing: string;
  hair: string;
  bio: string;
  links: Array<string>;
}
export interface ProfileRequest {
  type: "profileRequest";
  epoch: number;
  requestId: string;
  targetId: string;
}
export interface Move {
  type: "move";
  epoch: number;
  seq: number;
  dx: number;
  dy: number;
  running: boolean;
}
export interface Emote {
  type: "emote";
  epoch: number;
  emoji: "wave" | "heart" | "clap" | "sparkles" | "laugh" | "thumbsup" | "sad" | "sit" | "party" | "thinking" | "hands" | "wow" | "fire";
}
export interface PresenceSet {
  type: "presenceSet";
  epoch: number;
  requestId: string;
  status: "AVAILABLE" | "AWAY" | "DND";
}
export interface MicrophoneSet {
  type: "microphoneSet";
  epoch: number;
  enabled: boolean;
}
export interface PresenceAck {
  type: "presenceAck";
  requestId: string;
  status: "AVAILABLE" | "AWAY" | "DND";
  accepted: boolean;
  code: string;
  message: string;
}
export interface Poke {
  type: "poke";
  epoch: number;
  requestId: string;
  targetId: string;
}
export interface PlayerReportRequest {
  type: "playerReportRequest";
  epoch: number;
  requestId: string;
  targetId: string;
  category: "HARASSMENT" | "THREAT" | "SPAM" | "PERSONAL_INFO" | "OTHER";
  details: string;
}
export interface PokePreference {
  type: "pokePreference";
  epoch: number;
  enabled: boolean;
}
export interface BlockAction {
  type: "blockAction";
  epoch: number;
  requestId: string;
  targetId: string;
  blocked: boolean;
}
export interface JoinRequest {
  type: "joinRequest";
  epoch: number;
  requestId: string;
  targetId: string;
}
export interface JoinResponse {
  type: "joinResponse";
  epoch: number;
  requestId: string;
  accepted: boolean;
}
export interface JoinRequestAck {
  type: "joinRequestAck";
  requestId: string;
  targetId: string;
  accepted: boolean;
  code: string;
  message: string;
}
export interface JoinRequestEvent {
  type: "joinRequestEvent";
  requestId: string;
  senderId: string;
  senderName: string;
  expiresAt: number;
}
export interface RoomKnock {
  knockId: string;
  playerId: string;
  playerName: string;
  expiresAt: number;
}
export interface RoomView {
  zoneId: string;
  name: string;
  locked: boolean;
  capacity: number;
  occupants: number;
  hostPlayerId: string;
  pendingKnocks: Array<RoomKnock>;
}
export interface RoomAction {
  type: "roomAction";
  requestId: string;
  epoch: number;
  zoneId: string;
  action: "LOCK" | "UNLOCK" | "SET_CAPACITY" | "KICK";
  capacity: number;
  targetPlayerId: string;
}
export interface RoomKnockResponse {
  type: "roomKnockResponse";
  requestId: string;
  epoch: number;
  zoneId: string;
  knockId: string;
  accepted: boolean;
}
export interface RoomActionAck {
  type: "roomActionAck";
  requestId: string;
  zoneId: string;
  accepted: boolean;
  locked: boolean;
  capacity: number;
  code: string;
  message: string;
}
export interface RoomKnockEvent {
  type: "roomKnockEvent";
  knockId: string;
  zoneId: string;
  playerId: string;
  playerName: string;
  expiresAt: number;
}
export interface RoomKnockResult {
  type: "roomKnockResult";
  requestId: string;
  zoneId: string;
  accepted: boolean;
  code: string;
  message: string;
}
export interface RoomNoteRequest {
  type: "roomNoteRequest";
  requestId: string;
  epoch: number;
  action: "LOAD" | "SAVE";
  baseRevision: number;
  body: string;
}
export interface RoomNoteRevision {
  revision: number;
  authorName: string;
  editedAt: number;
}
export interface RoomNoteState {
  type: "roomNoteState";
  zoneId: string;
  revision: number;
  body: string;
  updatedAt: number;
  updatedBy: string;
  meetingEndedAt: number;
  retentionExpiresAt: number;
  history: Array<RoomNoteRevision>;
}
export interface RoomNoteAck {
  type: "roomNoteAck";
  requestId: string;
  zoneId: string;
  accepted: boolean;
  revision: number;
  code: string;
  message: string;
}
export interface EventAction {
  type: "eventAction";
  epoch: number;
  requestId: string;
  action: "START" | "STOP" | "GRANT_SPEAKER" | "REVOKE_SPEAKER" | "RAISE_HAND" | "LOWER_HAND";
  targetPlayerId: string;
  title: string;
  description: string;
  resourceUrl: string;
  attendanceEnabled: boolean;
}
export interface EventActionAck {
  type: "eventActionAck";
  requestId: string;
  action: string;
  accepted: boolean;
  code: string;
  message: string;
}
export interface EventParticipant {
  playerId: string;
  name: string;
  mapId: string;
  mapName: string;
}
export interface SpaceParticipant {
  playerId: string;
  name: string;
  avatar: number;
  skin: "black" | "blue" | "dark" | "green" | "light" | "medium" | "purple" | "red" | "white" | "yellow";
  clothing: string;
  hair: string;
  status: "AVAILABLE" | "AWAY" | "DND";
  mapId: string;
  mapName: string;
  directMessageEnabled: boolean;
  allowPokes: boolean;
}
export interface SpaceParticipants {
  type: "spaceParticipants";
  revision: number;
  participants: Array<SpaceParticipant>;
}
export interface ProfileDetails {
  type: "profileDetails";
  requestId: string;
  playerId: string;
  accepted: boolean;
  bio: string;
  links: Array<string>;
  code: string;
  message: string;
}
export interface EventState {
  type: "eventState";
  active: boolean;
  eventId: string;
  startedAt: number;
  attendanceEnabled: boolean;
  attendancePersistent: boolean;
  attendeeCount: number;
  title: string;
  description: string;
  resourceUrl: string;
  hostPlayerId: string;
  speakerPlayerIds: Array<string>;
  raisedHandPlayerIds: Array<string>;
  participants: Array<EventParticipant>;
}
export interface EventQuestion {
  id: string;
  askerPlayerId: string;
  askerName: string;
  text: string;
  answered: boolean;
  answer: string;
  answererName: string;
}
export interface EventEngagement {
  type: "eventEngagement";
  epoch: number;
  requestId: string;
  action: "ASK_QUESTION" | "ANSWER_QUESTION" | "CREATE_POLL" | "CREATE_QUIZ" | "VOTE_POLL" | "CLOSE_POLL" | "START_SCAVENGER_HUNT" | "STOP_SCAVENGER_HUNT" | "SCAVENGER_TALK" | "COLLECT_SCAVENGER_ITEM";
  questionId: string;
  text: string;
  pollQuestion: string;
  pollOptions: Array<string>;
  optionIndex: number;
  correctOptionIndex: number;
}
export interface EventEngagementAck {
  type: "eventEngagementAck";
  requestId: string;
  action: string;
  accepted: boolean;
  itemId: string;
  code: string;
  message: string;
}
export interface EventQuizScore {
  name: string;
  score: number;
}
export interface EventScavengerItem {
  objectId: string;
  title: string;
  clue: string;
}
export interface EventEngagementState {
  type: "eventEngagementState";
  active: boolean;
  questions: Array<EventQuestion>;
  pollId: string;
  pollQuestion: string;
  pollOptions: Array<string>;
  pollCounts: Array<number>;
  pollClosed: boolean;
  pollMode: "POLL" | "QUIZ";
  pollCorrectOptionIndex: number;
  pollMyOptionIndex: number;
  myQuizScore: number;
  quizScores: Array<EventQuizScore>;
  scavengerConfigured: boolean;
  scavengerActive: boolean;
  scavengerMapId: string;
  scavengerMapName: string;
  scavengerAvailableItems: number;
  scavengerAvailableNpcs: number;
  scavengerUnlocked: boolean;
  scavengerItems: Array<EventScavengerItem>;
  scavengerMyCollectedObjectIds: Array<string>;
  scavengerMyScore: number;
  scavengerCompleted: boolean;
  scavengerScores: Array<EventQuizScore>;
}
export interface JoinResult {
  type: "joinResult";
  requestId: string;
  targetId: string;
  accepted: boolean;
  moved: boolean;
  destinationMapId: string;
  code: string;
  message: string;
}
export interface DirectConversationRequest {
  type: "directConversationRequest";
  epoch: number;
  requestId: string;
  targetPlayerId: string;
}
export interface GroupConversationRequest {
  type: "groupConversationRequest";
  epoch: number;
  requestId: string;
  memberPlayerIds: Array<string>;
  groupName: string;
}
export interface GroupInvitationRequest {
  type: "groupInvitationRequest";
  epoch: number;
  requestId: string;
  conversationId: string;
  targetPlayerId: string;
}
export interface GroupInvitationAck {
  type: "groupInvitationAck";
  requestId: string;
  invitationId: string;
  conversationId: string;
  targetPlayerId: string;
  accepted: boolean;
  code: string;
  message: string;
}
export interface GroupInvitationEvent {
  type: "groupInvitationEvent";
  invitationId: string;
  conversationId: string;
  groupName: string;
  inviterName: string;
  expiresAt: number;
}
export interface DirectConversationResult {
  type: "directConversationResult";
  requestId: string;
  targetPlayerId: string;
  accepted: boolean;
  conversationId: string;
  code: string;
  message: string;
}
export interface ChatSend {
  type: "chatSend";
  clientMessageId: string;
  epoch: number;
  channel: "nearby" | "room" | "space" | "dm";
  conversationId: string;
  text: string;
}
export interface DirectMessageMutationRequest {
  type: "directMessageMutationRequest";
  epoch: number;
  requestId: string;
  conversationId: string;
  messageId: string;
  action: "EDIT" | "DELETE";
  text: string;
}
export interface DirectMessageMutationAck {
  type: "directMessageMutationAck";
  requestId: string;
  conversationId: string;
  messageId: string;
  accepted: boolean;
  revision: number;
  code: string;
  message: string;
}
export interface DirectMessageMutationEvent {
  type: "directMessageMutationEvent";
  conversationId: string;
  messageId: string;
  text: string;
  revision: number;
  editedAt: number;
  deleted: boolean;
}
export interface DirectMessageReadRequest {
  type: "directMessageReadRequest";
  epoch: number;
  requestId: string;
  conversationId: string;
  messageId: string;
}
export interface DirectMessageReadAck {
  type: "directMessageReadAck";
  requestId: string;
  conversationId: string;
  messageId: string;
  accepted: boolean;
  code: string;
  message: string;
}
export interface DirectMessageReadEvent {
  type: "directMessageReadEvent";
  conversationId: string;
  messageId: string;
  sentAt: number;
  readerMemberId: string;
}
export interface ChatAck {
  type: "chatAck";
  clientMessageId: string;
  accepted: boolean;
  code: string;
  message: string;
}
export interface ChatEvent {
  type: "chatEvent";
  messageId: string;
  clientMessageId: string;
  channel: "nearby" | "room" | "space" | "dm";
  conversationId: string;
  senderId: string;
  senderName: string;
  avatar: number;
  skin: "black" | "blue" | "dark" | "green" | "light" | "medium" | "purple" | "red" | "white" | "yellow";
  clothing: string;
  hair: string;
  text: string;
  sentAt: number;
  zoneId: string;
  revision: number;
  editedAt: number;
  deleted: boolean;
}
export interface PokeAck {
  type: "pokeAck";
  requestId: string;
  targetId: string;
  accepted: boolean;
  code: string;
  message: string;
}
export interface PlayerReportAck {
  type: "playerReportAck";
  requestId: string;
  targetId: string;
  accepted: boolean;
  code: string;
  message: string;
}
export interface PokePreferenceState {
  type: "pokePreferenceState";
  enabled: boolean;
}
export interface PokeEvent {
  type: "pokeEvent";
  requestId: string;
  senderId: string;
  senderName: string;
  targetId: string;
  sentAt: number;
}
export interface BlockAck {
  type: "blockAck";
  requestId: string;
  targetId: string;
  blocked: boolean;
  accepted: boolean;
  code: string;
  message: string;
}
export interface BlockState {
  type: "blockState";
  playerIds: Array<string>;
}
export interface PlayerView {
  id: string;
  name: string;
  avatar: number;
  skin: "black" | "blue" | "dark" | "green" | "light" | "medium" | "purple" | "red" | "white" | "yellow";
  clothing: string;
  hair: string;
  x: number;
  y: number;
  direction: "down" | "up" | "left" | "right";
  moving: boolean;
  zoneId: string;
  emoji: string;
  emojiUntil: number;
  sitting: boolean;
  status: "AVAILABLE" | "AWAY" | "DND";
  microphoneOn?: boolean;
  directMessageEnabled: boolean;
  bio?: string;
  links?: Array<string>;
  eventManager?: boolean;
}
export interface Welcome {
  type: "welcome";
  protocolVersion: 2;
  playerId: string;
  resumeToken: string;
  epoch: number;
  mapRevision: string;
  tickMs: number;
  features?: Array<"PARTICIPANT_REPORTS" | "PERSISTENT_SIT" | "EXTENDED_EMOTES" | "ROOM_NOTES" | "ROOM_RECORDING" | "SCAVENGER_HUNT" | "MICROPHONE_PRESENCE">;
}
export interface Snapshot {
  type: "snapshot";
  tick: number;
  serverTime: number;
  full: boolean;
  baseTick: number;
  inputAckSeq: number;
  players: Array<PlayerView>;
  removedPlayerIds: Array<string>;
  mapRevision: string;
  rooms: Array<RoomView>;
}
export interface SnapshotAck {
  type: "snapshotAck";
  tick: number;
  applied: boolean;
}
export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}
export interface FloorPatch {
  id: string;
  material: "OAK" | "WOOD" | "CARPET_BLUE" | "CARPET_SAGE" | "TILE" | "CONCRETE" | "GRASS" | "PAVERS";
  bounds: Rect;
}
export interface Wall {
  id: string;
  material: "CREAM" | "SAGE" | "GLASS";
  bounds: Rect;
}
export interface MapLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  link?: string;
}
export interface Portal {
  id: string;
  name: string;
  bounds: Rect;
  targetSpaceId: string;
  targetMapId?: string;
  targetSpawnX?: number;
  targetSpawnY?: number;
}
export interface MapChanged {
  type: "mapChanged";
  map: MapDefinition;
}
export interface MediaOffer {
  id: string;
  playerId: string;
  source: "MICROPHONE" | "CAMERA" | "SCREEN" | "SCREEN_AUDIO";
  kind: "audio" | "video";
}
export interface MediaState {
  type: "mediaState";
  policyEpoch: number;
  domain: string;
  kind: string;
  available: boolean;
  transitioning: boolean;
  limited: boolean;
  proximityEnterDistance: number;
  proximityExitDistance: number;
  moderatedSources: Array<"MICROPHONE" | "CAMERA" | "SCREEN" | "SCREEN_AUDIO">;
  peers: Array<string>;
  offers: Array<MediaOffer>;
  engineId: string;
  eventMode: boolean;
  eventSpeaker: boolean;
  eventTitle: string;
}
export interface MediaRequest {
  type: "mediaRequest";
  requestId: string;
  policyEpoch: number;
  method: "capabilities" | "createTransport" | "connectTransport" | "produce" | "closeProducer" | "consume" | "resumeConsumer" | "closeConsumer" | "setPreferredLayers" | "stats";
  dataJson: string;
}
export interface MediaReply {
  type: "mediaReply";
  requestId: string;
  ok: boolean;
  dataJson: string;
  code: string;
  message: string;
}
export interface RoomRecordingRequest {
  type: "roomRecordingRequest";
  requestId: string;
  epoch: number;
  zoneId: string;
  action: "START" | "CONSENT" | "WITHDRAW" | "STOP";
  recordingId: string;
  sources: Array<"MICROPHONE" | "CAMERA" | "SCREEN" | "SCREEN_AUDIO">;
  transcribe?: boolean;
  accepted: boolean;
}
export interface RoomRecordingParticipant {
  playerId: string;
  name: string;
  decision: "PENDING" | "ACCEPTED" | "DECLINED" | "WITHDRAWN";
  respondedAt: number;
}
export interface RoomRecordingState {
  type: "roomRecordingState";
  recordingId: string;
  zoneId: string;
  status: "AWAITING_CONSENT" | "STARTING" | "RECORDING" | "STOPPING" | "STOPPED" | "DECLINED" | "FAILED" | "EXPIRED";
  sources: Array<"MICROPHONE" | "CAMERA" | "SCREEN" | "SCREEN_AUDIO">;
  requestedByPlayerId: string;
  requestedByName: string;
  requestedAt: number;
  startedAt: number;
  endedAt: number;
  retentionDays: number;
  trackCount: number;
  failureCode?: string;
  transcribe?: boolean;
  participants: Array<RoomRecordingParticipant>;
}
export interface RoomRecordingAck {
  type: "roomRecordingAck";
  requestId: string;
  recordingId: string;
  accepted: boolean;
  status: string;
  code: string;
  message: string;
}
export type ServerMessage =
  | Welcome
  | Snapshot
  | ErrorMessage
  | MapChanged
  | MediaState
  | MediaReply
  | ChatAck
  | ChatEvent
  | DirectMessageMutationAck
  | DirectMessageMutationEvent
  | DirectMessageReadAck
  | DirectMessageReadEvent
  | PokeAck
  | PlayerReportAck
  | PokePreferenceState
  | PokeEvent
  | BlockAck
  | BlockState
  | PresenceAck
  | JoinRequestAck
  | JoinRequestEvent
  | JoinResult
  | DirectConversationResult
  | GroupInvitationAck
  | GroupInvitationEvent
  | RoomActionAck
  | RoomKnockEvent
  | RoomKnockResult
  | RoomNoteState
  | RoomNoteAck
  | RoomRecordingAck
  | RoomRecordingState
  | EventActionAck
  | EventState
  | EventEngagementAck
  | EventEngagementState
  | SpaceParticipants
  | ProfileDetails;
export type ClientMessage =
  | Join
  | ProfileUpdate
  | ProfileRequest
  | Move
  | SnapshotAck
  | Emote
  | PresenceSet
  | MicrophoneSet
  | Poke
  | PlayerReportRequest
  | PokePreference
  | BlockAction
  | JoinRequest
  | JoinResponse
  | RoomAction
  | RoomKnockResponse
  | RoomNoteRequest
  | RoomRecordingRequest
  | MediaRequest
  | ChatSend
  | DirectMessageMutationRequest
  | DirectMessageReadRequest
  | DirectConversationRequest
  | GroupConversationRequest
  | GroupInvitationRequest
  | EventAction
  | EventEngagement;
