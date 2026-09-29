import { test, expect } from "@playwright/test";

import { authApi } from "../fixtures/auth-api";

test("SSO mode requires login and starts the configured provider flow", async ({
  page,
}) => {
  await authApi(page);
  await page.route("https://sso.example.invalid/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<main>Local test identity provider</main>",
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "캠퍼스 입장하기" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("로그인 없이 체험", { exact: false }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/sso-landing-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "GDG HUFS SSO로 로그인" }).click();
  await expect(page).toHaveURL(/sso\.example\.invalid\/authorize/);
});

test("English campus bootstrap failures stay localized", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hufs.language", "en"));
  await authApi(page);
  await page.route("**/api/v1/bootstrap", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("alert").filter({
      hasText: "Could not connect to the server. Please try again shortly.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.", {
      exact: true,
    }),
  ).toHaveCount(0);
});

test("landing brand copy follows the selected language", async ({ page }) => {
  await authApi(page);
  await page.goto("/");
  const landingTitle = page.locator(".welcome-story h1");
  const landingDescription = page.locator(".welcome-description");
  const metaDescription = page.locator('meta[name="description"]');
  await expect(landingTitle).toHaveText("GDG HUFS 훕스타운");
  await expect(page).toHaveTitle("GDG HUFS 훕스타운");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(metaDescription).toHaveAttribute(
    "content",
    "GDG HUFS가 운영하는 실시간 온라인 캠퍼스입니다. 아바타 이동, 근거리 음성·화상 대화, 화면 공유를 지원합니다.",
  );
  await expect(landingDescription).toContainText("GDG HUFS가 운영하는");
  await expect(landingDescription).toHaveText(
    "GDG HUFS가 운영하는 실시간 온라인 캠퍼스입니다. 아바타 이동, 근거리 음성·화상 대화, 화면 공유를 지원합니다.",
  );
  await expect(page.locator(".card-kicker")).toHaveCount(0);
  await expect(
    page.getByText(
      /함께 걸어보는 첫 캠퍼스|산책하듯 가볍게|우연히 마주치고, 함께 만들고/,
    ),
  ).toHaveCount(0);
  await expect(page.locator(".story-footer")).toHaveCount(0);
  await expect(page.locator(".preview-note")).toHaveCount(0);

  await page.getByLabel("언어").selectOption("en");
  await expect(landingTitle).toHaveText("GDG HUFS Town");
  await expect(page).toHaveTitle("GDG HUFS Town");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(metaDescription).toHaveAttribute(
    "content",
    "A real-time online campus operated by GDG HUFS. Supports avatar movement, nearby voice and video chat, and screen sharing.",
  );
  await expect(landingDescription).toContainText("operated by GDG HUFS");
  await expect(landingDescription).toContainText(
    "Supports avatar movement, nearby voice and video chat, and screen sharing.",
  );
  await expect(page.locator(".card-kicker")).toHaveCount(0);

  await page.getByLabel("Language").selectOption("ko");
  await expect(landingTitle).toHaveText("GDG HUFS 훕스타운");
  await expect(page).toHaveTitle("GDG HUFS 훕스타운");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(metaDescription).toHaveAttribute(
    "content",
    "GDG HUFS가 운영하는 실시간 온라인 캠퍼스입니다. 아바타 이동, 근거리 음성·화상 대화, 화면 공유를 지원합니다.",
  );
  await expect(landingDescription).toContainText("GDG HUFS가 운영하는");
});

test("mobile avatar setup shows one sprite and selects its body shape", async ({
  page,
}) => {
  await authApi(page);
  await page.route("**/api/v1/auth/config", (route) =>
    route.fulfill({
      json: { mode: "preview", configured: false, provider: "preview" },
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const bodyShape = page.getByLabel("체형");
  const avatar = page.locator(".join-avatar-stage .pixel-avatar");
  await expect(avatar).toHaveCount(1);
  await expect(page.locator(".avatar-choice")).toHaveCount(0);
  await expect(bodyShape).toHaveCSS("font-size", "16px");
  const bounds = await bodyShape.boundingBox();
  expect(bounds?.height).toBeGreaterThanOrEqual(44);

  await bodyShape.selectOption("2");
  await expect(bodyShape).toHaveValue("2");
  await expect(avatar).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
});

test("callback exchanges once, saves profile and logs out", async ({
  page,
}) => {
  const auth = await authApi(page);
  await page.goto("/auth/callback?code=test-code&state=test-state");
  await expect(page.getByText("GDG HUFS 계정으로 로그인됨")).toBeVisible();
  await expect(page).toHaveURL(`${test.info().project.use.baseURL}/`);
  expect(auth.exchanges()).toBe(1);
  await page.getByRole("button", { name: "프로필 편집" }).click();
  await page.locator("#profile-display-name").fill("캠퍼스 친구");
  const bodyShape = page.getByLabel("체형");
  await bodyShape.selectOption("2");
  await expect(bodyShape).toHaveValue("2");
  await expect(
    page.locator(".profile-editor-preview .pixel-avatar"),
  ).toHaveCount(1);
  await expect(page.locator(".avatar-choice")).toHaveCount(0);
  await page.getByRole("button", { name: "프로필 저장" }).click();
  await expect(
    page.getByRole("dialog", { name: "프로필과 아바타" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("프로필을 저장했어요. 다음 입장부터 적용돼요."),
  ).toBeVisible();
  await expect(page.getByText("캠퍼스 친구", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "프로필 편집" }).click();
  await expect(page.locator("#profile-display-name")).toHaveValue(
    "캠퍼스 친구",
  );
  await expect(page.getByLabel("체형")).toHaveValue("2");
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect.poll(auth.signedIn).toBe(false);
  expect(auth.logouts()).toBe(1);
  await expect(
    page.getByRole("button", { name: "GDG HUFS SSO로 로그인" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "캠퍼스 입장하기" }),
  ).toHaveCount(0);
  expect(auth.exchanges()).toBe(1);
});

test("logs out every browser session from the account profile", async ({
  page,
}) => {
  const auth = await authApi(page, { signedIn: true });
  await page.goto("/");
  await page.getByRole("button", { name: "프로필 편집" }).click();
  const profile = page.getByRole("dialog", { name: "프로필과 아바타" });
  await profile.getByRole("button", { name: "모든 기기에서 로그아웃" }).click();
  await expect(
    page.getByRole("button", { name: "GDG HUFS SSO로 로그인" }),
  ).toBeVisible();
  expect(auth.everywhereLogouts()).toBe(1);
  expect(auth.signedIn()).toBe(false);
});

test("keeps the account signed in and offers a retry when global logout fails", async ({
  page,
}) => {
  const auth = await authApi(page, {
    signedIn: true,
    logoutEverywhereFails: true,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "프로필 편집" }).click();
  const profile = page.getByRole("dialog", { name: "프로필과 아바타" });
  await profile.getByRole("button", { name: "모든 기기에서 로그아웃" }).click();
  await expect(
    profile.getByText(
      "모든 기기에서 로그아웃할 수 없어요. 다시 시도해 주세요.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "GDG HUFS SSO로 로그인" }),
  ).toHaveCount(0);
  expect(auth.signedIn()).toBe(true);
  await expect(
    profile.getByRole("button", { name: "모든 기기에서 로그아웃" }),
  ).toBeEnabled();
});

test("expired callbacks show recovery without entering the world", async ({
  page,
}) => {
  const auth = await authApi(page, { exchangeFails: true });
  await page.goto("/#invite=invite-survives-expired-login");
  await page.goto("/auth/callback?code=test-code&state=test-state");
  await expect(page.getByRole("alert")).toContainText(
    "로그인 코드가 만료되었거나 유효하지 않아요",
  );
  expect(
    await page.evaluate(() => sessionStorage.getItem("hufs.pending.invite")),
  ).toBe("invite-survives-expired-login");
  await expect(
    page.getByRole("button", { name: "GDG HUFS SSO로 로그인" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "캠퍼스 입장하기" }),
  ).toHaveCount(0);
  expect(auth.exchanges()).toBe(1);
});

test("English expired callback explains how to retry and preserves the invite", async ({
  page,
}) => {
  const auth = await authApi(page, { exchangeFails: true });
  await page.addInitScript(() => {
    localStorage.setItem("hufs.language", "en");
  });
  await page.goto("/#invite=invite-survives-expired-login");
  await page.goto("/auth/callback?code=test-code&state=test-state");
  await expect(page.getByRole("alert")).toContainText(
    "The sign-in code has expired or is invalid.",
  );
  expect(
    await page.evaluate(() => sessionStorage.getItem("hufs.pending.invite")),
  ).toBe("invite-survives-expired-login");
  expect(auth.exchanges()).toBe(1);
  await expect(
    page.getByRole("button", { name: "Sign in with GDG HUFS SSO" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "캠퍼스 입장하기" }),
  ).toHaveCount(0);
});

for (const language of ["ko", "en"] as const) {
  test(`cancelled ${language} callback stays private and login fits mobile`, async ({
    page,
  }) => {
    const auth = await authApi(page);
    await page.addInitScript((initialLanguage) => {
      localStorage.setItem("hufs.language", initialLanguage);
    }, language);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#invite=invite-survives-cancelled-login");
    await page.goto("/auth/callback?error=access_denied&state=private-state");
    await expect(page.getByRole("alert")).toContainText(
      language === "ko" ? "로그인이 취소되었어요" : "Sign-in was cancelled.",
    );
    expect(
      await page.evaluate(() => sessionStorage.getItem("hufs.pending.invite")),
    ).toBe("invite-survives-cancelled-login");
    expect(auth.exchanges()).toBe(0);
    await expect(page).toHaveURL(`${test.info().project.use.baseURL}/`);
    const mobileLayout = await page.evaluate(() => ({
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      overflowingElements: Array.from(
        document.querySelectorAll<HTMLElement>("body *"),
      )
        .map((element) => ({
          className:
            typeof element.className === "string" ? element.className : "",
          left: Math.round(element.getBoundingClientRect().left),
          right: Math.round(element.getBoundingClientRect().right),
        }))
        .filter(
          (element) => element.left < -1 || element.right > innerWidth + 1,
        )
        .slice(0, 8),
    }));
    expect(
      mobileLayout.documentWidth,
      JSON.stringify(mobileLayout.overflowingElements),
    ).toBeLessThanOrEqual(mobileLayout.viewportWidth);
    await page.screenshot({
      path: `test-results/sso-landing-mobile-${language}.png`,
      fullPage: true,
    });
  });
}

test("SSO callback recovery follows a language change", async ({ page }) => {
  const auth = await authApi(page);
  await page.addInitScript(() => {
    localStorage.setItem("hufs.language", "ko");
  });
  await page.goto("/auth/callback?error=access_denied&state=private-state");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("로그인이 취소되었어요");
  await page.getByLabel("언어").selectOption("en");
  await expect(alert).toContainText("Sign-in was cancelled.");
  expect(auth.exchanges()).toBe(0);
});

test("English sign-in callback localizes an unavailable provider error", async ({
  page,
}) => {
  const auth = await authApi(page, {
    exchangeFails: true,
    exchangeFailureCode: "SSO_UNAVAILABLE",
  });
  await page.addInitScript(() => {
    localStorage.setItem("hufs.language", "en");
  });
  await page.goto("/auth/callback?code=test-code&state=test-state");
  await expect(page.getByRole("alert")).toContainText(
    "Could not connect to HUFS sign-in.",
  );
  expect(auth.exchanges()).toBe(1);
  await expect(
    page.getByRole("button", { name: "Sign in with GDG HUFS SSO" }),
  ).toBeVisible();
});

test("account deletion requires confirmation and blocks owned spaces", async ({
  page,
}) => {
  const auth = await authApi(page, {
    signedIn: true,
    ownedSpaces: [
      {
        id: "00000000-0000-4000-8000-000000000009",
        name: "소유권 이전이 필요한 공간",
      },
    ],
  });
  await page.goto("/");
  await page.getByRole("button", { name: "프로필 편집" }).click();
  await page.getByRole("button", { name: "계정 탈퇴", exact: true }).click();
  await expect(page.getByRole("heading", { name: "계정 탈퇴" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("소유권을 이전해 주세요");
  await expect(
    page.getByRole("button", { name: "계정 탈퇴", exact: true }),
  ).toBeDisabled();
  expect(auth.deletions()).toBe(0);
});

test("account deletion accepts only the explicit confirmation", async ({
  page,
}) => {
  const auth = await authApi(page, { signedIn: true });
  await page.goto("/");
  await page.getByRole("button", { name: "프로필 편집" }).click();
  await page.getByRole("button", { name: "계정 탈퇴", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "계정 탈퇴" });
  const submit = dialog.getByRole("button", { name: "계정 탈퇴", exact: true });
  const confirmation = dialog.getByLabel("계속하려면 탈퇴를 입력해 주세요.");
  await expect(submit).toBeDisabled();
  await confirmation.fill("다른 값");
  await expect(submit).toBeDisabled();
  await confirmation.fill("탈퇴");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(
    page.getByRole("button", { name: "GDG HUFS SSO로 로그인" }),
  ).toBeVisible();
  expect(auth.deletions()).toBe(1);
});
