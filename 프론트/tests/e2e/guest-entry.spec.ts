import { expect, test } from "@playwright/test";
import { authApi } from "../fixtures/auth-api";

test("public guest link opens the no-login profile and avatar form", async ({
  page,
}) => {
  const spaceId = "guest-flow-space";
  await authApi(page);
  await page.route(`**/api/v1/guest/spaces/${spaceId}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: spaceId,
        name: "GDG HUFS 게스트 광장",
        description: "로그인 없이 만나는 공간",
        capacity: 100,
      }),
    }),
  );

  await page.goto(`/#space=${spaceId}`);

  const dialog = page.getByRole("dialog", {
    name: "GDG HUFS 게스트 광장 · 게스트 입장",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("로그인 없이 둘러볼 수 있어요");
  await expect(dialog).toContainText("기본 지도만 이용할 수 있어요");

  await dialog
    .getByPlaceholder("이름이나 닉네임을 알려주세요")
    .fill("방문 친구");
  const bodyShape = dialog.getByLabel("체형");
  await bodyShape.selectOption("1");
  await expect(bodyShape).toHaveValue("1");
  await expect(dialog.locator(".join-avatar-stage .pixel-avatar")).toHaveCount(
    1,
  );
  await expect(
    dialog.getByRole("button", { name: "캠퍼스 입장하기" }),
  ).toBeEnabled();

  await dialog.getByRole("button", { name: "닫기" }).click();
  await expect(dialog).toHaveCount(0);
});

test("a link to a space without guest access explains why entry was denied", async ({
  page,
}) => {
  const spaceId = "guest-disabled-space";
  await authApi(page);
  await page.route(`**/api/v1/guest/spaces/${spaceId}`, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        code: "GUEST_ENTRY_UNAVAILABLE",
        message: "게스트 입장이 허용된 공개 공간을 찾을 수 없어요.",
      }),
    }),
  );

  await page.goto(`/#space=${spaceId}`);

  await expect(page.getByRole("alert")).toContainText(
    "게스트 입장이 허용된 공개 공간을 찾을 수 없어요.",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("English guest denial does not expose the server's Korean message", async ({
  page,
}) => {
  const spaceId = "guest-disabled-space-en";
  await authApi(page);
  await page.addInitScript(() => {
    localStorage.setItem("hufs.language", "en");
  });
  await page.route(`**/api/v1/guest/spaces/${spaceId}`, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        code: "GUEST_ENTRY_UNAVAILABLE",
        message: "게스트 입장이 허용된 공개 공간을 찾을 수 없어요.",
      }),
    }),
  );

  await page.goto(`/#space=${spaceId}`);

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("This space does not allow guest access.");
  await expect(alert).not.toContainText("게스트 입장이 허용된 공개 공간");
  await page.getByLabel("Language").selectOption("ko");
  await expect(alert).toContainText(
    "게스트 입장이 허용된 공개 공간을 찾을 수 없어요.",
  );
  await page.getByLabel("언어").selectOption("en");
  await expect(alert).toContainText("This space does not allow guest access.");
  await expect(alert).not.toContainText("게스트 입장이 허용된 공개 공간");
});

test("a full space explains the admission denial and offers a retry", async ({
  page,
}) => {
  const spaceId = "00000000-0000-4000-8000-000000000001";
  let admissionRequests = 0;
  await authApi(page, { signedIn: true });
  await page.route(`**/api/v1/spaces/${spaceId}/admission`, async (route) => {
    admissionRequests++;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "SPACE_FULL",
        message: "공간 입장 정원이 가득 찼어요. 잠시 후 다시 시도해 주세요.",
      }),
    });
  });

  await page.goto("/");

  const card = page.getByRole("article").filter({
    hasText: "GDG HUFS 캠퍼스",
  });
  await card.getByRole("button", { name: "입장하기", exact: false }).click();
  const dialog = page.getByRole("dialog", { name: "GDG HUFS 캠퍼스" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "캠퍼스 입장하기" }).click();

  const denial = page.getByRole("alert");
  await expect(denial).toContainText("공간 입장 정원이 가득 찼어요");
  await expect(denial).toContainText("잠시 후 다시 시도해 주세요");
  await expect(denial).toContainText("잠시 연결이 멈췄어요");
  await expect(page.getByRole("button", { name: "다시 연결" })).toBeVisible();
  expect(admissionRequests).toBeGreaterThan(0);
});
