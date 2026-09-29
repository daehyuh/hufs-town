import { expect, test } from "@playwright/test";
import { authApi } from "../fixtures/auth-api";
import type { Space } from "../../src/spaces/client";

const room: Space = {
  id: "approval-recovery-space",
  name: "승인 대기 공간",
  description: "승인 상태 갱신 복구를 확인하는 공간",
  visibility: "PUBLIC",
  capacity: 40,
  templateId: "STUDY_SPACE",
  role: "",
  approvalRequired: true,
  allowedEmailDomains: [],
  guestEntryEnabled: false,
  joinRequestStatus: "PENDING",
  favorite: false,
  archived: false,
};

test("a later successful approval poll clears its previous error", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  let failNextRead = false;

  await page.route("**/api/v1/spaces**", async (route) => {
    const networkRequest = route.request();
    const path = new URL(networkRequest.url()).pathname;
    let body: unknown = {};
    let status = 200;

    if (path === "/api/v1/spaces" && networkRequest.method() === "GET") {
      if (failNextRead) {
        failNextRead = false;
        status = 503;
        body = { message: "임시 연결 오류" };
      } else {
        body = {
          items: [room],
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
  await expect(
    card.getByRole("button", { name: /승인 대기 중/ }),
  ).toBeDisabled();

  failNextRead = true;
  await page.clock.fastForward(10_000);
  await expect(page.getByRole("alert")).toContainText(
    "입장 승인 상태를 새로 확인하지 못했어요",
  );

  await page.clock.fastForward(10_000);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: /승인 대기 중/ }),
  ).toBeDisabled();
});
