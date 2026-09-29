import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { authApi } from "../fixtures/auth-api";
import type { MapDefinition } from "../../src/generated/protocol";

const spaceId = "62000000-0000-4000-8000-000000000001";
const requestId = "63000000-0000-4000-8000-000000000001";

const map: MapDefinition = {
  schemaVersion: 2,
  id: "meetup-language-map",
  revision: "meetup-language-map-v1",
  name: "GDG HUFS campus",
  width: 24,
  height: 18,
  spawnX: 12,
  spawnY: 9,
  collisions: [],
  objects: [],
  zones: [
    {
      id: "public",
      name: "Campus",
      kind: "PUBLIC",
      bounds: { x: 0, y: 0, width: 24, height: 18 },
    },
  ],
  floors: [
    {
      id: "floor",
      material: "GRASS",
      bounds: { x: 0, y: 0, width: 24, height: 18 },
    },
  ],
  walls: [],
  labels: [],
};

test("meetup requests stay localized and accessible in English", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("hufs.language", "en"));
  await authApi(page, { signedIn: true, displayName: "Alex" });
  await page.route("**/api/v1/bootstrap", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        protocolVersion: 2,
        mode: "sso",
        storage: "mariadb",
        space: { id: spaceId, name: "GDG HUFS campus", capacity: 100 },
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
  await page.route("**/api/v1/reports/access", (route) =>
    route.fulfill({ json: { administrator: false } }),
  );

  let requestStatus: "PENDING" | "APPROVED" = "PENDING";
  await page.route("**/api/v1/me/join-requests**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/outgoing")) {
      await route.fulfill({ json: [] });
      return;
    }
    if (request.method() === "GET") {
      await route.fulfill({
        json: [
          {
            id: requestId,
            displayName: "Jamie",
            message: "Let's talk on campus.",
            status: requestStatus,
            requestedAt: Date.now(),
            expiresAt: Date.now() + 60 * 60 * 1000,
            destinationSpaceId: spaceId,
            destinationSpaceName: "GDG HUFS campus",
          },
        ],
      });
      return;
    }
    if (path.endsWith("/respond")) {
      expect(request.postDataJSON()).toEqual({ decision: "APPROVE" });
      requestStatus = "APPROVED";
      await route.fulfill({ json: { status: "APPROVED" } });
      return;
    }
    await route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
  });

  await page.routeWebSocket("**/world/socket", (socket) => {
    socket.onMessage((frame) => {
      if (typeof frame !== "string") return;
      const message = JSON.parse(frame) as { type?: string };
      if (message.type !== "join") return;
      socket.send(
        JSON.stringify({
          type: "welcome",
          protocolVersion: 2,
          playerId: "meetup-language-self",
          resumeToken: "meetup-language-resume",
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
              id: "meetup-language-self",
              name: "Alex",
              avatar: 1,
              skin: "light",
              clothing: "casual_white",
              hair: "hair_short_black",
              x: 0,
              y: 0,
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
          ],
          removedPlayerIds: [],
          mapRevision: map.revision,
          rooms: [],
        }),
      );
    });
  });

  await page.goto("/");
  const spaceCard = page
    .getByRole("article")
    .filter({ hasText: "GDG HUFS 캠퍼스" });
  await expect(spaceCard).toBeVisible();
  await spaceCard.getByRole("button", { name: "Enter", exact: true }).click();
  await page.getByRole("button", { name: "Enter campus" }).click();
  await expect(page.locator(".connection-status")).toHaveText("Connected");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "View participants" }).click();

  const inbox = page.getByRole("region", { name: "Meetup requests" });
  await expect(inbox).toContainText("Jamie asked to meet up");
  await expect(inbox).toContainText(
    "They suggested meeting at GDG HUFS campus.",
  );
  await expect(inbox).toContainText("Let's talk on campus.");
  await expect(inbox).toContainText(
    "Opening a space follows its visibility and admission approval policy.",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(await inbox.innerText()).not.toMatch(/[가-힣]/);

  const accessibility = await new AxeBuilder({ page })
    .include(".meetup-request-inbox")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    accessibility.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    })),
  ).toEqual([]);

  const requestCard = inbox.getByRole("article");
  await requestCard.getByRole("button", { name: "Approve" }).click();
  await expect(inbox).toContainText(
    "Meetup request approved. Open the requested space to join.",
  );
  await expect(inbox).toContainText("You approved a meetup request from Jamie");
  expect(await inbox.innerText()).not.toMatch(/[가-힣]/);
});
