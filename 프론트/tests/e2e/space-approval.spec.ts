import { expect, test, type Page } from "@playwright/test";
import { authApi } from "../fixtures/auth-api";
import type { Space, SpaceJoinRequest } from "../../src/spaces/client";

const room: Space = {
  id: "approval-space",
  name: "GDG 세미나실",
  description: "입장 신청을 승인제로 운영하는 공간",
  visibility: "PUBLIC",
  capacity: 40,
  templateId: "STUDY_SPACE",
  role: "OWNER",
  approvalRequired: true,
  allowedEmailDomains: [],
  guestEntryEnabled: false,
  joinRequestStatus: "",
  favorite: false,
  archived: false,
};

const request: SpaceJoinRequest = {
  id: "approval-request",
  userId: "waiting-user",
  displayName: "김HUFS",
  requestedAt: Date.UTC(2026, 8, 24, 9),
};

test("an open owner approval list refreshes new requests every ten seconds", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  let showRequest = false;

  await page.route("**/api/v1/spaces**", async (route) => {
    const networkRequest = route.request();
    const path = new URL(networkRequest.url()).pathname;
    let body: unknown = {};

    if (networkRequest.method() !== "GET")
      expect(networkRequest.headers()["x-csrf-token"]).toBe("test-csrf");

    if (path === "/api/v1/spaces" && networkRequest.method() === "GET") {
      body = {
        items: [room],
        page: 1,
        pageSize: 12,
        totalItems: 1,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
      };
    } else if (path.endsWith("/ownership-transfers/incoming")) {
      body = [];
    } else if (path.endsWith("/join-requests")) {
      body = showRequest ? [request] : [];
    } else if (
      path.endsWith("/members") ||
      path.endsWith("/access-blocks") ||
      path.endsWith("/ownership-transfer")
    ) {
      body = [];
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.clock.install();
  await page.goto("/");

  const card = page.getByRole("article").filter({ hasText: room.name });
  await card.getByRole("button", { name: `${room.name} 멤버 관리` }).click();
  await expect(page.getByText("대기 중인 입장 요청이 없어요.")).toBeVisible();

  showRequest = true;
  await page.clock.fastForward(10_000);
  await expect(page.getByText("김HUFS")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "승인", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "거절", exact: true }),
  ).toBeVisible();
});

test("an owner can retry a failed waiting-room refresh and see new requests", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  let hasPendingRequest = false;
  let failNextRead = false;
  let requestReads = 0;

  await page.route("**/api/v1/spaces**", async (route) => {
    const networkRequest = route.request();
    const path = new URL(networkRequest.url()).pathname;
    let body: unknown = {};
    let status = 200;

    if (networkRequest.method() !== "GET")
      expect(networkRequest.headers()["x-csrf-token"]).toBe("test-csrf");

    if (path === "/api/v1/spaces" && networkRequest.method() === "GET") {
      body = {
        items: [room],
        page: 1,
        pageSize: 12,
        totalItems: 1,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
      };
    } else if (path.endsWith("/ownership-transfers/incoming")) {
      body = [];
    } else if (
      path.endsWith("/join-requests") &&
      networkRequest.method() === "GET"
    ) {
      requestReads += 1;
      if (failNextRead) {
        failNextRead = false;
        status = 503;
        body = { message: "임시 연결 오류" };
      } else body = hasPendingRequest ? [request] : [];
    } else if (
      path.endsWith("/members") ||
      path.endsWith("/access-blocks") ||
      path.endsWith("/ownership-transfer")
    ) {
      body = [];
    }

    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.clock.install();
  await page.goto("/");

  const card = page.getByRole("article").filter({ hasText: room.name });
  await card.getByRole("button", { name: `${room.name} 멤버 관리` }).click();
  await expect.poll(() => requestReads).toBe(1);
  await expect(page.getByText("대기 중인 입장 요청이 없어요.")).toBeVisible();

  hasPendingRequest = true;
  failNextRead = true;
  await page.clock.fastForward(10_000);
  await expect(page.getByRole("alert")).toContainText(
    "입장 승인 요청을 새로 불러오지 못했어요",
  );
  await expect(
    page.getByText("현재 대기 요청 여부를 확인할 수 없어요."),
  ).toBeVisible();
  await expect(page.getByText("대기 중인 입장 요청이 없어요.")).toHaveCount(0);

  await page.getByRole("button", { name: "승인 요청 다시 불러오기" }).click();
  await expect(page.getByText("김HUFS")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText("현재 대기 요청 여부를 확인할 수 없어요."),
  ).toHaveCount(0);
});

test("an approved requester sees entry become available after the next refresh", async ({
  browser,
  page: applicantPage,
}) => {
  const ownerPage = await browser.newPage();
  await authApi(ownerPage, { signedIn: true });
  await authApi(applicantPage, { signedIn: true });
  let joinStatus: "" | "PENDING" | "APPROVED" = "";
  let approved = false;

  const routeSpaces = (targetPage: Page, role: "owner" | "applicant") =>
    targetPage.route("**/api/v1/spaces**", async (route) => {
      const networkRequest = route.request();
      const path = new URL(networkRequest.url()).pathname;
      let body: unknown = {};

      if (networkRequest.method() !== "GET")
        expect(networkRequest.headers()["x-csrf-token"]).toBe("test-csrf");

      if (path === "/api/v1/spaces" && networkRequest.method() === "GET") {
        const item =
          role === "owner"
            ? room
            : {
                ...room,
                role: approved ? "MEMBER" : "",
                joinRequestStatus: joinStatus,
              };
        body = {
          items: [item],
          page: 1,
          pageSize: 12,
          totalItems: 1,
          totalPages: 1,
          hasNext: false,
          hasPrevious: false,
        };
      } else if (path.endsWith("/ownership-transfers/incoming")) {
        body = [];
      } else if (
        path.includes("/join-requests/") &&
        path.endsWith("/resolve") &&
        networkRequest.method() === "POST"
      ) {
        approved = networkRequest.postDataJSON().decision === "APPROVE";
        joinStatus = "APPROVED";
        body = { resolved: true };
      } else if (
        path.endsWith("/join-requests") &&
        networkRequest.method() === "GET"
      ) {
        body = joinStatus === "PENDING" ? [request] : [];
      } else if (
        path.endsWith("/join-requests") &&
        networkRequest.method() === "POST"
      ) {
        joinStatus = "PENDING";
        body = { status: joinStatus, requestedAt: request.requestedAt };
      } else if (
        path.endsWith("/members") ||
        path.endsWith("/access-blocks") ||
        path.endsWith("/ownership-transfer")
      ) {
        body = [];
      }

      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

  await routeSpaces(ownerPage, "owner");
  await routeSpaces(applicantPage, "applicant");
  await applicantPage.clock.install();
  await Promise.all([ownerPage.goto("/"), applicantPage.goto("/")]);

  const applicantCard = applicantPage
    .getByRole("article")
    .filter({ hasText: room.name });
  await applicantCard
    .getByRole("button", { name: "입장 요청", exact: true })
    .click();
  await expect(
    applicantCard.getByRole("button", { name: /승인 대기 중/ }),
  ).toBeDisabled();

  const ownerCard = ownerPage
    .getByRole("article")
    .filter({ hasText: room.name });
  await ownerCard
    .getByRole("button", { name: `${room.name} 멤버 관리` })
    .click();
  await expect(ownerPage.getByText("김HUFS")).toBeVisible();
  await ownerPage.getByRole("button", { name: "승인", exact: true }).click();
  await expect(ownerPage.getByRole("status")).toContainText(
    "김HUFS님의 입장을 승인했어요.",
  );

  const applicantRefresh = applicantPage.waitForResponse((response) => {
    const request = response.request();
    return (
      new URL(response.url()).pathname === "/api/v1/spaces" &&
      request.method() === "GET"
    );
  });
  await applicantPage.clock.runFor(10_000);
  const response = await applicantRefresh;
  const refreshed = (await response.json()) as {
    items: Array<{ role: string }>;
  };
  expect(refreshed.items[0]?.role).toBe("MEMBER");
  await expect(
    applicantCard.getByRole("button", { name: "입장하기" }),
  ).toBeEnabled();
  await expect(applicantCard).toContainText("승인제 공간");
  await ownerPage.close();
});

test("a rejected requester can ask again and enter after the next approval", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  let joinStatus: Space["joinRequestStatus"] = "REJECTED";
  let approved = false;
  let requestCount = 0;
  let failNextSpacesRead = false;

  await page.route("**/api/v1/spaces**", async (route) => {
    const networkRequest = route.request();
    const path = new URL(networkRequest.url()).pathname;
    let body: unknown = {};
    let status = 200;

    if (networkRequest.method() !== "GET")
      expect(networkRequest.headers()["x-csrf-token"]).toBe("test-csrf");

    if (path === "/api/v1/spaces" && networkRequest.method() === "GET") {
      if (failNextSpacesRead) {
        failNextSpacesRead = false;
        status = 503;
        body = { message: "임시 연결 오류" };
      } else {
        body = {
          items: [
            {
              ...room,
              role: approved ? "MEMBER" : "",
              joinRequestStatus: joinStatus,
            },
          ],
          page: 1,
          pageSize: 12,
          totalItems: 1,
          totalPages: 1,
          hasNext: false,
          hasPrevious: false,
        };
      }
    } else if (path.endsWith("/ownership-transfers/incoming")) {
      body = [];
    } else if (
      path.endsWith("/join-requests") &&
      networkRequest.method() === "POST"
    ) {
      requestCount += 1;
      joinStatus = "PENDING";
      body = { status: joinStatus, requestedAt: request.requestedAt };
    }

    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.clock.install();
  await page.goto("/");

  const applicantCard = page
    .getByRole("article")
    .filter({ hasText: room.name });
  await expect(
    applicantCard.getByRole("button", { name: "다시 요청", exact: false }),
  ).toBeEnabled();
  await applicantCard
    .getByRole("button", { name: "다시 요청", exact: false })
    .click();
  await expect.poll(() => requestCount).toBe(1);
  await expect(
    applicantCard.getByRole("button", { name: /승인 대기 중/ }),
  ).toBeDisabled();

  failNextSpacesRead = true;
  await page.clock.fastForward(10_000);
  await expect(page.getByRole("alert")).toContainText(
    "승인 상태를 새로 확인하지 못했어요",
  );

  approved = true;
  joinStatus = "APPROVED";
  await page.getByRole("button", { name: "공간 목록 새로고침" }).click();
  await expect(
    applicantCard.getByRole("button", { name: "입장하기" }),
  ).toBeEnabled();
});
