import { test, expect } from "@playwright/test";

import { authApi } from "../fixtures/auth-api";
import type { MapDefinition } from "../../src/generated/protocol";
import type { Space } from "../../src/spaces/client";

const sourceSpaceId = "10000000-0000-4000-8000-000000000001";
const targetSpaceId = "20000000-0000-4000-8000-000000000002";
const targetMapId = "destination-map";

const sourceSpace: Space = {
  id: sourceSpaceId,
  name: "출발 공간",
  description: "포털을 시험하는 공간",
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
const targetSpace: Space = {
  ...sourceSpace,
  id: targetSpaceId,
  name: "목적 공간",
  description: "포털의 도착 공간",
};
const sourceMap: MapDefinition = {
  schemaVersion: 2,
  id: "source-map",
  revision: "source-revision",
  name: "출발 지도",
  width: 32,
  height: 24,
  spawnX: 16,
  spawnY: 12,
  collisions: [],
  objects: [
    {
      id: "asset-load-check",
      asset: "campus-tree-large",
      x: 5,
      y: 5,
      scale: 2,
    },
  ],
  zones: [
    {
      id: "public",
      name: "광장",
      kind: "PUBLIC",
      bounds: { x: 0, y: 0, width: 32, height: 24 },
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
  portals: [
    {
      id: "portal-to-destination",
      name: "목적 공간으로",
      bounds: { x: 15, y: 8, width: 2, height: 2 },
      targetSpaceId,
      targetMapId,
      targetSpawnX: 10,
      targetSpawnY: 10,
    },
  ],
};
const targetMap: MapDefinition = {
  ...sourceMap,
  id: targetMapId,
  revision: "destination-revision",
  name: "목적 지도",
  portals: [],
};

test("clicking a world portal carries its published source into destination admission", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  await page.addInitScript(() => {
    localStorage.setItem("hufs.language", "en");
  });

  const admissions: { spaceId: string; body: Record<string, unknown> }[] = [];
  let blockAssetRequests = true;
  let failedAssetRequests = 0;
  let successfulAssetRequests = 0;
  await page.route("**/assets/tree_deciduous_huge_1.png", async (route) => {
    if (blockAssetRequests) {
      failedAssetRequests += 1;
      return route.abort("failed");
    }
    successfulAssetRequests += 1;
    return route.continue();
  });
  await page.route("**/api/v1/bootstrap", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        protocolVersion: 2,
        mode: "sso",
        storage: "mariadb",
        space: { id: sourceSpaceId, name: sourceSpace.name, capacity: 100 },
        map: sourceMap,
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
    const url = new URL(request.url());
    const path = url.pathname;
    let body: unknown = [];
    if (path === "/api/v1/spaces") {
      body = {
        items: [sourceSpace, targetSpace],
        page: 1,
        pageSize: 12,
        totalItems: 2,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
      };
    } else if (path.endsWith("/admission")) {
      const spaceId = path.split("/").at(-2)!;
      const requestBody = request.postDataJSON() as Record<string, unknown>;
      admissions.push({ spaceId, body: requestBody });
      body = {
        ticket: `ui-fixture-ticket-${admissions.length}`,
        expiresInSeconds: 30,
      };
    } else if (path.endsWith("/assets")) {
      body = [];
    } else if (path === `/api/v1/spaces/${sourceSpaceId}`) {
      body = sourceSpace;
    } else if (path === `/api/v1/spaces/${targetSpaceId}`) {
      body = targetSpace;
    } else if (path.endsWith("/ownership-transfers/incoming")) {
      body = [];
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.routeWebSocket("**/world/socket", (socket) => {
    const map =
      admissions.at(-1)?.spaceId === targetSpaceId ? targetMap : sourceMap;
    socket.onMessage((message) => {
      if (typeof message !== "string" || JSON.parse(message).type !== "join")
        return;
      if (map.id !== sourceMap.id)
        socket.send(JSON.stringify({ type: "mapChanged", map }));
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
              id: "fixture-player",
              name: "외대 친구",
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
            },
          ],
          removedPlayerIds: [],
          mapRevision: map.revision,
          rooms: [],
        }),
      );
    });
  });

  await page.goto("/");
  const sourceCard = page
    .getByRole("article")
    .filter({ hasText: sourceSpace.name });
  await sourceCard.getByRole("button", { name: /^(입장하기|Enter)$/ }).click();
  const sourceDialog = page.getByRole("dialog", { name: sourceSpace.name });
  await sourceDialog
    .getByRole("button", { name: /캠퍼스 입장하기|Enter campus/ })
    .click();
  const world = page.getByRole("application", {
    name: "출발 지도 virtual space",
  });
  await expect(world).toBeVisible();
  const assetError = page
    .getByRole("alert")
    .filter({ hasText: /Could not load the .* asset/ });
  await expect(assetError).toContainText(
    "Could not load the 큰 도트 나무 asset.",
  );
  expect(failedAssetRequests).toBeGreaterThan(0);
  blockAssetRequests = false;
  await assetError.getByRole("button", { name: "Try again" }).click();
  await expect(assetError).toHaveCount(0);
  await expect.poll(() => successfulAssetRequests).toBeGreaterThan(0);
  const canvas = page.locator(".world-canvas canvas");
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      admissions.some((admission) => admission.spaceId === sourceSpaceId),
    )
    .toBe(true);

  await canvas.click({ position: { x: 512, y: 288 } });
  const targetDialog = page.getByRole("dialog", { name: targetSpace.name });
  await expect(targetDialog).toBeVisible();
  await targetDialog
    .getByRole("button", { name: /캠퍼스 입장하기|Enter campus/ })
    .click();
  await expect
    .poll(() =>
      admissions.some((admission) => admission.spaceId === targetSpaceId),
    )
    .toBe(true);
  expect(
    admissions.filter((admission) => admission.spaceId === targetSpaceId),
  ).not.toHaveLength(0);
  for (const admission of admissions.filter(
    (item) => item.spaceId === targetSpaceId,
  ))
    expect(admission).toEqual({
      spaceId: targetSpaceId,
      body: {
        mapId: targetMapId,
        sourceSpaceId,
        sourceMapId: sourceMap.id,
        portalId: "portal-to-destination",
      },
    });
  await expect(
    page.getByRole("application", { name: "목적 지도 virtual space" }),
  ).toBeVisible();
});
