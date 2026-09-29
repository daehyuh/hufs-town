import { expect, test, type Page } from "@playwright/test";
import type { MapDefinition } from "../../src/generated/protocol";
import type { Space } from "../../src/spaces/client";

const spaceId = "70000000-0000-4000-8000-000000000007";
const inviteCode = "private-room-invite-2026";
const map: MapDefinition = {
  schemaVersion: 2,
  id: "invited-room-map",
  revision: "invited-room-revision",
  name: "초대받은 비밀 정원 기본 지도",
  width: 24,
  height: 18,
  spawnX: 12,
  spawnY: 9,
  collisions: [],
  objects: [],
  zones: [
    {
      id: "public",
      name: "정원",
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

type InviteRecord = {
  id: string;
  expiresAt: string;
  maxUses: number;
  useCount: number;
  revoked: boolean;
  targetUserId: null;
  targetDisplayName: null;
};

function pageOf(items: Space[]) {
  return {
    items,
    page: 1,
    pageSize: 12,
    totalItems: items.length,
    totalPages: Math.max(1, Math.ceil(items.length / 12)),
    hasNext: false,
    hasPrevious: false,
  };
}

async function mockSignedInUser(
  page: Page,
  user: { id: string; name: string },
) {
  const account = {
    userId: user.id,
    displayName: user.name,
    avatar: 1,
    skin: "light",
    clothing: "casual_white",
    hair: "hair_short_black",
    bio: "",
    links: [],
    allowPokes: true,
  };
  await page.route("**/api/v1/auth/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split("/").at(-1);
    if (request.method() !== "GET")
      expect(request.headers()["x-csrf-token"]).toBe("invite-flow-csrf");
    let body: unknown = {};
    if (path === "config")
      body = { mode: "sso", configured: true, provider: "GDG HUFS SSO" };
    else if (path === "csrf")
      body = { headerName: "X-CSRF-TOKEN", token: "invite-flow-csrf" };
    else if (path === "me" || path === "profile") body = account;
    else if (path === "deletion-impact") body = { ownedSpaces: [] };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

test("a different signed-in user redeems a private-room invite and enters", async ({
  browser,
}) => {
  const baseURL = String(test.info().project.use.baseURL);
  const ownerContext = await browser.newContext({
    baseURL,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const guestContext = await browser.newContext({ baseURL });
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();
  const owner = { id: "invite-owner-account", name: "공간 만든 사람" };
  const guest = { id: "invite-guest-account", name: "초대받은 친구" };
  let space: Space | undefined;
  let invite: InviteRecord | undefined;
  let redeemedBy = "";
  const admissions: string[] = [];

  try {
    await mockSignedInUser(ownerPage, owner);
    await mockSignedInUser(guestPage, guest);

    for (const page of [ownerPage, guestPage]) {
      await page.route("**/api/v1/bootstrap", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            protocolVersion: 2,
            mode: "sso",
            storage: "mariadb",
            space: { id: "default-space", name: "기본 공간", capacity: 100 },
            map,
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
        const method = request.method();
        if (method !== "GET")
          expect(request.headers()["x-csrf-token"]).toBe("invite-flow-csrf");

        let status = 200;
        let body: unknown = {};
        if (path === "/api/v1/spaces" && method === "GET") {
          const visible: Space[] =
            url.searchParams.get("view") === "mine" &&
            space &&
            (page === ownerPage || redeemedBy === guest.id)
              ? [
                  {
                    ...space,
                    role:
                      page === ownerPage
                        ? ("OWNER" as const)
                        : ("MEMBER" as const),
                  },
                ]
              : [];
          body = pageOf(visible);
        } else if (path === "/api/v1/spaces" && method === "POST") {
          expect(page).toBe(ownerPage);
          expect(request.postDataJSON()).toMatchObject({
            name: "GDG 비밀 정원",
            visibility: "PRIVATE",
            capacity: 8,
            templateId: "CAMPUS_SQUARE",
          });
          space = {
            ...request.postDataJSON(),
            id: spaceId,
            role: "OWNER",
            approvalRequired: false,
            joinRequestStatus: "",
            favorite: false,
          } as Space;
          body = space;
        } else if (
          path === `/api/v1/spaces/${spaceId}/invites` &&
          method === "GET"
        ) {
          body = invite ? [invite] : [];
        } else if (
          path === `/api/v1/spaces/${spaceId}/invites` &&
          method === "POST"
        ) {
          expect(page).toBe(ownerPage);
          expect(request.postDataJSON()).toMatchObject({
            hours: 24,
            maxUses: 3,
          });
          invite = {
            id: "invite-one",
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            maxUses: 3,
            useCount: 0,
            revoked: false,
            targetUserId: null,
            targetDisplayName: null,
          };
          body = { invite, code: inviteCode };
        } else if (path === "/api/v1/spaces/redeem" && method === "POST") {
          expect(page).toBe(guestPage);
          expect(request.postDataJSON()).toEqual({ code: inviteCode });
          if (
            !space ||
            !invite ||
            invite.revoked ||
            invite.useCount >= invite.maxUses
          ) {
            status = 400;
            body = { message: "유효하지 않거나 만료·취소된 초대예요." };
          } else {
            redeemedBy = guest.id;
            invite.useCount += 1;
            body = { ...space, role: "MEMBER" };
          }
        } else if (path.endsWith("/ownership-transfers/incoming")) {
          body = [];
        } else if (path === `/api/v1/spaces/${spaceId}/admission`) {
          expect(page).toBe(guestPage);
          expect(redeemedBy).toBe(guest.id);
          admissions.push(path);
          body = { ticket: "invite-flow-ticket", expiresInSeconds: 30 };
        } else if (path === `/api/v1/spaces/${spaceId}/assets`) {
          body = [];
        }

        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });

      await page.routeWebSocket("**/world/socket", (socket) => {
        socket.onMessage((message) => {
          if (
            typeof message !== "string" ||
            JSON.parse(message).type !== "join"
          )
            return;
          socket.send(JSON.stringify({ type: "mapChanged", map }));
          socket.send(
            JSON.stringify({
              type: "welcome",
              protocolVersion: 2,
              playerId: "invite-guest-player",
              resumeToken: "invite-flow-resume",
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
                  id: "invite-guest-player",
                  name: guest.name,
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
    }

    await ownerPage.goto("/");
    await ownerPage
      .getByRole("button", { name: "새 공간 만들기", exact: true })
      .click();
    const createDialog = ownerPage.getByRole("dialog", {
      name: "새로운 공간 만들기",
    });
    await createDialog
      .getByLabel("공간 이름", { exact: true })
      .fill("GDG 비밀 정원");
    await createDialog.getByLabel("동시 접속 인원", { exact: false }).fill("8");
    await createDialog
      .getByRole("button", { name: "공간 만들기", exact: true })
      .click();

    const roomCard = ownerPage
      .getByRole("article")
      .filter({ hasText: "GDG 비밀 정원" });
    await expect(roomCard).toContainText("비공개");
    await roomCard
      .getByRole("button", { name: "GDG 비밀 정원 초대 관리" })
      .click();
    await ownerPage.getByLabel("수락 가능 인원").fill("3");
    await ownerPage.getByRole("button", { name: "초대 코드 만들기" }).click();
    await expect(
      ownerPage.getByLabel("새 초대 코드", { exact: true }),
    ).toHaveValue(inviteCode);
    const inviteLink = `${new URL(baseURL).origin}/#invite=${inviteCode}`;
    await ownerPage.getByRole("button", { name: "초대 링크 복사" }).click();
    await expect(ownerPage.getByRole("status")).toContainText(
      "클립보드에 복사했어요.",
    );
    await expect
      .poll(() => ownerPage.evaluate(() => navigator.clipboard.readText()))
      .toBe(inviteLink);

    await guestPage.goto(inviteLink);
    await expect(guestPage).toHaveURL(`${new URL(baseURL).origin}/`);
    await expect(guestPage.getByLabel("초대받으셨나요?")).toHaveValue(
      inviteCode,
    );
    await guestPage.getByRole("button", { name: "초대 수락" }).click();
    await expect(guestPage.getByLabel("초대받으셨나요?")).toHaveValue("");
    const enterDialog = guestPage.getByRole("dialog", {
      name: "GDG 비밀 정원",
    });
    await expect(enterDialog.locator("#nickname")).toHaveValue("초대받은 친구");
    await enterDialog.getByRole("button", { name: "캠퍼스 입장하기" }).click();

    await expect.poll(() => admissions.length).toBeGreaterThan(0);
    await expect(
      guestPage.getByRole("application", {
        name: "초대받은 비밀 정원 기본 지도 가상 공간",
      }),
    ).toBeVisible();
    expect(redeemedBy).toBe(guest.id);
    expect(invite?.useCount).toBe(1);
  } finally {
    await ownerContext.close();
    await guestContext.close();
  }
});

test("accepts and declines account-targeted invitations from the space inbox", async ({
  page,
}) => {
  const baseURL = String(test.info().project.use.baseURL);
  const account = { id: "invited-account", name: "초대받은 참가자" };
  const space: Space = {
    id: "80000000-0000-4000-8000-000000000008",
    name: "도서관 스터디룸",
    description: "조용히 모여 공부하는 공간",
    visibility: "UNLISTED",
    capacity: 32,
    templateId: "STUDY_SPACE",
    role: "MEMBER",
    approvalRequired: false,
    allowedEmailDomains: [],
    guestEntryEnabled: false,
    joinRequestStatus: "",
    favorite: false,
    archived: false,
  };
  let invites = [
    {
      inviteId: "81111111-1111-4111-8111-111111111111",
      spaceId: space.id,
      spaceName: "취소할 모임 공간",
      inviterDisplayName: "공간 관리자",
      ownerDisplayName: "공간 관리자",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
    {
      inviteId: "82222222-2222-4222-8222-222222222222",
      spaceId: space.id,
      spaceName: space.name,
      inviterDisplayName: "공간 소유자",
      ownerDisplayName: "공간 소유자",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  ];
  let accepted = false;
  let declined = false;

  await mockSignedInUser(page, account);
  await page.route("**/api/v1/bootstrap", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        protocolVersion: 2,
        mode: "sso",
        storage: "mariadb",
        space: { id: "default-space", name: "기본 공간", capacity: 100 },
        map,
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
    const method = request.method();
    if (method !== "GET")
      expect(request.headers()["x-csrf-token"]).toBe("invite-flow-csrf");

    let body: unknown = {};
    if (path === "/api/v1/spaces" && method === "GET") {
      const visible =
        url.searchParams.get("view") === "mine" && accepted ? [space] : [];
      body = pageOf(visible);
    } else if (path === "/api/v1/spaces/ownership-transfers/incoming") {
      body = [];
    } else if (path === "/api/v1/spaces/invitations/incoming") {
      body = invites;
    } else if (
      path === `/api/v1/spaces/invitations/${invites[0]?.inviteId}/decline` &&
      method === "POST"
    ) {
      declined = true;
      invites = invites.filter(
        (invite) => invite.inviteId !== "81111111-1111-4111-8111-111111111111",
      );
      body = { declined: true };
    } else if (
      path ===
        `/api/v1/spaces/invitations/82222222-2222-4222-8222-222222222222/accept` &&
      method === "POST"
    ) {
      accepted = true;
      invites = invites.filter(
        (invite) => invite.inviteId !== "82222222-2222-4222-8222-222222222222",
      );
      body = space;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.goto("/");
  const inbox = page.getByRole("region", { name: "받은 공간 초대" });
  await expect(inbox).toBeVisible();

  const declineCard = inbox
    .getByRole("article")
    .filter({ hasText: "취소할 모임 공간" });
  await expect(declineCard).toContainText("공간 관리자님이 초대를 보냈어요.");
  await declineCard.getByRole("button", { name: "거절" }).click();
  await expect(declineCard).toHaveCount(0);
  await expect(page.locator(".space-notice")).toContainText("거절했어요");
  expect(declined).toBe(true);

  const acceptCard = inbox.getByRole("article").filter({ hasText: space.name });
  await acceptCard.getByRole("button", { name: "수락" }).click();
  await expect(page.locator(".space-notice")).toContainText(
    "도서관 스터디룸 공간에 참여했어요.",
  );
  await expect(inbox.getByRole("article")).toHaveCount(0);
  await expect(
    page.getByRole("article").filter({ hasText: space.name }),
  ).toBeVisible();
  expect(accepted).toBe(true);
});
