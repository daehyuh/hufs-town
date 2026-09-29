import { expect, test } from "@playwright/test";
import { authApi } from "../fixtures/auth-api";

const spaceId = "browser-compat-guest-space";
const map = {
  schemaVersion: 2 as const,
  id: "browser-compat-map",
  revision: "browser-compat-map-v1",
  name: "브라우저 확인 광장",
  width: 24,
  height: 18,
  spawnX: 12,
  spawnY: 9,
  collisions: [],
  objects: [
    {
      id: "keyboard-npc",
      asset: "desk-monitor",
      x: 12,
      y: 9,
      scale: 1,
      direction: "down",
      interaction: {
        kind: "NPC",
        title: "키보드 안내원",
        body: "E 키로 가까운 오브젝트와 상호작용할 수 있어요.",
      },
    },
  ],
  zones: [
    {
      id: "public",
      name: "광장",
      kind: "PUBLIC" as const,
      bounds: { x: 0, y: 0, width: 24, height: 18 },
    },
  ],
  floors: [
    {
      id: "floor",
      material: "GRASS" as const,
      bounds: { x: 0, y: 0, width: 24, height: 18 },
    },
  ],
  walls: [],
  labels: [],
};

test("anonymous guest can join, render the world, and see browser media guidance", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await authApi(page);
  await page.route("**/api/v1/bootstrap", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        protocolVersion: 2,
        mode: "sso",
        storage: "mariadb",
        space: { id: spaceId, name: "브라우저 확인 광장", capacity: 100 },
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
          editor: false,
        },
      }),
    }),
  );
  await page.route(`**/api/v1/guest/spaces/${spaceId}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: spaceId,
        name: "브라우저 확인 광장",
        description: "브라우저 호환성 확인용 공개 광장",
        capacity: 100,
      }),
    }),
  );
  await page.route(`**/api/v1/guest/spaces/${spaceId}/admission`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ticket: "browser-compat-ticket",
        expiresInSeconds: 30,
      }),
    }),
  );
  await page.routeWebSocket("**/world/socket", (socket) => {
    let tick = 0;
    const player = {
      id: "browser-compat-player",
      name: "브라우저 확인 친구",
      avatar: 1,
      skin: "light",
      clothing: "casual_white",
      hair: "hair_short_black",
      x: map.spawnX,
      y: map.spawnY,
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
    };
    socket.onMessage((frame) => {
      if (typeof frame !== "string") return;
      const message = JSON.parse(frame) as { type?: string; seq?: number };
      if (message.type !== "join" && message.type !== "move") return;
      if (message.type === "join") {
        socket.send(
          JSON.stringify({
            type: "welcome",
            protocolVersion: 2,
            playerId: player.id,
            resumeToken: "browser-compat-resume",
            epoch: 1,
            mapRevision: map.revision,
            tickMs: 50,
            features: [],
          }),
        );
      }
      tick++;
      socket.send(
        JSON.stringify({
          type: "snapshot",
          tick,
          serverTime: Date.now(),
          full: true,
          baseTick: -1,
          inputAckSeq: message.type === "move" ? (message.seq ?? -1) : -1,
          players: [player],
          removedPlayerIds: [],
          mapRevision: map.revision,
          rooms: [],
        }),
      );
    });
  });

  await page.goto(`/#space=${spaceId}`);
  const guestDialog = page.getByRole("dialog", {
    name: "브라우저 확인 광장 · 게스트 입장",
  });
  await expect(guestDialog).toBeVisible();
  await expect(guestDialog).toContainText("로그인 없이 둘러볼 수 있어요");
  await expect(
    guestDialog.getByPlaceholder("이름이나 닉네임을 알려주세요"),
  ).toBeVisible();

  await guestDialog
    .getByRole("button", { name: "입장 전 마이크·카메라 확인" })
    .click();
  const mediaDialog = page.getByRole("dialog", { name: "입장 전 장치 확인" });
  await expect(mediaDialog).toBeVisible();
  await expect(mediaDialog).toContainText(
    "마이크와 카메라는 테스트를 누를 때만 켜져요",
  );
  await expect(
    mediaDialog.getByRole("button", { name: "스피커 테스트" }),
  ).toBeVisible();

  const mediaSupport = await page.evaluate(() => ({
    secureContext: window.isSecureContext,
    getUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
    getDisplayMedia:
      typeof navigator.mediaDevices?.getDisplayMedia === "function",
  }));
  await testInfo.attach("media-api-support.json", {
    body: JSON.stringify(mediaSupport),
    contentType: "application/json",
  });
  expect(mediaSupport.secureContext).toBe(true);
  if (mediaSupport.getUserMedia) {
    await expect(mediaDialog.getByRole("status")).toHaveCount(0);
    await expect(
      mediaDialog.getByRole("button", { name: "마이크 테스트" }),
    ).toBeEnabled();
    await expect(
      mediaDialog.getByRole("button", { name: "미리보기" }),
    ).toBeEnabled();
  } else {
    await expect(mediaDialog.getByRole("status")).toContainText(
      "이 브라우저에서는 마이크·카메라 장치 확인을 지원하지 않아요.",
    );
    await expect(
      mediaDialog.getByRole("button", { name: "마이크 테스트" }),
    ).toBeDisabled();
    await expect(
      mediaDialog.getByRole("button", { name: "미리보기" }),
    ).toBeDisabled();
  }
  // Screen-capture availability is attached as evidence; this preflight only
  // offers microphone/camera checks.
  await mediaDialog.getByRole("button", { name: "나중에" }).click();

  await guestDialog
    .getByPlaceholder("이름이나 닉네임을 알려주세요")
    .fill(`${testInfo.project.name} 친구`);
  await guestDialog.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect(page.locator(".connection-status")).toHaveText("연결됨");
  const world = page.getByRole("application", {
    name: "브라우저 확인 광장 가상 공간",
  });
  await expect(world).toBeVisible();
  const canvas = page.locator(".world-canvas canvas");
  await expect(canvas).toBeVisible();
  await expect
    .poll(() => canvas.evaluate((element) => element.clientWidth))
    .toBeGreaterThan(0);

  const worldCanvas = page.locator(".world-canvas");
  await worldCanvas.focus();
  // Enter opens the nearby-chat composer; E runs the focused world object.
  await page.keyboard.press("e");
  const npcDialog = page.getByRole("dialog", { name: "키보드 안내원" });
  await expect(npcDialog).toContainText(
    "E 키로 가까운 오브젝트와 상호작용할 수 있어요.",
  );
  await npcDialog.getByRole("button", { name: "대화 마치기" }).click();
  await worldCanvas.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "가까운 사람에게 보낼 메시지" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "참가자 보기" }).click();
  await page.getByRole("tab", { name: "설정" }).click();
  const lowSpecSetting = page.getByRole("checkbox", { name: /저사양 모드/ });
  await lowSpecSetting.check();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("hufs-town.render-mode")),
    )
    .toBe("low-spec");
  await expect(canvas).toBeVisible();
  expect(pageErrors, `${testInfo.project.name} page errors`).toEqual([]);
});
