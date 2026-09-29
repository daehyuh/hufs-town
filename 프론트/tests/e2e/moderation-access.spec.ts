import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { authApi } from "../fixtures/auth-api";
import type { ModerationReport } from "../../src/social/reports";
import type { ProductAnalyticsDashboard } from "../../src/social/productAnalytics";

async function expectDialogAccessible(page: Page, name: string) {
  const result = await new AxeBuilder({ page })
    .include("dialog.town-dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    })),
    `${name} dialog accessibility`,
  ).toEqual([]);
}

async function mockWorld(page: Page) {
  const map = {
    schemaVersion: 2,
    id: "moderation-fixture-map",
    revision: "moderation-fixture-map-v1",
    name: "GDG HUFS 캠퍼스",
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
        id: "floor",
        material: "GRASS",
        bounds: { x: 0, y: 0, width: 24, height: 18 },
      },
    ],
    walls: [],
    labels: [],
  };
  await page.route("**/api/v1/bootstrap", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        protocolVersion: 2,
        mode: "sso",
        storage: "mariadb",
        space: {
          id: "00000000-0000-4000-8000-000000000001",
          name: "GDG HUFS 캠퍼스",
          capacity: 100,
        },
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
  await page.routeWebSocket("**/world/socket", (socket) => {
    socket.onMessage((frame) => {
      if (typeof frame !== "string") return;
      const message = JSON.parse(frame) as { type?: string };
      if (message.type !== "join") return;

      socket.send(
        JSON.stringify({
          type: "welcome",
          protocolVersion: 2,
          playerId: "moderation-fixture-player",
          resumeToken: "moderation-fixture-resume",
          epoch: 1,
          mapRevision: map.revision,
          tickMs: 50,
          features: ["PARTICIPANT_REPORTS"],
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
              id: "moderation-fixture-player",
              name: "외대 친구",
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

test("ordinary members cannot discover moderator tools in the accessible UI", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  await mockWorld(page);

  const moderationRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/admin/")) moderationRequests.push(path);
  });

  await page.route("**/api/v1/reports/access", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ administrator: false }),
    });
  });
  const accessResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/reports/access" &&
      response.request().method() === "GET",
  );

  await page.goto("/");
  const space = page
    .getByRole("article")
    .filter({ hasText: "GDG HUFS 캠퍼스" });
  await expect(space).toBeVisible();
  await space.getByRole("button", { name: "입장하기" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect(page.locator(".connection-status")).toHaveText("연결됨", {
    timeout: 20_000,
  });
  await accessResponse;

  await page.getByRole("button", { name: "참가자 보기" }).click();
  await expect(page.getByRole("heading", { name: "참가자" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "신고 검토", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "채팅 보존 설정", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "운영 분석", exact: true }),
  ).toHaveCount(0);
  expect(moderationRequests).toEqual([]);
});

test("moderators can view privacy-preserving daily usage analytics", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  await mockWorld(page);
  await page.route("**/api/v1/reports/access", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ administrator: true }),
    }),
  );

  const today = new Date();
  const days = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(today.getTime() - (29 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return {
      date,
      counts: {
        spaceJoins: index === 29 ? 12 : 0,
        eventParticipations: index === 29 ? 4 : 0,
        worldRejections: index === 29 ? 2 : 0,
        apiServerErrors: index === 29 ? 1 : 0,
      },
    };
  });
  const dashboard: ProductAnalyticsDashboard = {
    generatedAt: Date.now(),
    retentionDays: 90,
    totals: {
      spaceJoins: 12,
      eventParticipations: 4,
      worldRejections: 2,
      apiServerErrors: 1,
    },
    days,
  };
  const analyticsRequests: string[] = [];
  await page.route("**/api/v1/admin/analytics", async (route) => {
    analyticsRequests.push(route.request().method());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(dashboard),
    });
  });

  await page.goto("/");
  const space = page
    .getByRole("article")
    .filter({ hasText: "GDG HUFS 캠퍼스" });
  await expect(space).toBeVisible();
  await space.getByRole("button", { name: "입장하기" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect(page.locator(".connection-status")).toHaveText("연결됨", {
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "참가자 보기" }).click();
  await page.getByRole("button", { name: "운영 분석", exact: true }).click();

  const analyticsDialog = page.getByRole("dialog", { name: "운영 분석" });
  await expect(analyticsDialog).toContainText("공간 입장");
  await expect(analyticsDialog).toContainText("행사 참여");
  await expect(analyticsDialog).toContainText("월드 거절·오류 응답");
  await expect(analyticsDialog).toContainText("API 서버 오류 (5xx)");
  await expect(analyticsDialog).toContainText("집계 데이터는 90일간 보관해요.");
  await expect(analyticsDialog.getByRole("table")).toBeVisible();
  await expect(analyticsDialog.getByRole("row")).toHaveCount(31);
  await expectDialogAccessible(page, "운영 분석");
  expect(analyticsRequests).toEqual(["GET"]);
});

test("English chat history errors use the current language", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  await mockWorld(page);
  const historyRequests: string[] = [];
  await page.route("**/api/v1/spaces/*/chat**", async (route) => {
    historyRequests.push(route.request().url());
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: "{}",
    });
  });

  await page.goto("/");
  await page.locator(".language-picker select").selectOption("en");
  const space = page
    .getByRole("article")
    .filter({ hasText: "GDG HUFS 캠퍼스" });
  await expect(space).toBeVisible();
  await space.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Enter campus" }).click();
  await expect(page.locator(".connection-status")).toHaveText("Connected", {
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "View chat" }).click();
  await page.getByRole("button", { name: "Everyone" }).click();

  await expect(
    page.getByText("Could not load earlier messages. Please try again.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(historyRequests.some((url) => url.includes("channel=space"))).toBe(
    true,
  );
});

test("moderators can open a report, start review, and save an audit note", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  await mockWorld(page);

  const reportId = "61000000-0000-4000-8000-000000000001";
  let currentReport: ModerationReport = {
    reportId,
    reporterName: "신고자",
    targetName: "참가자",
    targetType: "ACCOUNT",
    conversationId: "",
    messageId: "",
    category: "HARASSMENT",
    details: "반복적인 모욕 표현이 있었어요.",
    evidenceText: "모욕적인 메시지 예시",
    status: "OPEN",
    createdAt: Date.now(),
    reviewedAt: null,
    reviewerName: null,
    reviewNote: null,
    sourceType: "PLAYER",
    spaceId: "00000000-0000-4000-8000-000000000001",
  };
  const requests: { method: string; path: string; body?: unknown }[] = [];

  await page.route("**/api/v1/reports/access", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ administrator: true }),
    });
  });
  await page.route("**/api/v1/admin/reports**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([currentReport]),
      });
      return;
    }
    const body = request.postDataJSON() as {
      status: ModerationReport["status"];
      note: string;
    };
    requests.push({ method: request.method(), path, body });
    currentReport = {
      ...currentReport,
      status: body.status,
      reviewerName: "운영자",
      reviewNote: body.note,
      reviewedAt: Date.now(),
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(currentReport),
    });
  });
  await page.goto("/");
  const space = page
    .getByRole("article")
    .filter({ hasText: "GDG HUFS 캠퍼스" });
  await expect(space).toBeVisible();
  await space.getByRole("button", { name: "입장하기" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect(page.locator(".connection-status")).toHaveText("연결됨", {
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "참가자 보기" }).click();
  await page.getByRole("button", { name: "신고 검토", exact: true }).click();

  const reportDialog = page.getByRole("dialog", { name: "신고 검토" });
  const reportCard = reportDialog
    .getByRole("article")
    .filter({ hasText: "참가자님을 신고" });
  await expect(reportCard).toContainText("모욕적인 메시지 예시");
  await expect(reportCard).toContainText("반복적인 모욕 표현이 있었어요.");
  await expectDialogAccessible(page, "신고 검토");
  await reportCard
    .getByLabel(`${reportId} 검토 메모`)
    .fill("월드에 남은 동일 행동 신고와 함께 검토합니다.");
  await reportCard.getByRole("button", { name: "검토 시작" }).click();

  await expect(
    reportDialog.getByRole("status").filter({
      hasText: "신고 상태와 검토 메모를 저장했어요.",
    }),
  ).toBeVisible();
  await expect(reportCard).toHaveCount(0);
  expect(requests).toEqual([
    {
      method: "PATCH",
      path: `/api/v1/admin/reports/${reportId}`,
      body: {
        status: "REVIEWING",
        note: "월드에 남은 동일 행동 신고와 함께 검토합니다.",
      },
    },
  ]);
});

test("moderation review follows the saved English language preference", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("hufs.language", "en"));
  await authApi(page, { signedIn: true });
  await mockWorld(page);
  const reportId = "61000000-0000-4000-8000-000000000002";
  let currentReport: ModerationReport = {
    reportId,
    reporterName: "Reporter",
    targetName: "Participant",
    targetType: "GUEST",
    conversationId: "",
    messageId: "",
    category: "HARASSMENT",
    details: "Repeated harassment in the space.",
    evidenceText: "Reported message excerpt",
    status: "OPEN",
    createdAt: Date.now(),
    reviewedAt: null,
    reviewerName: null,
    reviewNote: null,
    sourceType: "PLAYER",
    spaceId: "00000000-0000-4000-8000-000000000001",
  };
  await page.route("**/api/v1/reports/access", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ administrator: true }),
    });
  });
  await page.route("**/api/v1/admin/reports**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([currentReport]),
      });
      return;
    }
    const body = request.postDataJSON() as {
      status: ModerationReport["status"];
      note: string;
    };
    currentReport = {
      ...currentReport,
      status: body.status,
      reviewerName: "Moderator",
      reviewNote: body.note,
      reviewedAt: Date.now(),
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(currentReport),
    });
  });
  await page.route("**/api/v1/admin/settings/chat-retention", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        retentionDays: 30,
        source: "DATABASE",
        updatedAt: Date.now(),
        updatedBy: "moderator",
      }),
    });
  });
  const today = new Date().toISOString().slice(0, 10);
  await page.route("**/api/v1/admin/analytics", async (route) => {
    const dashboard: ProductAnalyticsDashboard = {
      generatedAt: Date.now(),
      retentionDays: 90,
      totals: {
        spaceJoins: 3,
        eventParticipations: 2,
        worldRejections: 1,
        apiServerErrors: 0,
      },
      days: [
        {
          date: today,
          counts: {
            spaceJoins: 3,
            eventParticipations: 2,
            worldRejections: 1,
            apiServerErrors: 0,
          },
        },
      ],
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(dashboard),
    });
  });

  await page.goto("/");
  const space = page
    .getByRole("article")
    .filter({ hasText: "GDG HUFS 캠퍼스" });
  await expect(space).toBeVisible();
  await space.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Enter campus" }).click();
  await expect(page.locator(".connection-status")).toHaveText("Connected", {
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "View participants" }).click();
  await expect(
    page.getByRole("heading", { name: /Participants/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Search participants" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByRole("combobox", { name: "My status" })).toHaveValue(
    "AVAILABLE",
  );
  await expect(page.getByText("Automatic away status")).toBeVisible();
  await expect(page.getByText("Low-spec mode")).toBeVisible();
  await expect(page.getByText("Allow pokes")).toBeVisible();
  await page.getByRole("tab", { name: "Participants" }).click();
  await page.locator(".moderation-open-button").first().click();

  const reportDialog = page.getByRole("dialog", { name: "Review reports" });
  expect(await reportDialog.innerText()).not.toMatch(/[가-힣]/);
  await expectDialogAccessible(page, "Review reports");
  const reportCard = reportDialog
    .getByRole("article")
    .filter({ hasText: "reported guest Participant" });
  await expect(reportCard).toContainText("Harassment");
  await expect(reportCard).toContainText("Reported message excerpt");
  await reportCard
    .getByLabel(`Review note for ${reportId}`)
    .fill("Reviewed with the room moderation record.");
  await reportCard.getByRole("button", { name: "Start review" }).click();
  await expect(
    reportDialog
      .getByRole("status")
      .filter({ hasText: "Report status and review note saved." }),
  ).toBeVisible();

  await reportDialog.getByRole("button", { name: "Close" }).click();
  await page.locator(".moderation-open-button").nth(1).click();
  const retentionDialog = page.getByRole("dialog", {
    name: "Chat retention settings",
  });
  await expect(retentionDialog.getByLabel("Chat retention period")).toHaveValue(
    "30",
  );
  await expect(retentionDialog).toContainText(
    "An administrator policy is active.",
  );
  expect(await retentionDialog.innerText()).not.toMatch(/[가-힣]/);
  await expectDialogAccessible(page, "Chat retention settings");

  await retentionDialog
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await page.locator(".moderation-open-button").nth(2).click();
  const analyticsDialog = page.getByRole("dialog", {
    name: "Usage analytics",
  });
  await expect(analyticsDialog).toContainText("Space joins");
  await expect(analyticsDialog).toContainText("Event participation");
  await expect(analyticsDialog).toContainText("World rejections and errors");
  await expect(analyticsDialog).toContainText("API server errors (5xx)");
  await expect(analyticsDialog.getByRole("table")).toBeVisible();
  await expect(
    analyticsDialog.getByRole("region", { name: "Daily operations totals" }),
  ).toHaveAttribute("tabindex", "0");
  expect(await analyticsDialog.innerText()).not.toMatch(/[가-힣]/);
  await expectDialogAccessible(page, "Usage analytics");
});
