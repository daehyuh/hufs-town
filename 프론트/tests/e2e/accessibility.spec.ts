import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectAccessible(page: Page, view: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const violations = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    description: violation.description,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      summary: node.failureSummary,
    })),
  }));
  expect(violations, `${view} 접근성 위반`).toEqual([]);
}

async function joinCampus(page: Page, language: "ko" | "en") {
  const labels =
    language === "ko"
      ? {
          name: "이름이나 닉네임을 알려주세요",
          bodyShape: "체형",
          enter: "캠퍼스 입장하기",
          connected: "연결됨",
          deviceCheck: "입장 전 마이크·카메라 확인",
          deviceTitle: "입장 전 장치 확인",
          closeDialog: "닫기",
        }
      : {
          name: "Enter your name or nickname",
          bodyShape: "Body type",
          enter: "Enter campus",
          connected: "Connected",
          deviceCheck: "Check microphone and camera",
          deviceTitle: "Check devices before entering",
          closeDialog: "Close",
        };
  await page.goto("/");
  await page.getByPlaceholder(labels.name).fill("접근성점검");
  await page.getByLabel(labels.bodyShape).selectOption("0");
  await page.getByRole("button", { name: labels.deviceCheck }).click();
  const deviceDialog = page.getByRole("dialog", { name: labels.deviceTitle });
  await expect(deviceDialog).toBeVisible();
  await expectAccessible(page, `${language} media preflight`);
  await deviceDialog.getByRole("button", { name: labels.closeDialog }).click();
  await page.getByRole("button", { name: labels.enter }).click();
  await expect(page.locator(".connection-status")).toHaveText(labels.connected);
  await expect(page.locator(".world-canvas")).toBeVisible();
  await expect(page.locator(".onboarding-coach")).toHaveCount(0);
  await expectAccessible(page, `${language} campus view`);
}

for (const language of ["ko", "en"] as const) {
  test(`${language} landing and campus views pass WCAG 2.1 A/AA checks`, async ({
    page,
  }) => {
    await page.addInitScript((selectedLanguage) => {
      localStorage.setItem("hufs.language", selectedLanguage);
    }, language);
    await page.goto("/");
    await expectAccessible(page, `${language} landing view`);

    await joinCampus(page, language);
    await expectAccessible(page, `${language} campus view`);
    await page.setViewportSize({ width: 390, height: 844 });

    const wardrobeLabels =
      language === "ko"
        ? {
            open: "내 이름, 아바타, 소개 편집",
            title: "내 아바타와 프로필",
            close: "닫기",
            hide: "창 숨기기",
            restore: /다시 열기/,
          }
        : {
            open: "Edit my name, avatar, and bio",
            title: "My avatar and profile",
            close: "Close",
            hide: "Hide window",
            restore: /Restore/,
          };
    await page.getByRole("button", { name: wardrobeLabels.open }).click();
    const wardrobe = page.getByRole("dialog", { name: wardrobeLabels.title });
    await expect(wardrobe).toBeVisible();
    const wardrobeBounds = await wardrobe.boundingBox();
    expect(wardrobeBounds).not.toBeNull();
    expect(wardrobeBounds!.x).toBeGreaterThanOrEqual(0);
    expect(wardrobeBounds!.y).toBeGreaterThanOrEqual(0);
    expect(wardrobeBounds!.x + wardrobeBounds!.width).toBeLessThanOrEqual(390);
    expect(wardrobeBounds!.y + wardrobeBounds!.height).toBeLessThanOrEqual(844);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expectAccessible(page, `${language} avatar wardrobe`);
    await expect(
      wardrobe.getByRole("combobox", {
        name: language === "ko" ? "체형" : "Body type",
      }),
    ).toBeVisible();
    await wardrobe.getByRole("button", { name: wardrobeLabels.hide }).click();
    await expect(wardrobe).not.toBeVisible();
    const restoreWindow = page.getByRole("button", {
      name: wardrobeLabels.restore,
    });
    await expect(restoreWindow).toBeVisible();
    await restoreWindow.click();
    await expect(wardrobe).toBeVisible();
    await wardrobe.getByRole("button", { name: wardrobeLabels.close }).click();

    const labels =
      language === "ko"
        ? {
            chat: "채팅 보기",
            chatHeading: "실시간 채팅",
            map: "탐색 지도 보기",
            mapHeading: "탐색 지도",
            people: "참가자 보기",
            peopleHeading: "참가자",
            peopleTab: "참가자",
            settingsTab: "설정",
            settingsHeading: "설정",
          }
        : {
            chat: "View chat",
            chatHeading: "Live chat",
            map: "Explore map",
            mapHeading: "Explore map",
            people: "View participants",
            peopleHeading: "Participants",
            peopleTab: "Participants",
            settingsTab: "Settings",
            settingsHeading: "Settings",
          };
    await page.getByRole("button", { name: labels.chat }).click();
    await expect(
      page.getByRole("heading", { name: labels.chatHeading }),
    ).toBeVisible();
    await expectAccessible(page, `${language} chat panel`);

    await page.getByRole("button", { name: labels.map }).click();
    await expect(
      page.getByRole("heading", { name: labels.mapHeading }),
    ).toBeVisible();
    await expectAccessible(page, `${language} map panel`);

    await page.getByRole("button", { name: labels.people }).click();
    await expect(
      page.getByRole("heading", { name: labels.peopleHeading }),
    ).toBeVisible();
    await expectAccessible(page, `${language} participants panel`);

    const settingsTab = page.getByRole("tab", { name: labels.settingsTab });
    await page.getByRole("tab", { name: labels.peopleTab }).press("ArrowRight");
    await expect(settingsTab).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("heading", { name: labels.settingsHeading }),
    ).toBeVisible();
    await expectAccessible(page, `${language} settings panel`);
  });
}
