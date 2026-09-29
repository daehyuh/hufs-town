import { test, expect } from "@playwright/test";
import { authApi } from "../fixtures/auth-api";
import type { MapDefinition } from "../../src/generated/protocol";
import type { Space } from "../../src/spaces/client";

const spaceId = "30000000-0000-4000-8000-000000000003";
const fallbackMap: MapDefinition = {
  schemaVersion: 2,
  id: "fallback-map",
  revision: "fallback-revision",
  name: "기본 캠퍼스 지도",
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
      id: "lawn",
      material: "GRASS",
      bounds: { x: 0, y: 0, width: 24, height: 18 },
    },
  ],
  walls: [],
  labels: [],
};
const meetupMap: MapDefinition = {
  ...fallbackMap,
  id: spaceId,
  revision: "meetup-hall-revision",
  name: "GDG 밋업 홀 기본 지도",
  floors: [
    {
      id: "hall",
      material: "OAK",
      bounds: { x: 0, y: 0, width: 24, height: 18 },
    },
  ],
  objects: [{ id: "stage", asset: "stage", x: 12, y: 4, scale: 1 }],
};

test("choose a starter template, create its room, preview its map, and enter", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });

  const created: Space[] = [];
  const publishedMapRequests: string[] = [];
  const admissions: string[] = [];
  await page.route("**/api/v1/bootstrap", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        protocolVersion: 2,
        mode: "sso",
        storage: "mariadb",
        space: { id: "default-space", name: "기본 공간", capacity: 100 },
        map: fallbackMap,
        worldPath: "/world/socket",
        features: {
          movement: true,
          running: true,
          emotes: true,
          spaces: true,
          media: false,
          editor: true,
        },
      }),
    }),
  );
  await page.route("**/api/v1/spaces**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let body: unknown = [];

    if (path === "/api/v1/spaces" && request.method() === "GET") {
      body = {
        items: created,
        page: Number(url.searchParams.get("page") ?? 1),
        pageSize: 12,
        totalItems: created.length,
        totalPages: Math.max(1, Math.ceil(created.length / 12)),
        hasNext: false,
        hasPrevious: false,
      };
    } else if (path === "/api/v1/spaces" && request.method() === "POST") {
      const draft = request.postDataJSON();
      expect(draft.templateId).toBe("MEETUP_HALL");
      const space: Space = {
        ...draft,
        id: spaceId,
        role: "OWNER",
        approvalRequired: false,
        joinRequestStatus: "",
        favorite: false,
      };
      created.push(space);
      body = space;
    } else if (path === `/api/v1/spaces/${spaceId}/maps/${spaceId}/published`) {
      publishedMapRequests.push(path);
      body = meetupMap;
    } else if (path === `/api/v1/spaces/${spaceId}/admission`) {
      admissions.push(path);
      body = { ticket: "template-flow-ticket", expiresInSeconds: 30 };
    } else if (path === `/api/v1/spaces/${spaceId}/assets`) {
      body = [];
    } else if (path.endsWith("/ownership-transfers/incoming")) {
      body = [];
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.routeWebSocket("**/world/socket", (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== "string" || JSON.parse(message).type !== "join")
        return;
      socket.send(JSON.stringify({ type: "mapChanged", map: meetupMap }));
      socket.send(
        JSON.stringify({
          type: "welcome",
          protocolVersion: 2,
          playerId: "template-flow-player",
          resumeToken: "template-flow-resume",
          epoch: 1,
          mapRevision: meetupMap.revision,
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
          players: [
            {
              id: "template-flow-player",
              name: "외대 친구",
              avatar: 1,
              skin: "light",
              clothing: "casual_white",
              hair: "hair_short_black",
              x: meetupMap.spawnX,
              y: meetupMap.spawnY,
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
            },
          ],
          removedPlayerIds: [],
          mapRevision: meetupMap.revision,
          rooms: [],
        }),
      );
    });
  });

  await page.goto("/");
  await page
    .getByRole("button", { name: "새 공간 만들기", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "새로운 공간 만들기" });
  await dialog.getByLabel("공간 이름", { exact: true }).fill("GDG 밋업 라운지");
  await dialog.getByRole("radio", { name: /GDG 밋업 홀/ }).check();
  await dialog.getByRole("radio", { name: /^공개 모든/ }).check();
  await dialog
    .getByRole("button", { name: "공간 만들기", exact: true })
    .click();

  const card = page.getByRole("article").filter({ hasText: "GDG 밋업 라운지" });
  await expect(card).toContainText("GDG 밋업 홀");
  const preview = card.locator(".office-preview");
  await preview.scrollIntoViewIfNeeded();
  await expect.poll(() => publishedMapRequests.length).toBeGreaterThan(0);
  await expect
    .poll(() => preview.evaluate((canvas: HTMLCanvasElement) => canvas.width))
    .toBe(560);

  await card.getByRole("button", { name: "입장하기", exact: false }).click();
  const enterDialog = page.getByRole("dialog", { name: "GDG 밋업 라운지" });
  await enterDialog.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect.poll(() => admissions.length).toBeGreaterThan(0);
  await expect(
    page.getByRole("application", { name: "GDG 밋업 홀 기본 지도 가상 공간" }),
  ).toBeVisible();
});
