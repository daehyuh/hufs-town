import { expect, test, type Page } from "@playwright/test";
import { authApi } from "../fixtures/auth-api";
import type { Space, SpaceJoinRequest } from "../../src/spaces/client";

const space: Space = {
  id: "approval-rejection-space",
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
  id: "approval-rejection-request",
  userId: "local-test-user",
  displayName: "외대 친구",
  requestedAt: Date.UTC(2026, 8, 24, 9),
};

test("an owner rejection clears the queue and lets the requester ask again", async ({
  browser,
  page: applicantPage,
}) => {
  const ownerPage = await browser.newPage();
  await authApi(ownerPage, { signedIn: true });
  await authApi(applicantPage, { signedIn: true });

  let joinStatus: Space["joinRequestStatus"] = "";
  let submitted = false;
  let requestCount = 0;
  let failNextResolution = true;
  let failNextQueueRead = false;
  const decisions: string[] = [];

  const routeSpaces = (targetPage: Page, role: "owner" | "applicant") =>
    targetPage.route("**/api/v1/spaces**", async (route) => {
      const networkRequest = route.request();
      const path = new URL(networkRequest.url()).pathname;
      let body: unknown = {};
      let status = 200;

      if (networkRequest.method() !== "GET")
        expect(networkRequest.headers()["x-csrf-token"]).toBe("test-csrf");

      if (path === "/api/v1/spaces" && networkRequest.method() === "GET") {
        const item =
          role === "owner"
            ? space
            : { ...space, role: "", joinRequestStatus: joinStatus };
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
        const decision = networkRequest.postDataJSON().decision;
        expect(decision).toBe("REJECT");
        if (failNextResolution) {
          failNextResolution = false;
          status = 503;
          body = { message: "임시 연결 오류" };
        } else {
          decisions.push(decision);
          joinStatus = "REJECTED";
          failNextQueueRead = true;
          body = { resolved: true };
        }
      } else if (
        path.endsWith("/join-requests") &&
        networkRequest.method() === "GET"
      ) {
        if (failNextQueueRead) {
          failNextQueueRead = false;
          status = 503;
          body = { message: "임시 연결 오류" };
        } else {
          body = submitted && joinStatus === "PENDING" ? [request] : [];
        }
      } else if (
        path.endsWith("/join-requests") &&
        networkRequest.method() === "POST"
      ) {
        requestCount += 1;
        submitted = true;
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
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

  routeSpaces(ownerPage, "owner");
  routeSpaces(applicantPage, "applicant");
  await applicantPage.clock.install();
  await Promise.all([ownerPage.goto("/"), applicantPage.goto("/")]);

  const applicantCard = applicantPage
    .getByRole("article")
    .filter({ hasText: space.name });
  await applicantCard
    .getByRole("button", { name: "입장 요청", exact: true })
    .click();
  await expect.poll(() => requestCount).toBe(1);
  await expect(
    applicantCard.getByRole("button", { name: /승인 대기 중/ }),
  ).toBeDisabled();

  const ownerCard = ownerPage
    .getByRole("article")
    .filter({ hasText: space.name });
  await ownerCard
    .getByRole("button", { name: `${space.name} 멤버 관리` })
    .click();
  const ownerDialog = ownerPage.getByRole("dialog", { name: "멤버 관리" });
  await expect(ownerDialog.getByText(request.displayName)).toBeVisible();
  await ownerDialog.getByRole("button", { name: "거절", exact: true }).click();
  await expect(ownerPage.getByRole("alert")).toContainText("임시 연결 오류");
  await expect(
    ownerDialog.getByRole("button", { name: "거절", exact: true }),
  ).toBeEnabled();
  await ownerDialog.getByRole("button", { name: "거절", exact: true }).click();
  await expect(ownerDialog.getByRole("status")).toContainText(
    `${request.displayName}님의 입장 요청을 거절했어요.`,
  );
  await expect(ownerDialog.getByRole("alert")).toContainText(
    "처리는 완료했지만 입장 요청 목록을 갱신하지 못했어요",
  );
  await expect(
    ownerDialog.getByRole("button", { name: "거절", exact: true }),
  ).toBeDisabled();
  await ownerDialog
    .getByRole("button", { name: "승인 요청 다시 불러오기" })
    .click();
  await expect(
    ownerDialog.getByText("대기 중인 입장 요청이 없어요."),
  ).toBeVisible();
  await expect(ownerDialog.getByRole("status")).toContainText(
    `${request.displayName}님의 입장 요청을 거절했어요.`,
  );
  expect(decisions).toEqual(["REJECT"]);

  await applicantPage.clock.runFor(10_000);
  await expect(
    applicantCard.getByRole("button", { name: "다시 요청", exact: false }),
  ).toBeEnabled();
  await applicantCard
    .getByRole("button", { name: "다시 요청", exact: false })
    .click();
  await expect.poll(() => requestCount).toBe(2);
  await expect(
    applicantCard.getByRole("button", { name: /승인 대기 중/ }),
  ).toBeDisabled();
});
