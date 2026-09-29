import { expect, test, type Page } from "@playwright/test";

const spaceId = "00000000-0000-4000-8000-000000000001";
const map = {
  schemaVersion: 2 as const,
  id: "onboarding-map",
  revision: "onboarding-revision",
  name: "HUFS 첫걸음 광장",
  width: 32,
  height: 24,
  spawnX: 16,
  spawnY: 12,
  collisions: [],
  objects: [
    {
      id: "shared-board",
      asset: "whiteboard",
      x: 16,
      y: 12,
      scale: 1,
      interaction: {
        kind: "BOARD" as const,
        title: "공동 보드",
        body: "함께 그리는 게시판",
      },
    },
  ],
  zones: [
    {
      id: "public",
      name: "광장",
      kind: "PUBLIC" as const,
      bounds: { x: 0, y: 0, width: 32, height: 24 },
    },
  ],
  floors: [
    {
      id: "floor",
      material: "GRASS" as const,
      bounds: { x: 0, y: 0, width: 32, height: 24 },
    },
  ],
  walls: [],
  labels: [],
};
const space = {
  id: spaceId,
  name: "HUFS 첫걸음 광장",
  description: "온보딩 테스트 공간",
  visibility: "PUBLIC",
  capacity: 100,
  templateId: "CAMPUS_SQUARE",
  role: "MEMBER",
  approvalRequired: false,
  joinRequestStatus: "",
  favorite: false,
};

async function installOnboardingFixture(page: Page) {
  let signedIn = false;
  let userId = "onboarding-user-a";
  let nextUserId = userId;
  let whiteboard = {
    revision: 0,
    strokes: [] as {
      id: string;
      color: string;
      width: number;
      points: { x: number; y: number }[];
    }[],
    updatedAt: 0,
    canClear: true,
  };
  const account = () => ({
    userId,
    displayName: `캠퍼스 친구 ${userId.at(-1)}`,
    avatar: 1,
    skin: "light",
    clothing: "casual_white",
    hair: "hair_short_black",
    bio: "",
    links: [],
    allowPokes: true,
  });

  await page.route("**/api/v1/auth/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const name = path.split("/").at(-1);
    let status = 200;
    let body: object = {};
    if (name === "config")
      body = { mode: "sso", configured: true, provider: "GDG HUFS SSO" };
    else if (name === "csrf")
      body = { headerName: "X-CSRF-TOKEN", token: "test-csrf" };
    else if (name === "me") {
      status = signedIn ? 200 : 401;
      body = signedIn ? account() : { message: "로그인이 필요해요." };
    } else if (name === "exchange") {
      signedIn = true;
      userId = nextUserId;
      body = account();
    } else if (name === "profile")
      body = { ...account(), ...request.postDataJSON() };
    else if (name === "logout" || name === "sessions") {
      signedIn = false;
      body = { loggedOut: true };
    } else if (name === "deletion-impact") body = { ownedSpaces: [] };

    await route.fulfill({
      status,
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
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown = [];
    if (path === "/api/v1/spaces")
      body = {
        items: [space],
        page: 1,
        pageSize: 12,
        totalItems: 1,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
      };
    else if (path.endsWith("/admission"))
      body = { ticket: "onboarding-test-ticket", expiresInSeconds: 30 };
    else if (path.endsWith("/boards/shared-board/whiteboard/operations")) {
      const operation = request.postDataJSON();
      whiteboard =
        operation.kind === "CLEAR"
          ? {
              ...whiteboard,
              revision: whiteboard.revision + 1,
              strokes: [],
              updatedAt: Date.now(),
            }
          : {
              ...whiteboard,
              revision: whiteboard.revision + 1,
              updatedAt: Date.now(),
              strokes: [
                ...whiteboard.strokes,
                { id: operation.operationId, ...operation.stroke },
              ],
            };
      body = whiteboard;
    } else if (path.endsWith("/boards/shared-board/whiteboard"))
      body = whiteboard;
    else if (path.endsWith("/assets")) body = [];
    else if (path.endsWith("/ownership-transfers/incoming")) body = [];
    else if (path === `/api/v1/spaces/${spaceId}`) body = space;

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.routeWebSocket("**/world/socket", (socket) => {
    let x = map.spawnX;
    let y = map.spawnY;
    let tick = 0;
    const self = () => ({
      id: "fixture-player",
      name: `캠퍼스 친구 ${userId.at(-1)}`,
      avatar: 1,
      skin: "light",
      clothing: "casual_white",
      hair: "hair_short_black",
      x,
      y,
      direction: "down",
      moving: false,
      zoneId: "public",
      emoji: "",
      emojiUntil: 0,
      sitting: false,
      status: "AVAILABLE",
      directMessageEnabled: false,
      bio: "",
      links: [],
    });
    const sendSnapshot = (inputAckSeq = -1) => {
      tick += 1;
      socket.send(
        JSON.stringify({
          type: "snapshot",
          tick,
          serverTime: Date.now(),
          full: true,
          baseTick: -1,
          inputAckSeq,
          players: [self()],
          removedPlayerIds: [],
          mapRevision: map.revision,
          rooms: [],
        }),
      );
    };
    socket.onMessage((frame) => {
      if (typeof frame !== "string") return;
      const message = JSON.parse(frame) as Record<string, unknown>;
      if (message.type === "join") {
        socket.send(
          JSON.stringify({
            type: "welcome",
            protocolVersion: 2,
            playerId: "fixture-player",
            resumeToken: "fixture-resume-token",
            epoch: 1,
            mapRevision: map.revision,
            tickMs: 50,
            features: [],
          }),
        );
        sendSnapshot();
      } else if (message.type === "move") {
        const dx = Number(message.dx ?? 0);
        const dy = Number(message.dy ?? 0);
        if (dx || dy) {
          x = Math.max(1, Math.min(map.width - 1, x + dx * 0.22));
          y = Math.max(1, Math.min(map.height - 1, y + dy * 0.22));
        }
        sendSnapshot(Number(message.seq ?? -1));
      } else if (message.type === "chatSend") {
        socket.send(
          JSON.stringify({
            type: "chatEvent",
            messageId: message.clientMessageId,
            clientMessageId: message.clientMessageId,
            channel: message.channel,
            conversationId: message.conversationId ?? "",
            senderId: "fixture-player",
            senderName: `캠퍼스 친구 ${userId.at(-1)}`,
            avatar: 1,
            skin: "light",
            clothing: "casual_white",
            hair: "hair_short_black",
            text: message.text,
            sentAt: Date.now(),
            zoneId: "public",
            revision: 0,
            editedAt: 0,
            deleted: false,
          }),
        );
      }
    });
  });

  return {
    setNextUser(next: string) {
      nextUserId = next;
    },
    async addRemoteStroke() {
      whiteboard = {
        ...whiteboard,
        revision: whiteboard.revision + 1,
        updatedAt: Date.now(),
        strokes: [
          ...whiteboard.strokes,
          {
            id: "90000000-0000-4000-8000-000000000009",
            color: "#dc2626",
            width: 7,
            points: [
              { x: 100, y: 120 },
              { x: 300, y: 360 },
            ],
          },
        ],
      };
    },
  };
}

async function loginThroughCallback(page: Page, language: "ko" | "en" = "ko") {
  await page.goto("/auth/callback?code=test-code&state=test-state");
  await expect(
    page.getByRole("button", {
      name: language === "en" ? "Enter" : /입장하기/,
      exact: language === "en",
    }),
  ).toBeVisible();
}

async function enterCampus(page: Page, language: "ko" | "en" = "ko") {
  const card = page.getByRole("article").filter({ hasText: space.name });
  await card
    .getByRole("button", {
      name: language === "en" ? "Enter" : "입장하기",
      exact: language === "en",
    })
    .click();
  await page
    .getByRole("button", {
      name: language === "en" ? "Enter campus" : "캠퍼스 입장하기",
    })
    .click();
  await expect(page.locator(".world-canvas")).toBeVisible();
}

test("shared whiteboard saves a drawing and syncs another participant", async ({
  page,
}) => {
  const fixture = await installOnboardingFixture(page);
  await loginThroughCallback(page);
  await enterCampus(page);

  await page.locator("canvas").first().focus();
  await page.keyboard.press("KeyE");
  const board = page.getByRole("dialog", { name: "공동 보드" });
  await expect(board).toBeVisible();
  await board.getByRole("button", { name: "공동 화이트보드" }).click();
  const drawingSurface = board.getByRole("img", {
    name: "마우스나 손가락으로 그리는 공간 공동 화이트보드",
  });
  await expect(drawingSurface).toBeVisible();
  await drawingSurface.click({ position: { x: 120, y: 100 } });
  await expect(board.getByRole("status")).toContainText("그림을 저장했고");
  await expect(board.locator(".whiteboard-status")).toContainText("1/300");

  await fixture.addRemoteStroke();
  await expect(board.locator(".whiteboard-status")).toContainText("2/300", {
    timeout: 5000,
  });
  await expect(drawingSurface.locator("polyline")).toHaveCount(2);

  await board.getByRole("button", { name: "전체 지우기" }).click();
  const clearConfirmation = page.getByRole("dialog", {
    name: "작업을 확인해 주세요",
  });
  await expect(clearConfirmation).toContainText(
    "공간 참가자 모두가 볼 수 있는 그림을 전부 지울까요?",
  );
  await clearConfirmation.locator(".dialog-action-secondary").click();
  await expect(drawingSurface.locator("polyline")).toHaveCount(2);

  await board.getByRole("button", { name: "전체 지우기" }).click();
  await page
    .getByRole("dialog", { name: "작업을 확인해 주세요" })
    .locator(".dialog-action-primary")
    .click();
  await expect(board.locator(".whiteboard-status")).toContainText("0/300");
  await expect(drawingSurface.locator("polyline")).toHaveCount(0);
});

for (const language of ["ko", "en"] as const) {
  test(`${language} campus entry skips the first-visit guide and Enter opens nearby chat`, async ({
    page,
  }) => {
    await page.addInitScript((selectedLanguage) => {
      localStorage.setItem("hufs.language", selectedLanguage);
    }, language);
    await installOnboardingFixture(page);
    await page.goto("/");
    await loginThroughCallback(page, language);
    await enterCampus(page, language);

    await expect(page.locator(".onboarding-coach")).toHaveCount(0);
    await expect(
      page.getByText(
        /첫 인사는 가볍게|첫 입장 안내|캠퍼스 사용 설명서|Your first steps in HUFS Town/,
      ),
    ).toHaveCount(0);
    const trigger = page.getByRole("button", {
      name:
        language === "ko"
          ? "Enter로 가까운 사람에게 채팅"
          : "Press Enter to chat with nearby people",
    });
    await expect(trigger).toBeVisible();

    await page.locator("canvas").first().focus();
    await page.keyboard.press("Enter");
    const input = page.getByRole("textbox", {
      name:
        language === "ko"
          ? "가까운 사람에게 보낼 메시지"
          : "Message for nearby people",
    });
    await expect(input).toBeFocused();
  });
}

test("non-admin account cannot discover moderation controls", async ({
  page,
}) => {
  await installOnboardingFixture(page);
  await page.route("**/api/v1/reports/access", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ administrator: false }),
    }),
  );
  await loginThroughCallback(page);
  await enterCampus(page);
  await page.getByRole("button", { name: "채팅 보기" }).click();

  await expect(page.getByRole("button", { name: "신고 검토" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "채팅 보존 설정" }),
  ).toHaveCount(0);
});
