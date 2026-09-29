import { expect, test } from "@playwright/test";
import { authApi } from "../fixtures/auth-api";
import type { Space } from "../../src/spaces/client";

const room: Space = {
  id: "archive-space",
  name: "GDG 운영 공간",
  description: "운영팀이 관리하는 캠퍼스 공간",
  visibility: "PUBLIC",
  capacity: 100,
  templateId: "CAMPUS_SQUARE",
  role: "OWNER",
  approvalRequired: false,
  allowedEmailDomains: [],
  guestEntryEnabled: false,
  joinRequestStatus: "",
  favorite: false,
  archived: false,
};

test("an owner can archive a space, restore it, and archived cards cannot be entered or managed", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  let archived = false;
  const mutations: string[] = [];

  await page.route("**/api/v1/spaces**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let body: unknown = {};

    if (request.method() !== "GET")
      expect(request.headers()["x-csrf-token"]).toBe("test-csrf");

    if (path === "/api/v1/spaces" && request.method() === "GET") {
      const isArchiveView = url.searchParams.get("view") === "archived";
      const items = archived === isArchiveView ? [{ ...room, archived }] : [];
      body = {
        items,
        page: 1,
        pageSize: 12,
        totalItems: items.length,
        totalPages: items.length ? 1 : 0,
        hasNext: false,
        hasPrevious: false,
      };
    } else if (path.endsWith("/ownership-transfers/incoming")) {
      body = [];
    } else if (path.endsWith("/archive") && request.method() === "POST") {
      mutations.push(path);
      archived = true;
      body = { ...room, archived: true };
    } else if (path.endsWith("/restore") && request.method() === "POST") {
      mutations.push(path);
      archived = false;
      body = { ...room, archived: false };
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.goto("/");
  const card = page.getByRole("article").filter({ hasText: room.name });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: `${room.name} 보관` }).click();
  const confirmation = page.getByRole("dialog", {
    name: "작업을 확인해 주세요",
  });
  await expect(confirmation).toContainText(
    "참가자는 입장할 수 없고 목록에서 숨겨져요",
  );
  await confirmation.getByRole("button", { name: "확인" }).click();
  await expect(card).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "보관함에서 복원할 수 있어요" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "보관함", exact: true }).click();
  const archivedCard = page.getByRole("article").filter({ hasText: room.name });
  await expect(archivedCard).toContainText("보관됨");
  await expect(
    archivedCard.getByRole("button", { name: /입장하기|입장 요청/ }),
  ).toHaveCount(0);
  await expect(
    archivedCard.getByRole("button", {
      name: /행사 일정|맵 편집|초대 관리|멤버 관리|설정/,
    }),
  ).toHaveCount(0);
  await expect(
    archivedCard.getByRole("button", { name: `${room.name} 복원` }),
  ).toBeVisible();

  await archivedCard.getByRole("button", { name: `${room.name} 복원` }).click();
  await expect(archivedCard).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("공간을 복원했어요.");
  expect(mutations).toEqual([
    "/api/v1/spaces/archive-space/archive",
    "/api/v1/spaces/archive-space/restore",
  ]);

  await page.getByRole("button", { name: "내 공간", exact: true }).click();
  const restoredCard = page.getByRole("article").filter({ hasText: room.name });
  await expect(restoredCard).toBeVisible();
  await expect(
    restoredCard.getByRole("button", { name: `${room.name} 보관` }),
  ).toBeVisible();
});
