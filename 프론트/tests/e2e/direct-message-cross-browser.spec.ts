import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { MapDefinition } from "../../src/generated/protocol";
import type { Space } from "../../src/spaces/client";

const spaceId = "60000000-0000-4000-8000-000000000006";
const conversationId = "60000000-0000-4000-8000-000000000007";
const map: MapDefinition = {
  schemaVersion: 2,
  id: "dm-cross-browser-map",
  revision: "dm-cross-browser-revision",
  name: "DM 캠퍼스",
  width: 24,
  height: 18,
  spawnX: 12,
  spawnY: 9,
  collisions: [],
  objects: [],
  zones: [
    {
      id: "public",
      name: "광장",
      kind: "PUBLIC",
      bounds: { x: 0, y: 0, width: 24, height: 18 },
    },
  ],
  floors: [
    {
      id: "grass",
      material: "GRASS",
      bounds: { x: 0, y: 0, width: 24, height: 18 },
    },
  ],
  walls: [],
  labels: [],
};

type User = {
  id: string;
  playerId: string;
  name: string;
  role: "OWNER" | "MEMBER";
};
type Message = {
  type: "chatEvent";
  messageId: string;
  clientMessageId: string;
  channel: "dm";
  conversationId: string;
  senderId: string;
  senderName: string;
  avatar: number;
  skin: string;
  clothing: string;
  hair: string;
  text: string;
  sentAt: number;
  zoneId: string;
  revision: number;
  editedAt: number;
  deleted: boolean;
};

const users: User[] = [
  {
    id: "dm-sender-account",
    playerId: "dm-sender-player",
    name: "메시지 보낸 사람",
    role: "OWNER",
  },
  {
    id: "dm-receiver-account",
    playerId: "dm-receiver-player",
    name: "메시지 받은 사람",
    role: "MEMBER",
  },
];
const space: Space = {
  id: spaceId,
  name: "DM 캠퍼스",
  description: "두 사용자 메시지 확인 공간",
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

async function installUserRoutes(
  page: Page,
  user: User,
  state: {
    sockets: Map<string, { send(message: string): void }>;
    messages: Message[];
    conversationCreated: boolean;
    readBy: Set<string>;
  },
) {
  const peer = users.find((candidate) => candidate.id !== user.id)!;
  const account = {
    userId: user.id,
    displayName: user.name,
    avatar: user === users[0] ? 1 : 2,
    skin: "light",
    clothing: "casual_white",
    hair: "hair_short_black",
    bio: "",
    links: [],
    allowPokes: true,
  };

  await page.route("**/api/v1/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname.split("/").at(-1);
    const body =
      path === "config"
        ? { mode: "sso", configured: true, provider: "GDG HUFS SSO" }
        : path === "csrf"
          ? { headerName: "X-CSRF-TOKEN", token: "dm-cross-browser-csrf" }
          : path === "deletion-impact"
            ? { ownedSpaces: [] }
            : account;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
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
    const path = new URL(route.request().url()).pathname;
    const ownedSpace = { ...space, role: user.role };
    const body =
      path === "/api/v1/spaces"
        ? {
            items: [ownedSpace],
            page: 1,
            pageSize: 12,
            totalItems: 1,
            totalPages: 1,
            hasNext: false,
            hasPrevious: false,
          }
        : path.endsWith("/admission")
          ? { ticket: `ticket-${user.id}`, expiresInSeconds: 30 }
          : path.endsWith("/ownership-transfers/incoming") ||
              path.endsWith("/assets")
            ? []
            : ownedSpace;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route("**/api/v1/dms**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = [];
    if (path === "/api/v1/dms" && state.conversationCreated) {
      const latest = state.messages.at(-1);
      body = [
        {
          conversationId,
          kind: "DIRECT",
          displayName: peer.name,
          participantCount: 2,
          avatar: peer === users[0] ? 1 : 2,
          skin: "light",
          clothing: "casual_white",
          hair: "hair_short_black",
          lastMessage: latest?.text ?? null,
          lastMessageAt: latest?.sentAt ?? null,
          unreadCount:
            latest &&
            latest.senderId !== user.playerId &&
            !state.readBy.has(user.id)
              ? 1
              : 0,
          owner: false,
        },
      ];
    } else if (path.endsWith("/messages")) {
      body = state.messages.map((message) => ({
        ...message,
        own: message.senderId === user.playerId,
        readByCount: state.readBy.has(user.id) ? 1 : 0,
      }));
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.routeWebSocket("**/world/socket", (socket) => {
    state.sockets.set(user.playerId, socket);
    const broadcast = (message: object) => {
      for (const client of state.sockets.values())
        client.send(JSON.stringify(message));
    };
    socket.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const message = JSON.parse(raw) as Record<string, unknown>;
      if (message.type === "join") {
        const player = (candidate: User) => ({
          id: candidate.playerId,
          name: candidate.name,
          avatar: candidate === users[0] ? 1 : 2,
          skin: "light",
          clothing: "casual_white",
          hair: "hair_short_black",
          x: candidate === users[0] ? 12 : 13,
          y: 9,
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
        });
        socket.send(
          JSON.stringify({
            type: "welcome",
            protocolVersion: 2,
            playerId: user.playerId,
            resumeToken: `resume-${user.id}`,
            epoch: 1,
            mapRevision: map.revision,
            tickMs: 50,
            features: [],
          }),
        );
        socket.send(
          JSON.stringify({
            type: "snapshot",
            tick: 1,
            serverTime: Date.now(),
            full: true,
            baseTick: -1,
            inputAckSeq: -1,
            players: users.map(player),
            removedPlayerIds: [],
            mapRevision: map.revision,
            rooms: [],
          }),
        );
      } else if (message.type === "directConversationRequest") {
        state.conversationCreated = true;
        socket.send(
          JSON.stringify({
            type: "directConversationResult",
            requestId: message.requestId,
            targetPlayerId: peer.playerId,
            accepted: true,
            conversationId,
            code: "",
            message: "대화를 시작했어요.",
          }),
        );
      } else if (message.type === "chatSend") {
        const chat: Message = {
          type: "chatEvent",
          messageId: `dm-message-${state.messages.length + 1}`,
          clientMessageId: String(message.clientMessageId),
          channel: "dm",
          conversationId,
          senderId: user.playerId,
          senderName: user.name,
          avatar: user === users[0] ? 1 : 2,
          skin: "light",
          clothing: "casual_white",
          hair: "hair_short_black",
          text: String(message.text),
          sentAt: Date.now(),
          zoneId: "public",
          revision: 0,
          editedAt: 0,
          deleted: false,
        };
        state.messages.push(chat);
        socket.send(
          JSON.stringify({
            type: "chatAck",
            clientMessageId: chat.clientMessageId,
            accepted: true,
            code: "",
            message: "전달했어요.",
          }),
        );
        broadcast(chat);
      } else if (message.type === "directMessageReadRequest") {
        state.readBy.add(user.id);
        broadcast({
          type: "directMessageReadAck",
          requestId: message.requestId,
          conversationId,
          messageId: message.messageId,
          accepted: true,
          code: "",
          message: "읽음 처리했어요.",
        });
      }
    });
  });
}

async function enterSpace(page: Page) {
  const card = page.getByRole("article").filter({ hasText: space.name });
  await card.getByRole("button", { name: "입장하기", exact: false }).click();
  await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect(page.locator(".connection-status")).toHaveText("연결됨");
  await expect(page.locator(".world-canvas")).toBeVisible();
  await expect(page.locator(".app-header .brand")).toHaveText(
    "GDG HUFS 훕스타운",
  );
}

test("DM delivery updates the other browser inbox and unread receipt", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  const state = {
    sockets: new Map<string, { send(message: string): void }>(),
    messages: [] as Message[],
    conversationCreated: false,
    readBy: new Set<string>(),
  };

  try {
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    await Promise.all(
      pages.map((page, index) => installUserRoutes(page, users[index], state)),
    );
    await Promise.all(pages.map((page) => page.goto("/")));
    await Promise.all(pages.map(enterSpace));

    const [sender, receiver] = pages;
    await sender.getByRole("button", { name: "참가자 보기" }).click();
    await sender
      .getByRole("button", {
        name: `${users[1].name}님에게 1:1 메시지 보내기`,
      })
      .click();
    await expect(
      sender.getByText("나와 상대방만 볼 수 있는 대화예요"),
    ).toBeVisible();

    const text = "다른 브라우저까지 도착하는 개인 메시지";
    await sender.getByRole("textbox", { name: "채팅 메시지" }).fill(text);
    await sender.getByRole("button", { name: "메시지 보내기" }).click();
    await expect(sender.getByText(text)).toBeVisible();

    await expect(
      receiver.getByRole("button", { name: /채팅 보기, 읽지 않은 메시지 1개/ }),
    ).toBeVisible();
    await receiver
      .getByRole("button", { name: /채팅 보기, 읽지 않은 메시지 1개/ })
      .click();
    await receiver.getByRole("tab", { name: "메시지" }).click();
    const conversation = receiver
      .getByRole("button", { name: new RegExp(users[0].name) })
      .filter({ has: receiver.locator(".dm-unread") });
    await expect(conversation).toBeVisible();
    await conversation.click();
    await expect(receiver.getByText(text)).toBeVisible();
    await expect.poll(() => state.readBy.has(users[1].id)).toBe(true);
    await receiver.getByRole("button", { name: "← 대화 목록" }).click();
    await expect(receiver.locator(".dm-unread")).toHaveCount(0);
    expect(state.messages).toHaveLength(1);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("mobile DM supports keyboard send, usable touch targets, and accessible layout", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const state = {
    sockets: new Map<string, { send(message: string): void }>(),
    messages: [] as Message[],
    conversationCreated: false,
    readBy: new Set<string>(),
  };

  try {
    const page = await context.newPage();
    await installUserRoutes(page, users[0], state);
    await page.goto("/");
    await enterSpace(page);
    await page.getByRole("button", { name: "참가자 보기" }).click();
    await page
      .getByRole("button", {
        name: `${users[1].name}님에게 1:1 메시지 보내기`,
      })
      .click();

    const chatPanel = page.locator(".info-panel").filter({
      has: page.locator(".chat-panel-content"),
    });
    await expect(
      chatPanel.getByText("나와 상대방만 볼 수 있는 대화예요"),
    ).toBeVisible();
    const input = chatPanel.getByRole("textbox", { name: "채팅 메시지" });
    await expect(input).toHaveCSS("font-size", "16px");
    const send = chatPanel.getByRole("button", { name: "메시지 보내기" });
    const back = chatPanel.getByRole("button", { name: "← 대화 목록" });
    await input.fill("모바일에서 Enter로 보내는 메시지");
    await input.press("Enter");
    await expect(
      chatPanel.getByText("모바일에서 Enter로 보내는 메시지"),
    ).toBeVisible();
    await expect.poll(() => state.messages).toHaveLength(1);

    const sendBounds = await send.boundingBox();
    expect(sendBounds?.width).toBeGreaterThanOrEqual(44);
    expect(sendBounds?.height).toBeGreaterThanOrEqual(44);
    const backBounds = await back.boundingBox();
    expect(backBounds?.height).toBeGreaterThanOrEqual(44);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);

    const accessibility = await new AxeBuilder({ page })
      .include(".info-panel")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      accessibility.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  } finally {
    await context.close();
  }
});

test("mobile friend management supports search and preferences accessibly", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const state = {
    sockets: new Map<string, { send(message: string): void }>(),
    messages: [] as Message[],
    conversationCreated: false,
    readBy: new Set<string>(),
  };
  const actions: Array<{ method: string; path: string; body?: unknown }> = [];
  let preferences = {
    allowFriendRequests: true,
    allowFriendNotifications: true,
    sharePresenceWithFriends: false,
  };

  try {
    const page = await context.newPage();
    await installUserRoutes(page, users[0], state);
    await page.route("**/api/v1/me/friends**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      const path = url.pathname;
      let body: unknown;
      if (path.endsWith("/preferences")) {
        if (method === "PUT") {
          preferences = route.request().postDataJSON();
          actions.push({ method, path, body: preferences });
        }
        body = preferences;
      } else if (path.endsWith("/search")) {
        body = url.searchParams.get("q")
          ? [
              {
                userId: "friend-search-result",
                displayName: "검색된 친구",
                relationship: actions.some(
                  (action) =>
                    action.method === "POST" &&
                    action.path === "/api/v1/me/friends/requests",
                )
                  ? "OUTGOING"
                  : "AVAILABLE",
              },
            ]
          : [];
      } else if (path === "/api/v1/me/friends/requests" && method === "POST") {
        actions.push({ method, path, body: route.request().postDataJSON() });
        body = { id: "friend-request-1", status: "PENDING" };
      } else if (path === "/api/v1/me/friends") {
        body = { friends: [], incoming: [], outgoing: [] };
      } else {
        body = { code: "NOT_FOUND", message: "Not found" };
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

    await page.goto("/");
    await enterSpace(page);
    await page.getByRole("button", { name: "참가자 보기" }).click();
    await page.getByRole("button", { name: "친구", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "친구" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("친구 요청 받기")).toBeVisible();

    const search = dialog.getByRole("searchbox", { name: "친구 이름 검색" });
    await expect(search).toHaveCSS("font-size", "16px");
    await search.fill("검색된 친구");
    const request = dialog.getByRole("button", { name: "친구 요청" });
    await expect(request).toBeVisible();
    const requestBounds = await request.boundingBox();
    expect(requestBounds?.height).toBeGreaterThanOrEqual(44);
    await request.click();
    await expect(
      dialog.getByRole("status").filter({
        hasText: "검색된 친구님에게 친구 요청을 보냈어요.",
      }),
    ).toBeVisible();
    await expect
      .poll(() => actions)
      .toContainEqual({
        method: "POST",
        path: "/api/v1/me/friends/requests",
        body: { targetUserId: "friend-search-result" },
      });

    const presence = dialog.getByRole("checkbox", {
      name: "친구에게 온라인 상태 공개",
    });
    await presence.check();
    await expect(presence).toBeChecked();
    await expect.poll(() => preferences.sharePresenceWithFriends).toBe(true);

    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);

    const accessibility = await new AxeBuilder({ page })
      .include("dialog.town-dialog")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      accessibility.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
    ).toEqual([]);

    await dialog.getByRole("button", { name: "닫기" }).click();
    await page
      .locator(".app-header .language-picker select")
      .selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.getByRole("button", { name: "Friends", exact: true }).click();
    const englishDialog = page.getByRole("dialog", { name: "Friends" });
    await expect(
      englishDialog.getByText("Allow friend requests"),
    ).toBeVisible();
    const englishSearch = englishDialog.getByRole("searchbox", {
      name: "Search friends by name",
    });
    await expect(englishSearch).toHaveCSS("font-size", "16px");
    const englishPresence = englishDialog.getByRole("checkbox", {
      name: "Share online status with friends",
    });
    await expect(englishPresence).toBeChecked();
    await expect(
      englishDialog.getByText("Browser notifications for friend requests"),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const englishAccessibility = await new AxeBuilder({ page })
      .include("dialog.town-dialog")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      englishAccessibility.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  } finally {
    await context.close();
  }
});
