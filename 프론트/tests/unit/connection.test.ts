import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.stubGlobal("location", {
  pathname: "/",
  protocol: "http:",
  host: "localhost:5173",
});
const { WorldConnection } = await import("../../src/game/WorldConnection");
const { AuthError } = await import("../../src/auth/client");
class Socket {
  static OPEN = 1;
  static made: Socket[] = [];
  readyState = 1;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  sent: string[] = [];
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    Socket.made.push(this);
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  Socket.made = [];
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
it("accepts a published map and ignores snapshots from its previous revision", async () => {
  const connection = new WorldConnection(
    "/world/socket",
    "친구",
    0,
    "old",
    async () => "ticket",
  );
  await connection.connect();
  const socket = Socket.made[0];
  socket.onopen?.();
  const receive = (data: object) =>
    socket.onmessage?.({ data: JSON.stringify(data) });
  receive({ type: "mapChanged", map: { revision: "new" } });
  receive({
    type: "welcome",
    protocolVersion: 2,
    mapRevision: "new",
    playerId: "me",
    resumeToken: "resume",
    epoch: 2,
  });
  receive({
    type: "snapshot",
    mapRevision: "old",
    tick: 1,
    full: true,
    players: [{ id: "stale" }],
    rooms: [],
  });
  expect(connection.getSnapshot().players).toEqual([]);
  receive({
    type: "snapshot",
    mapRevision: "new",
    tick: 2,
    full: true,
    players: [{ id: "current" }],
    rooms: [],
  });
  expect(connection.getSnapshot().players[0].id).toBe("current");
  expect(connection.getSnapshot().map?.revision).toBe("new");
  connection.disconnect();
});
it("keeps microphone presence through full and delta world snapshots", async () => {
  const connection = new WorldConnection("/world/socket", "친구", 0, "rev");
  await connection.connect();
  const socket = Socket.made[0];
  socket.onopen?.();
  const receive = (data: object) =>
    socket.onmessage?.({ data: JSON.stringify(data) });
  receive({
    type: "welcome",
    protocolVersion: 2,
    mapRevision: "rev",
    playerId: "me",
    resumeToken: "resume",
    epoch: 1,
  });
  receive({
    type: "snapshot",
    mapRevision: "rev",
    tick: 1,
    full: true,
    players: [
      { id: "me", microphoneOn: false },
      { id: "friend", microphoneOn: true },
    ],
    rooms: [],
  });
  expect(connection.getSnapshot().players).toEqual([
    expect.objectContaining({ id: "me", microphoneOn: false }),
    expect.objectContaining({ id: "friend", microphoneOn: true }),
  ]);

  receive({
    type: "snapshot",
    mapRevision: "rev",
    tick: 2,
    baseTick: 1,
    full: false,
    players: [{ id: "friend", microphoneOn: false }],
    removedPlayerIds: [],
    rooms: [],
  });
  expect(connection.getSnapshot().players).toEqual([
    expect.objectContaining({ id: "me", microphoneOn: false }),
    expect.objectContaining({ id: "friend", microphoneOn: false }),
  ]);
  connection.disconnect();
});
it("streams every game snapshot while coalescing React view notifications", async () => {
  const connection = new WorldConnection("/world/socket", "친구", 0, "rev");
  await connection.connect();
  const socket = Socket.made[0];
  socket.onopen?.();
  const receive = (data: object) =>
    socket.onmessage?.({ data: JSON.stringify(data) });
  receive({
    type: "welcome",
    protocolVersion: 2,
    mapRevision: "rev",
    playerId: "me",
    resumeToken: "resume",
    epoch: 1,
  });

  const viewChanged = vi.fn();
  const gameSnapshot = vi.fn();
  connection.subscribe(viewChanged);
  connection.onSnapshot(gameSnapshot);
  const players = [{ id: "me", zoneId: "public-area", x: 1, y: 1 }];
  receive({
    type: "snapshot",
    mapRevision: "rev",
    tick: 1,
    full: true,
    players,
    rooms: [],
  });
  receive({
    type: "snapshot",
    mapRevision: "rev",
    tick: 2,
    full: false,
    baseTick: 1,
    players: [{ ...players[0], x: 2 }],
    removedPlayerIds: [],
    rooms: [],
  });

  expect(gameSnapshot).toHaveBeenCalledTimes(2);
  expect(connection.getSnapshot().players[0].x).toBe(2);
  expect(viewChanged).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  expect(viewChanged).toHaveBeenCalledTimes(1);
  expect(connection.getSnapshot().players[0].x).toBe(2);
  connection.disconnect();
});
it("provides a stable localization key while reconnecting", async () => {
  const connection = new WorldConnection("/world/socket", "나", 0, "rev");
  await connection.connect();
  Socket.made[0].close();

  expect(connection.getSnapshot()).toMatchObject({
    status: "reconnecting",
    messageKey: "connection.message.reconnecting",
  });
  connection.disconnect();
});
it("localizes rejected admission state by its authentication status", async () => {
  const connection = new WorldConnection(
    "/world/socket",
    "나",
    0,
    "rev",
    async () => {
      throw new AuthError(401, "한국어 인증 오류");
    },
  );
  await connection.connect();

  expect(connection.getSnapshot()).toMatchObject({
    status: "offline",
    message: "한국어 인증 오류",
    messageKey: "connection.message.authRequired",
  });
  connection.disconnect();
});
it("updates the space participant roster from a world control message", async () => {
  const connection = new WorldConnection("/world/socket", "친구", 0, "rev");
  await connection.connect();
  const socket = Socket.made[0];
  socket.onopen?.();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "spaceParticipants",
      revision: 2,
      participants: [
        {
          playerId: "other-map-player",
          name: "다른 지도 참가자",
          avatar: 0,
          skin: "light",
          clothing: "casual_white",
          hair: "hair_short_black",
          status: "AVAILABLE",
          mapId: "study-room",
          mapName: "스터디룸",
          directMessageEnabled: true,
          allowPokes: true,
        },
      ],
    }),
  });

  expect(connection.getSnapshot().spaceParticipants).toEqual([
    expect.objectContaining({
      playerId: "other-map-player",
      mapId: "study-room",
      mapName: "스터디룸",
    }),
  ]);
  connection.disconnect();
});
it("loads and saves only the current room note and clears it after a zone change", async () => {
  const connection = new WorldConnection("/world/socket", "나", 0, "rev");
  await connection.connect();
  const socket = Socket.made[0];
  socket.onopen?.();
  const receive = (data: object) =>
    socket.onmessage?.({ data: JSON.stringify(data) });
  receive({
    type: "welcome",
    protocolVersion: 2,
    mapRevision: "rev",
    playerId: "me",
    resumeToken: "resume",
    epoch: 3,
  });
  receive({
    type: "snapshot",
    mapRevision: "rev",
    tick: 1,
    full: true,
    players: [{ id: "me", zoneId: "room-a" }],
    rooms: [],
  });

  const loadRequestId = connection.loadRoomNote();
  expect(loadRequestId).toBeTruthy();
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "roomNoteRequest",
    action: "LOAD",
    epoch: 3,
    baseRevision: 0,
    body: "",
  });
  receive({
    type: "roomNoteState",
    zoneId: "room-a",
    revision: 2,
    body: "최신 회의 메모",
    updatedAt: 10,
    updatedBy: "참가자",
    meetingEndedAt: 0,
    retentionExpiresAt: 0,
    history: [],
  });
  expect(connection.getSnapshot().roomNoteState?.revision).toBe(2);
  const saveRequestId = connection.saveRoomNote("내 초안", 1);
  expect(saveRequestId).toBeTruthy();
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "roomNoteRequest",
    action: "SAVE",
    baseRevision: 1,
    body: "내 초안",
  });
  receive({
    type: "roomNoteAck",
    requestId: saveRequestId,
    zoneId: "room-a",
    accepted: false,
    revision: 2,
    code: "ROOM_NOTE_CONFLICT",
    message: "최신 메모가 있어요.",
  });
  expect(connection.getSnapshot().lastRoomNoteAck?.code).toBe(
    "ROOM_NOTE_CONFLICT",
  );

  receive({
    type: "snapshot",
    mapRevision: "rev",
    tick: 2,
    full: false,
    baseTick: 1,
    players: [{ id: "me", zoneId: "room-b" }],
    removedPlayerIds: [],
    rooms: [],
  });
  expect(connection.getSnapshot().roomNoteState).toBeNull();
  expect(connection.getSnapshot().lastRoomNoteAck).toBeNull();
  receive({
    type: "roomNoteState",
    zoneId: "room-a",
    revision: 3,
    body: "다른 회의실 문서",
    updatedAt: 20,
    updatedBy: "다른 사람",
    meetingEndedAt: 0,
    retentionExpiresAt: 0,
    history: [],
  });
  expect(connection.getSnapshot().roomNoteState).toBeNull();
  expect(connection.saveRoomNote("", 0)).toBe(false);
  expect(connection.loadRoomNote()).toBeTruthy();
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "roomNoteRequest",
    action: "LOAD",
  });
  connection.disconnect();
});
it("does not send room note bodies longer than the contract limit", async () => {
  const connection = new WorldConnection("/world/socket", "나", 0, "rev");
  await connection.connect();
  const socket = Socket.made[0];
  socket.onopen?.();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "welcome",
      protocolVersion: 2,
      mapRevision: "rev",
      playerId: "me",
      resumeToken: "resume",
      epoch: 1,
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      mapRevision: "rev",
      tick: 1,
      full: true,
      players: [{ id: "me", zoneId: "room-a" }],
      rooms: [],
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "roomNoteState",
      zoneId: "room-a",
      revision: 0,
      body: "",
      updatedAt: 0,
      updatedBy: "",
      meetingEndedAt: 0,
      retentionExpiresAt: 0,
      history: [],
    }),
  });
  const sentBefore = socket.sent.length;
  expect(connection.saveRoomNote("x".repeat(4001), 0)).toBe(false);
  expect(socket.sent).toHaveLength(sentBefore);
  connection.disconnect();
});
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it("does not open a socket after leaving during admission", async () => {
  const ticket = deferred();
  const connection = new WorldConnection(
    "/world/socket",
    "친구",
    0,
    "rev",
    () => ticket.promise,
  );
  const ready = connection.connect();
  connection.disconnect();
  ticket.resolve("old");
  await ready;
  expect(Socket.made).toHaveLength(0);
  expect(connection.getSnapshot().status).toBe("closed");
});
it("ignores the older StrictMode admission response", async () => {
  const first = deferred();
  const second = deferred();
  const admit = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const connection = new WorldConnection(
    "/world/socket",
    "친구",
    0,
    "rev",
    admit,
  );
  const old = connection.connect();
  connection.disconnect();
  const current = connection.connect();
  second.resolve("new");
  await current;
  first.resolve("old");
  await old;
  expect(Socket.made).toHaveLength(1);
  expect(Socket.made[0].protocols).toEqual(["hufs-town-v2", "hufs-ticket.new"]);
  connection.disconnect();
});
it("obtains a fresh ticket on reconnect while preserving its resume token", async () => {
  const admit = vi
    .fn()
    .mockResolvedValueOnce("first")
    .mockResolvedValueOnce("second");
  const connection = new WorldConnection(
    "/world/socket",
    "친구",
    0,
    "rev",
    admit,
  );
  await connection.connect();
  const first = Socket.made[0];
  first.onopen?.();
  first.onmessage?.({
    data: JSON.stringify({
      type: "welcome",
      protocolVersion: 2,
      mapRevision: "rev",
      playerId: "me",
      resumeToken: "resume",
      epoch: 1,
    }),
  });
  first.close();
  await vi.advanceTimersByTimeAsync(500);
  expect(admit).toHaveBeenCalledTimes(2);
  const second = Socket.made[1];
  second.onopen?.();
  expect(second.protocols).toEqual(["hufs-town-v2", "hufs-ticket.second"]);
  expect(JSON.parse(second.sent[0]).resumeToken).toBe("resume");
  expect(second.url).not.toContain("ticket");
  connection.disconnect();
});
it("starts a map transfer with the approved player resume token", async () => {
  const admit = vi.fn().mockResolvedValue({ ticket: "target-map-ticket" });
  const connection = new WorldConnection(
    "/world/socket",
    "친구",
    0,
    "rev",
    admit,
    "user-id",
    "space-id",
    "light",
    "casual_white",
    "hair_short_black",
    "",
    [],
    undefined,
    "approved-transfer-resume-token",
  );

  expect(connection.getResumeToken()).toBe("approved-transfer-resume-token");
  await connection.connect();
  expect(admit).toHaveBeenCalledWith("approved-transfer-resume-token");
  const socket = Socket.made[0];
  expect(socket.protocols).toEqual([
    "hufs-town-v2",
    "hufs-ticket.target-map-ticket",
  ]);
  socket.onopen?.();
  expect(JSON.parse(socket.sent[0]).resumeToken).toBe(
    "approved-transfer-resume-token",
  );
  connection.disconnect();
});
it("shows a denied admission without an automatic retry loop", async () => {
  const admit = vi
    .fn()
    .mockRejectedValue(new AuthError(404, "입장 권한이 없어요."));
  const connection = new WorldConnection(
    "/world/socket",
    "친구",
    0,
    "rev",
    admit,
  );
  await connection.connect();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(connection.getSnapshot()).toMatchObject({
    status: "offline",
    message: "입장 권한이 없어요.",
  });
  expect(admit).toHaveBeenCalledTimes(1);
  expect(Socket.made).toHaveLength(0);
});

async function connectedMedia() {
  const connection = new WorldConnection("/world/socket", "친구", 0, "rev");
  await connection.connect();
  const socket = Socket.made[0];
  socket.onopen?.();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "welcome",
      protocolVersion: 2,
      mapRevision: "rev",
      playerId: "me",
      resumeToken: "resume",
      epoch: 1,
    }),
  });
  return { connection, socket };
}
async function connectedRoom() {
  const { connection, socket } = await connectedMedia();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      mapRevision: "rev",
      tick: 1,
      full: true,
      players: [{ id: "me", zoneId: "meeting-a" }],
      rooms: [],
    }),
  });
  return { connection, socket };
}
it("keeps event attendance disabled unless explicitly enabled", async () => {
  const { connection, socket } = await connectedMedia();
  connection.eventAction("START", "", "일반 대화");
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "eventAction",
    action: "START",
    attendanceEnabled: false,
  });
  connection.eventAction("START", "", "행사", "", "", true);
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "eventAction",
    action: "START",
    attendanceEnabled: true,
  });
  connection.disconnect();
});

it("sends room recording requests with the complete scoped wire shape", async () => {
  const { connection, socket } = await connectedRoom();
  const startId = connection.requestRoomRecording("meeting-a", "START", "", [
    "MICROPHONE",
    "SCREEN_AUDIO",
  ]);
  expect(startId).toBeTruthy();
  expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
    type: "roomRecordingRequest",
    requestId: startId,
    epoch: 1,
    zoneId: "meeting-a",
    action: "START",
    recordingId: "",
    sources: ["MICROPHONE", "SCREEN_AUDIO"],
    accepted: false,
  });

  const consentId = connection.requestRoomRecording(
    "meeting-a",
    "CONSENT",
    "recording-a",
    [],
    true,
  );
  expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
    type: "roomRecordingRequest",
    requestId: consentId,
    epoch: 1,
    zoneId: "meeting-a",
    action: "CONSENT",
    recordingId: "recording-a",
    sources: [],
    accepted: true,
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "roomRecordingAck",
      requestId: consentId,
      recordingId: "recording-a",
      accepted: true,
      status: "AWAITING_CONSENT",
      code: "",
      message: "동의를 기록했어요.",
    }),
  });
  expect(connection.getSnapshot().lastRoomRecordingAck).toMatchObject({
    requestId: consentId,
    accepted: true,
  });
  for (const action of ["CONSENT", "WITHDRAW", "STOP"] as const) {
    const actionId = connection.requestRoomRecording(
      "meeting-a",
      action,
      "recording-a",
      [],
      false,
    );
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "roomRecordingRequest",
      requestId: actionId,
      epoch: 1,
      zoneId: "meeting-a",
      action,
      recordingId: "recording-a",
      sources: [],
      accepted: false,
    });
  }
  connection.disconnect();
});

it("sends transcription only as an explicit room recording opt-in", async () => {
  const { connection, socket } = await connectedRoom();
  connection.requestRoomRecording(
    "meeting-a",
    "START",
    "",
    ["MICROPHONE"],
    false,
    true,
  );
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "roomRecordingRequest",
    action: "START",
    sources: ["MICROPHONE"],
    transcribe: true,
  });

  connection.requestRoomRecording(
    "meeting-a",
    "CONSENT",
    "recording-a",
    [],
    true,
  );
  expect(JSON.parse(socket.sent.at(-1)!)).not.toHaveProperty("transcribe");
  connection.disconnect();
});
it("rejects room recording requests outside the current room and filters server state by zone", async () => {
  const { connection, socket } = await connectedRoom();
  expect(
    connection.requestRoomRecording("another-room", "START", "", ["CAMERA"]),
  ).toBe(false);
  expect(socket.sent.map((raw) => JSON.parse(raw))).not.toContainEqual(
    expect.objectContaining({ type: "roomRecordingRequest" }),
  );
  const state = {
    type: "roomRecordingState",
    recordingId: "recording-a",
    zoneId: "meeting-a",
    status: "AWAITING_CONSENT",
    sources: ["CAMERA"],
    requestedByPlayerId: "me",
    requestedByName: "호스트",
    requestedAt: 1,
    startedAt: 0,
    endedAt: 0,
    retentionDays: 30,
    trackCount: 0,
    participants: [],
  };
  socket.onmessage?.({
    data: JSON.stringify({ ...state, zoneId: "another-room" }),
  });
  expect(connection.getSnapshot().roomRecordingState).toBeNull();
  socket.onmessage?.({ data: JSON.stringify(state) });
  expect(connection.getSnapshot().roomRecordingState?.recordingId).toBe(
    "recording-a",
  );
  socket.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      mapRevision: "rev",
      tick: 2,
      full: true,
      players: [{ id: "me", zoneId: "public-area" }],
      rooms: [],
    }),
  });
  expect(connection.getSnapshot().roomRecordingState).toBeNull();
  connection.disconnect();
});
it("correlates media replies and rejects pending requests immediately on leave", async () => {
  const { connection, socket } = await connectedMedia();
  const pending = connection.mediaRequest(1, "capabilities", {});
  const request = JSON.parse(socket.sent.at(-1)!);
  expect(request).toMatchObject({
    type: "mediaRequest",
    policyEpoch: 1,
    method: "capabilities",
    dataJson: "{}",
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "mediaReply",
      requestId: request.requestId,
      ok: true,
      dataJson: '{"ready":true}',
      code: "",
      message: "",
    }),
  });
  await expect(pending).resolves.toEqual({ ready: true });
  const abandoned = connection.mediaRequest(1, "stats", {});
  const rejection = expect(abandoned).rejects.toMatchObject({
    code: "MEDIA_UNAVAILABLE",
  });
  connection.disconnect();
  await rejection;
});
it("bounds media pending requests and releases timed-out requests", async () => {
  const { connection } = await connectedMedia();
  const pending = Array.from({ length: 8 }, () =>
    connection.mediaRequest(1, "stats", {}).catch((error) => error.code),
  );
  await expect(connection.mediaRequest(1, "stats", {})).rejects.toMatchObject({
    code: "MEDIA_BUSY",
  });
  await vi.advanceTimersByTimeAsync(5100);
  expect(await Promise.all(pending)).toEqual(Array(8).fill("MEDIA_TIMEOUT"));
  connection.disconnect();
});

it("stores a translation key when direct-message history cannot be loaded", async () => {
  const connection = new WorldConnection(
    "/world/socket",
    "나",
    0,
    "rev",
    async () => "ticket",
    "user",
    "space",
  );
  await connection.connect();
  const socket = Socket.made[0];
  socket.onopen?.();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "welcome",
      protocolVersion: 2,
      mapRevision: "rev",
      playerId: "me",
      resumeToken: "resume",
      epoch: 1,
    }),
  });

  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
  try {
    await connection.loadDirectMessageHistory("conversation");
    expect(
      connection.getSnapshot().chatHistoryPages["dm:conversation"].error,
    ).toBe("chat.history.error.load");
  } finally {
    vi.stubGlobal("fetch", originalFetch);
    connection.disconnect();
  }
});
