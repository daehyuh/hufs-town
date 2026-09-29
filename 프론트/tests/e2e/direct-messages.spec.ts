import { expect, test } from "@playwright/test";

import { authApi } from "../fixtures/auth-api";
import type { MapDefinition } from "../../src/generated/protocol";
import type { Space } from "../../src/spaces/client";

const spaceId = "30000000-0000-4000-8000-000000000003";
const selfId = "fixture-self";
const peerId = "60000000-0000-4000-8000-000000000006";
const conversationId = "40000000-0000-4000-8000-000000000004";
const groupConversationId = "41000000-0000-4000-8000-000000000004";
const groupMemberId = "61000000-0000-4000-8000-000000000006";
const groupDisplayName = "Campus project team";

const space: Space = {
  id: spaceId,
  name: "DM 확인 캠퍼스",
  description: "메시지 흐름 브라우저 확인",
  visibility: "PUBLIC",
  capacity: 100,
  templateId: "CAMPUS_SQUARE",
  role: "MEMBER",
  approvalRequired: false,
  allowedEmailDomains: [],
  guestEntryEnabled: false,
  joinRequestStatus: "",
  favorite: false,
  archived: false,
};
const destinationSpace: Space = {
  ...space,
  id: "31000000-0000-4000-8000-000000000003",
  name: "민지의 만남 공간",
};
const approvalRequiredSpace: Space = {
  ...destinationSpace,
  id: "32000000-0000-4000-8000-000000000003",
  name: "승인 후 입장하는 공간",
  role: "",
  approvalRequired: true,
};
type MeetupRequestFixture = {
  id: string;
  displayName: string;
  message: string;
  status: string;
  requestedAt: number;
  expiresAt: number;
  destinationSpaceId: string | null;
  destinationSpaceName: string | null;
};

const map: MapDefinition = {
  schemaVersion: 2,
  id: "dm-test-map",
  revision: "dm-test-revision",
  name: "DM 테스트 지도",
  width: 32,
  height: 24,
  spawnX: 16,
  spawnY: 12,
  collisions: [],
  objects: [],
  zones: [
    {
      id: "public",
      name: "광장",
      kind: "PUBLIC",
      bounds: { x: 0, y: 0, width: 32, height: 24 },
    },
    {
      id: "private-room",
      name: "독립 회의실",
      kind: "PRIVATE",
      bounds: { x: 20, y: 10, width: 8, height: 8 },
    },
  ],
  floors: [
    {
      id: "floor",
      material: "GRASS",
      bounds: { x: 0, y: 0, width: 32, height: 24 },
    },
  ],
  walls: [],
  labels: [],
};

test("participant can start a private DM and use room-scoped chat", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await authApi(page, { signedIn: true });
  const friendRequestTargets: string[] = [];
  await page.route("**/api/v1/me/friends**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.endsWith("/requests")) {
      const body = request.postDataJSON() as { targetUserId: string };
      friendRequestTargets.push(body.targetUserId);
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "FRIEND_REQUEST_UNAVAILABLE",
          message: "친구 요청을 보낼 수 없어요. 잠시 후 다시 시도해 주세요.",
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ friends: [], incoming: [], outgoing: [] }),
    });
  });
  await page.route("**/api/v1/me/blocks**", async (route) => {
    const request = route.request();
    if (request.method() === "DELETE") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          message: "차단을 해제할 수 없어요. 잠시 후 다시 시도해 주세요.",
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "blocked-account",
          displayName: "Muted campus user",
          createdAt: "2026-09-20T00:00:00Z",
        },
      ]),
    });
  });
  await page.route("**/api/v1/auth/preferences", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        message:
          "찌르기 수신 설정을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.",
      }),
    }),
  );
  await page.clock.install();

  const sentMessages: Record<string, unknown>[] = [];
  const playerReports: Record<string, unknown>[] = [];
  const meetupActions: { path: string; method: string; body?: unknown }[] = [];
  const groupManagementRequests: { path: string; method: string }[] = [];
  const admissionRequests: string[] = [];
  const worldSocketUrls: string[] = [];
  const spaceJoinRequests: string[] = [];
  let directConversationFailuresRemaining = 1;
  let groupMemberLoadFailuresRemaining = 1;
  let incomingMeetupRequests: MeetupRequestFixture[] = [
    {
      id: "51000000-0000-4000-8000-000000000001",
      displayName: "민지",
      message: "점심 같이 먹어요",
      status: "PENDING",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      destinationSpaceId: destinationSpace.id,
      destinationSpaceName: destinationSpace.name,
    },
    {
      id: "51000000-0000-4000-8000-000000000002",
      displayName: "도윤",
      message: "캠퍼스에서 만나요",
      status: "PENDING",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      destinationSpaceId: destinationSpace.id,
      destinationSpaceName: destinationSpace.name,
    },
    {
      id: "51000000-0000-4000-8000-000000000004",
      displayName: "은지",
      message: "여기에서 기다릴게요.",
      status: "APPROVED",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      destinationSpaceId: space.id,
      destinationSpaceName: space.name,
    },
    {
      id: "51000000-0000-4000-8000-000000000005",
      displayName: "가온",
      message: "승인제 공간에서 만나요.",
      status: "APPROVED",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      destinationSpaceId: approvalRequiredSpace.id,
      destinationSpaceName: approvalRequiredSpace.name,
    },
  ];
  let outgoingMeetupRequests: MeetupRequestFixture[] = [
    {
      id: "52000000-0000-4000-8000-000000000001",
      displayName: "서연",
      message: "",
      status: "PENDING",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      destinationSpaceId: null,
      destinationSpaceName: null,
    },
  ];
  let conversations: Record<string, unknown>[] = [];
  let movePlayersIntoPrivateRoom: (() => void) | undefined;

  await page.route("**/api/v1/bootstrap", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        protocolVersion: 2,
        mode: "sso",
        storage: "mariadb",
        space: { id: spaceId, name: space.name, capacity: 100 },
        map,
        worldPath: "/world/socket",
        features: {
          movement: true,
          running: true,
          emotes: true,
          ssoLogin: true,
          spaces: true,
          invitations: true,
          media: false,
          editor: true,
        },
      }),
    }),
  );

  await page.route("**/api/v1/spaces**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown = [];
    if (path === "/api/v1/spaces") {
      body = {
        items: [space],
        page: 1,
        pageSize: 12,
        totalItems: 1,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
      };
    } else if (path.endsWith("/admission")) {
      admissionRequests.push(path.split("/").at(-2) ?? "");
      body = {
        ticket: "dm-ui-fixture-ticket",
        expiresInSeconds: 30,
        worldUrl: "ws://localhost:18091/world/socket",
      };
    } else if (request.method() === "POST" && path.endsWith("/join-requests")) {
      spaceJoinRequests.push(path.split("/").at(-2) ?? "");
      body = { status: "PENDING", requestedAt: Date.now() };
    } else if (path.endsWith("/assets")) {
      body = [];
    } else if (path === `/api/v1/spaces/${spaceId}`) {
      body = space;
    } else if (path === `/api/v1/spaces/${destinationSpace.id}`) {
      body = destinationSpace;
    } else if (path === `/api/v1/spaces/${approvalRequiredSpace.id}`) {
      body = approvalRequiredSpace;
    } else if (path.endsWith("/ownership-transfers/incoming")) {
      body = [];
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.route("**/api/v1/dms**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let status = 200;
    let body: unknown = [];
    if (path === "/api/v1/dms") {
      body = conversations;
    } else if (path === "/api/v1/dms/group-invitations") {
      body = [];
    } else if (
      request.method() === "GET" &&
      path === `/api/v1/dms/${groupConversationId}/members`
    ) {
      groupManagementRequests.push({ path, method: request.method() });
      if (groupMemberLoadFailuresRemaining > 0) {
        groupMemberLoadFailuresRemaining--;
        status = 503;
        body = {
          code: "GROUP_MEMBERS_UNAVAILABLE",
          message:
            "그룹 멤버 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
        };
      } else {
        body = [
          {
            memberId: "local-test-user",
            displayName: "외대 친구",
            avatar: 1,
            skin: "light",
            clothing: "casual_white",
            hair: "hair_short_black",
            owner: true,
            self: true,
            joinedAt: Date.now(),
          },
          {
            memberId: groupMemberId,
            displayName: "캠퍼스 친구",
            avatar: 2,
            skin: "blue",
            clothing: "casual_blue",
            hair: "hair_short_black",
            owner: false,
            self: false,
            joinedAt: Date.now(),
          },
        ];
      }
    } else if (
      request.method() === "PATCH" &&
      path === `/api/v1/dms/${groupConversationId}`
    ) {
      groupManagementRequests.push({ path, method: request.method() });
      status = 503;
      body = {
        code: "GROUP_RENAME_UNAVAILABLE",
        message: "그룹 이름을 저장할 수 없어요. 잠시 후 다시 시도해 주세요.",
      };
    } else if (
      request.method() === "DELETE" &&
      path === `/api/v1/dms/${groupConversationId}/members/${groupMemberId}`
    ) {
      groupManagementRequests.push({ path, method: request.method() });
      status = 503;
      body = {
        code: "GROUP_MEMBER_REMOVE_UNAVAILABLE",
        message: "그룹 멤버를 내보낼 수 없어요. 잠시 후 다시 시도해 주세요.",
      };
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.route("**/api/v1/me/join-requests**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let body: unknown = {};
    if (method === "GET" && path.endsWith("/outgoing")) {
      body = outgoingMeetupRequests;
    } else if (method === "GET") {
      body = incomingMeetupRequests;
    } else if (path === "/api/v1/me/join-requests") {
      const requestBody = request.postDataJSON() as Record<string, unknown>;
      meetupActions.push({ path, method, body: requestBody });
      const createdRequest = {
        id: "53000000-0000-4000-8000-000000000001",
        status: "PENDING",
        requestedAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        destinationSpaceId: spaceId,
        destinationSpaceName: space.name,
      };
      body = createdRequest;
      outgoingMeetupRequests = [
        {
          ...createdRequest,
          displayName: "캠퍼스 친구",
          message: "",
          destinationSpaceId: spaceId,
          destinationSpaceName: space.name,
        },
        ...outgoingMeetupRequests,
      ];
    } else if (path.endsWith("/respond")) {
      const requestId = path.split("/").at(-2);
      const requestBody = request.postDataJSON() as { decision: string };
      meetupActions.push({ path, method, body: requestBody });
      incomingMeetupRequests =
        requestBody.decision === "APPROVE"
          ? incomingMeetupRequests.map((item) =>
              item.id === requestId ? { ...item, status: "APPROVED" } : item,
            )
          : incomingMeetupRequests.filter((item) => item.id !== requestId);
      body = {
        status: requestBody.decision === "APPROVE" ? "APPROVED" : "DECLINED",
      };
    } else if (path.endsWith("/cancel")) {
      const requestId = path.split("/").at(-2);
      meetupActions.push({ path, method });
      outgoingMeetupRequests = outgoingMeetupRequests.filter(
        (item) => item.id !== requestId,
      );
      body = { cancelled: true };
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.routeWebSocket("**/world/socket", (socket) => {
    worldSocketUrls.push(socket.url());
    socket.onMessage((rawMessage) => {
      if (typeof rawMessage !== "string") return;
      const message = JSON.parse(rawMessage) as Record<string, unknown>;
      if (message.type === "join") {
        const players = [
          {
            id: selfId,
            name: "외대 친구",
            avatar: 1,
            skin: "light",
            clothing: "casual_white",
            hair: "hair_short_black",
            x: 16,
            y: 12,
            direction: "down",
            moving: false,
            zoneId: "public",
            emoji: "",
            emojiUntil: 0,
            sitting: false,
            status: "AVAILABLE",
            directMessageEnabled: true,
            bio: "",
            links: [],
          },
          {
            id: peerId,
            name: "캠퍼스 친구",
            avatar: 2,
            skin: "blue",
            clothing: "casual_blue",
            hair: "hair_short_black",
            x: 17,
            y: 12,
            direction: "left",
            moving: false,
            zoneId: "public",
            emoji: "",
            emojiUntil: 0,
            sitting: false,
            status: "AVAILABLE",
            directMessageEnabled: true,
            bio: "",
            links: [],
          },
        ];
        const sendSnapshot = (tick: number, snapshotPlayers: typeof players) =>
          socket.send(
            JSON.stringify({
              type: "snapshot",
              tick,
              serverTime: Date.now(),
              full: tick === 1,
              baseTick: tick === 1 ? -1 : 1,
              inputAckSeq: -1,
              players: snapshotPlayers,
              removedPlayerIds: [],
              mapRevision: map.revision,
              rooms: [],
            }),
          );
        const privatePlayers = players.map((player, index) => ({
          ...player,
          x: 21 + index,
          zoneId: "private-room",
        }));
        socket.send(
          JSON.stringify({
            type: "mapChanged",
            map,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "welcome",
            protocolVersion: 2,
            playerId: selfId,
            resumeToken: "dm-ui-fixture-resume",
            epoch: 1,
            mapRevision: map.revision,
            tickMs: 50,
            features: ["PARTICIPANT_REPORTS"],
          }),
        );
        sendSnapshot(1, players);
        socket.send(
          JSON.stringify({
            type: "spaceParticipants",
            revision: 1,
            participants: [
              {
                playerId: "remote-study-player",
                name: "스터디룸 친구",
                avatar: 3,
                skin: "green",
                clothing: "casual_green",
                hair: "hair_short_black",
                status: "AVAILABLE",
                mapId: "study-room-map",
                mapName: "스터디룸",
                directMessageEnabled: true,
                allowPokes: true,
              },
            ],
          }),
        );
        movePlayersIntoPrivateRoom = () => sendSnapshot(2, privatePlayers);
        return;
      }

      if (message.type === "playerReportRequest") {
        playerReports.push(message);
        socket.send(
          JSON.stringify({
            type: "playerReportAck",
            requestId: message.requestId,
            targetId: message.targetId,
            accepted: true,
            code: "",
            message: "신고를 접수했어요. 운영팀이 확인할게요.",
          }),
        );
        return;
      }

      if (message.type === "directConversationRequest") {
        if (directConversationFailuresRemaining > 0) {
          directConversationFailuresRemaining--;
          socket.send(
            JSON.stringify({
              type: "directConversationResult",
              requestId: message.requestId,
              targetPlayerId: peerId,
              accepted: false,
              conversationId: "",
              code: "DM_TARGET_UNAVAILABLE",
              message:
                "같은 공간에 있는 다른 로그인 참가자만 대화를 시작할 수 있어요.",
            }),
          );
          return;
        }
        conversations = [
          {
            conversationId,
            kind: "DIRECT",
            displayName: "캠퍼스 친구",
            participantCount: 2,
            avatar: 2,
            skin: "blue",
            clothing: "casual_blue",
            hair: "hair_short_black",
            lastMessage: null,
            lastMessageAt: null,
            unreadCount: 0,
            owner: false,
          },
          {
            conversationId: groupConversationId,
            kind: "GROUP",
            displayName: groupDisplayName,
            participantCount: 2,
            avatar: null,
            skin: null,
            clothing: null,
            hair: null,
            lastMessage: "Planning update",
            lastMessageAt: Date.now(),
            unreadCount: 0,
            owner: true,
          },
        ];
        socket.send(
          JSON.stringify({
            type: "directConversationResult",
            requestId: message.requestId,
            targetPlayerId: peerId,
            accepted: true,
            conversationId,
            code: "",
            message: "대화를 시작했어요.",
          }),
        );
        return;
      }

      if (message.type === "chatSend") {
        sentMessages.push(message);
        const sentAt = Date.now();
        socket.send(
          JSON.stringify({
            type: "chatAck",
            clientMessageId: message.clientMessageId,
            accepted: true,
            code: "",
            message: "전달했어요.",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "chatEvent",
            messageId: message.clientMessageId,
            clientMessageId: message.clientMessageId,
            channel: message.channel,
            conversationId: message.conversationId,
            senderId: selfId,
            senderName: "외대 친구",
            avatar: 1,
            skin: "light",
            clothing: "casual_white",
            hair: "hair_short_black",
            text: message.text,
            sentAt,
            zoneId: message.channel === "room" ? "private-room" : "public",
            revision: 0,
            editedAt: 0,
            deleted: false,
          }),
        );
      }
    });
  });

  await page.goto("/");
  const card = page.getByRole("article").filter({ hasText: space.name });
  await card.getByRole("button", { name: "입장하기", exact: false }).click();
  await page
    .getByRole("dialog", { name: space.name })
    .getByRole("button", { name: "캠퍼스 입장하기" })
    .click();
  await expect(page.locator(".connection-status")).toHaveText("연결됨");
  const pageUrl = new URL(page.url());
  const loopbackPage = ["localhost", "127.0.0.1", "[::1]"].includes(
    pageUrl.hostname,
  );
  const expectedSocketUrl = loopbackPage
    ? "ws://localhost:18091/world/socket"
    : `${pageUrl.protocol === "https:" ? "wss" : "ws"}://${pageUrl.host}/world/socket`;
  expect(worldSocketUrls).toContain(expectedSocketUrl);

  await page.getByRole("button", { name: "참가자 보기" }).click();
  const meetupInbox = page.getByRole("region", { name: "만남 요청" });
  const otherParticipants = page.getByRole("region", {
    name: "공간의 다른 참가자",
  });
  await expect(otherParticipants).toContainText("스터디룸 친구");
  await otherParticipants
    .getByRole("button", { name: "스터디룸 친구님 신고" })
    .click();
  const reportDialog = page.getByRole("dialog", { name: "참가자 신고" });
  await reportDialog.getByLabel("신고 사유").selectOption("SPAM");
  await reportDialog
    .getByLabel("추가 설명 (선택)")
    .fill("다른 맵 참가자 신고 경로 확인");
  await reportDialog.getByRole("button", { name: "신고 접수" }).click();
  await expect(
    page.getByText("신고를 접수했어요. 운영팀이 확인할게요."),
  ).toBeVisible();
  await expect.poll(() => playerReports.length).toBe(1);
  expect(playerReports[0]).toMatchObject({
    type: "playerReportRequest",
    targetId: "remote-study-player",
    category: "SPAM",
    details: "다른 맵 참가자 신고 경로 확인",
  });

  await expect(
    meetupInbox.getByText("민지님이 만나기를 요청했어요"),
  ).toBeVisible();
  await meetupInbox
    .getByRole("article")
    .filter({ hasText: "민지님이 만나기를 요청했어요" })
    .getByRole("button", { name: "승인" })
    .click();
  await expect(
    meetupInbox.getByText(
      "만남 요청을 승인했어요. 요청된 공간을 열어 입장할 수 있어요.",
    ),
  ).toBeVisible();
  await meetupInbox
    .getByRole("article")
    .filter({ hasText: "은지님과의 만남 요청을 승인했어요" })
    .getByRole("button", { name: "공간 열기" })
    .click();
  await expect(meetupInbox.getByText("이미 이 공간에 있어요.")).toBeVisible();
  await expect(
    meetupInbox
      .getByRole("article")
      .filter({ hasText: "민지님과의 만남 요청을 승인했어요" })
      .getByRole("button", { name: "공간 열기" }),
  ).toBeVisible();
  await meetupInbox
    .getByRole("article")
    .filter({ hasText: "도윤님이 만나기를 요청했어요" })
    .getByRole("button", { name: "거절" })
    .click();
  await expect(
    meetupInbox.getByText("민지님과의 만남 요청을 승인했어요"),
  ).toBeVisible();
  await meetupInbox
    .getByRole("button", { name: "서연님에게 보낸 요청 취소" })
    .click();
  expect(meetupActions.map((action) => action.body)).toEqual([
    { decision: "APPROVE" },
    { decision: "DECLINE" },
    undefined,
  ]);

  const startDirectMessage = page.getByRole("button", {
    name: "캠퍼스 친구님에게 1:1 메시지 보내기",
  });
  await startDirectMessage.click();
  const directMessageError = page.getByText(
    "같은 공간에 있는 다른 로그인 참가자만 대화를 시작할 수 있어요.",
    { exact: true },
  );
  await expect(directMessageError.first()).toBeVisible();
  await startDirectMessage.click();
  await expect(
    page.getByText("나와 상대방만 볼 수 있는 대화예요"),
  ).toBeVisible();
  await expect(
    page.getByRole("log", { name: "캠퍼스 친구 대화" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "만남 요청" }).click();
  await expect(
    page.getByText(
      "만남 요청을 보냈어요. 승인되면 요청된 공간을 열 수 있어요.",
    ),
  ).toBeVisible();
  expect(meetupActions.at(-1)).toMatchObject({
    path: "/api/v1/me/join-requests",
    method: "POST",
    body: { conversationId, destinationSpaceId: spaceId },
  });
  expect(meetupActions.at(-1)?.body).not.toHaveProperty("targetUserId");

  const message = "우리만 볼 수 있는 DM";
  await page.getByRole("textbox", { name: "채팅 메시지" }).fill(message);
  await page.getByRole("button", { name: "메시지 보내기" }).click();
  await expect(page.getByText(message)).toBeVisible();
  await expect.poll(() => sentMessages.length).toBe(1);
  expect(sentMessages[0]).toMatchObject({
    type: "chatSend",
    channel: "dm",
    conversationId,
    text: message,
  });
  const ownMessage = page.locator(".chat-message").filter({ hasText: message });
  await ownMessage.getByRole("button", { name: "메시지 삭제" }).click();
  const deletionDialog = page.getByRole("dialog", {
    name: "작업을 확인해 주세요",
  });
  await expect(deletionDialog).toContainText("이 메시지를 삭제하시겠어요?");
  await expect(deletionDialog).toHaveAccessibleDescription(
    "이 메시지를 삭제하시겠어요?",
  );
  await deletionDialog.locator(".dialog-action-secondary").click();
  await expect(page.getByText(message)).toBeVisible();

  movePlayersIntoPrivateRoom?.();
  await page.getByRole("button", { name: "← 대화 목록" }).click();
  await page.getByRole("tab", { name: "공간 채팅" }).click();
  await expect(
    page.getByText("이 회의실에 있는 사람만 볼 수 있어요"),
  ).toBeVisible();
  const roomMessage = "회의실 안에서만 나누는 이야기";
  await page.getByRole("textbox", { name: "채팅 메시지" }).fill(roomMessage);
  await page.getByRole("button", { name: "메시지 보내기" }).click();
  await expect(page.getByText(roomMessage)).toBeVisible();
  await expect.poll(() => sentMessages.length).toBe(2);
  expect(sentMessages[1]).toMatchObject({
    type: "chatSend",
    channel: "room",
    conversationId: "",
    text: roomMessage,
  });

  await page.getByRole("button", { name: "참가자 보기" }).click();
  const refreshedInbox = page.getByRole("region", { name: "만남 요청" });
  await expect(
    refreshedInbox.getByText("민지님과의 만남 요청을 승인했어요"),
  ).toBeVisible();
  incomingMeetupRequests.push({
    id: "51000000-0000-4000-8000-000000000003",
    displayName: "하늘",
    message: "같이 이야기하고 싶어요.",
    status: "PENDING",
    requestedAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    destinationSpaceId: destinationSpace.id,
    destinationSpaceName: destinationSpace.name,
  });
  await page.clock.fastForward(15_001);
  await expect(
    refreshedInbox.getByText("하늘님이 만나기를 요청했어요"),
  ).toBeVisible();
  await page
    .getByRole("article")
    .filter({ hasText: "민지님과의 만남 요청을 승인했어요" })
    .getByRole("button", { name: "공간 열기" })
    .click();
  await expect(
    page.getByRole("dialog", { name: destinationSpace.name }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: destinationSpace.name })
    .getByRole("button", { name: "캠퍼스 입장하기" })
    .click();
  await expect.poll(() => admissionRequests).toContain(destinationSpace.id);
  await expect(page.locator(".connection-status")).toHaveText("연결됨");
  const destinationInbox = page.getByRole("region", { name: "만남 요청" });
  if (!(await destinationInbox.isVisible()))
    await page.getByRole("button", { name: "참가자 보기" }).click();
  await page
    .getByRole("article")
    .filter({ hasText: "가온님과의 만남 요청을 승인했어요" })
    .getByRole("button", { name: "공간 열기" })
    .click();
  await expect(
    page.getByText(
      "입장 요청을 보냈어요. 승인되면 공간 목록이 자동으로 갱신돼요.",
    ),
  ).toBeVisible();
  await expect
    .poll(() => spaceJoinRequests)
    .toContain(approvalRequiredSpace.id);

  await page.goto("/");
  await page.locator(".language-picker select").selectOption("en");
  await page
    .locator(".space-card")
    .filter({ hasText: space.name })
    .locator("button.space-cover")
    .click();
  await page
    .getByRole("dialog", { name: space.name })
    .getByRole("button", { name: "Enter campus" })
    .click();
  await expect(page.locator(".connection-status")).toHaveText("Connected");
  const participantsPanel = page.locator(".info-panel");
  if (!(await participantsPanel.isVisible()))
    await page.getByRole("button", { name: "View participants" }).click();
  await expect(participantsPanel).toBeVisible();
  await page
    .getByRole("button", { name: "View 캠퍼스 친구's profile" })
    .click();
  const profileDialog = page.getByRole("dialog", {
    name: "캠퍼스 친구's profile",
  });
  await expect(profileDialog).toBeVisible();
  const profileCard = profileDialog.locator(".participant-profile-card");
  await profileCard.getByRole("button", { name: "Add friend" }).click();
  await expect(profileCard.getByRole("status")).toHaveText(
    "Could not update friends. Please try again shortly.",
  );
  await expect(
    page.getByText("친구 요청을 보낼 수 없어요. 잠시 후 다시 시도해 주세요.", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(friendRequestTargets).toEqual([peerId]);

  await profileCard.getByRole("button", { name: "Close" }).click();
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("checkbox", { name: /Allow pokes/ }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Could not save your poke preference.",
  );
  await expect(
    page.getByText(
      "찌르기 수신 설정을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.",
      {
        exact: true,
      },
    ),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Participants" }).click();
  const savedBlocks = page.locator(".saved-blocks");
  await savedBlocks.locator("summary").click();
  await savedBlocks.getByRole("button", { name: "Unblock" }).click();
  await expect(savedBlocks.getByRole("alert")).toHaveText(
    "Could not unblock this account.",
  );
  await expect(
    page.getByText("차단을 해제할 수 없어요. 잠시 후 다시 시도해 주세요.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "View chat" }).click();
  await page.getByRole("tab", { name: "Messages" }).click();
  await page
    .getByRole("button", { name: new RegExp(groupDisplayName) })
    .click();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  const groupDialog = page.getByRole("dialog", { name: "Group members" });
  await expect(groupDialog.getByRole("status")).toHaveText(
    "Could not load group members.",
  );
  await expect(
    page.getByText(
      "그룹 멤버 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
      {
        exact: true,
      },
    ),
  ).toHaveCount(0);
  await groupDialog.getByRole("button", { name: "Hide window" }).click();
  await page
    .getByRole("group", { name: "Hidden windows" })
    .getByRole("button", { name: "Group members Restore" })
    .click();
  await expect(groupDialog).toBeVisible();
  await groupDialog
    .locator(".dialog-heading")
    .getByRole("button", { name: "Close" })
    .click();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(groupDialog.getByLabel("Group name")).toHaveValue(
    groupDisplayName,
  );
  await groupDialog.getByLabel("Group name").fill("Renamed project");
  await groupDialog.getByRole("button", { name: "Save" }).click();
  await expect(groupDialog.getByRole("status")).toHaveText(
    "Could not save the group name.",
  );
  await groupDialog
    .locator(".group-managed-member")
    .filter({ hasText: "캠퍼스 친구" })
    .getByRole("button", { name: "Remove" })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Confirm this action",
  });
  await expect(confirmation).toContainText(
    "Remove 캠퍼스 친구 from the group conversation?",
  );
  await confirmation.getByRole("button", { name: "Confirm" }).click();
  await expect(groupDialog.getByRole("status")).toHaveText(
    "Could not remove the member.",
  );
  await expect(
    page.getByText(
      "그룹 멤버를 내보낼 수 없어요. 잠시 후 다시 시도해 주세요.",
      { exact: true },
    ),
  ).toHaveCount(0);
  expect(groupManagementRequests.map(({ method }) => method)).toEqual([
    "GET",
    "GET",
    "PATCH",
    "DELETE",
    "GET",
  ]);
});
