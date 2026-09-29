import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { authApi } from "../fixtures/auth-api";
import type { Space } from "../../src/spaces/client";

const source: Space = {
  id: "clone-source",
  name: "GDG 프로젝트 라운지",
  description: "복제 기능을 확인할 원본 공간",
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
const joined: Space = {
  ...source,
  id: "clone-member-space",
  name: "참여 중인 모임",
  role: "MEMBER",
};

test("an owner clones a space by name and sees the private clone in Mine", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  const spaces = [source, joined];
  let cloned: Space | undefined;

  await page.route("**/api/v1/spaces**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let body: unknown = {};

    if (request.method() !== "GET")
      expect(request.headers()["x-csrf-token"]).toBe("test-csrf");

    if (path === "/api/v1/spaces" && request.method() === "GET") {
      const view = url.searchParams.get("view");
      const items =
        view === "mine"
          ? spaces.filter((space) => space.role === "OWNER")
          : spaces;
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
    } else if (
      path === `/api/v1/spaces/${source.id}/clone` &&
      request.method() === "POST"
    ) {
      const draft = request.postDataJSON();
      expect(draft).toEqual({ name: "새 GDG 프로젝트 공간" });
      cloned = {
        ...source,
        id: "clone-created-space",
        name: draft.name,
        visibility: "PRIVATE",
        role: "OWNER",
        approvalRequired: false,
        allowedEmailDomains: [],
        guestEntryEnabled: false,
        joinRequestStatus: "",
        favorite: false,
        archived: false,
      };
      spaces.push(cloned);
      body = cloned;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const sourceCard = page.getByRole("article").filter({ hasText: source.name });
  const memberCard = page.getByRole("article").filter({ hasText: joined.name });
  await expect(
    sourceCard.getByRole("button", { name: `${source.name} 복제` }),
  ).toBeVisible();
  await expect(memberCard.getByRole("button", { name: /복제/ })).toHaveCount(0);

  await sourceCard.getByRole("button", { name: `${source.name} 복제` }).click();
  const cloneDialog = page.getByRole("dialog", {
    name: "내용을 입력해 주세요",
  });
  await expect(cloneDialog).toContainText("지도와 승인된 에셋을 복사합니다");
  await expect(cloneDialog).toHaveAccessibleDescription(
    /지도와 승인된 에셋을 복사합니다/,
  );
  const dialogBounds = await cloneDialog.boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect(dialogBounds!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBounds!.x + dialogBounds!.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  const accessibility = await new AxeBuilder({ page })
    .include(".town-dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    accessibility.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target),
    })),
  ).toEqual([]);
  const cloneName = cloneDialog.getByLabel("새 공간 이름");
  await cloneName.fill("새 GDG 프로젝트 공간");
  await cloneDialog.getByRole("button", { name: "옆으로 접기" }).click();
  await expect(cloneDialog).not.toBeVisible();
  await page
    .getByRole("group", { name: "옆으로 접은 창" })
    .getByRole("button", { name: /다시 열기/ })
    .click();
  await expect(cloneName).toHaveValue("새 GDG 프로젝트 공간");
  await cloneDialog.getByRole("button", { name: "확인" }).click();

  await expect(
    page.getByRole("button", { name: "내 공간", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const cloneCard = page
    .getByRole("article")
    .filter({ hasText: "새 GDG 프로젝트 공간" });
  await expect(cloneCard).toBeVisible();
  await expect(cloneCard.locator(".visibility-badge")).toHaveText("비공개");
  expect(cloned).toMatchObject({
    name: "새 GDG 프로젝트 공간",
    visibility: "PRIVATE",
    role: "OWNER",
  });
  await expect(page.getByRole("status")).toContainText(
    "공간을 복제했어요. 내 공간에서 확인할 수 있어요.",
  );
});
