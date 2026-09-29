import { expect, test } from "@playwright/test";

test("landing entry copy matches the configured authentication mode", async ({
  page,
}) => {
  await page.goto("/");
  const mode = await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/config");
    if (!response.ok) throw new Error("Could not load authentication config");
    return (await response.json()).mode as "preview" | "sso";
  });

  await expect(
    page.getByRole("heading", { name: "GDG HUFS 훕스타운" }),
  ).toBeVisible();
  await expect(page.locator(".landing-header .brand")).toHaveText(
    "GDG HUFS 훕스타운",
  );
  const capacityLabel = page.locator(".destination small");
  if (mode === "preview") {
    await expect(capacityLabel).toHaveText("공간 · 최대 100명");
    await expect(page.getByText("오피스 공간 · 최대 100명")).toHaveCount(0);
  } else {
    await expect(capacityLabel).toHaveCount(0);
  }

  if (mode === "sso") {
    await expect(
      page.getByText("HUFS SSO로 로그인해 공간에 입장할 수 있습니다.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("로그인 없이 로컬 미리보기로 입장할 수 있습니다.", {
        exact: true,
      }),
    ).toHaveCount(0);
  } else {
    await expect(
      page.getByText("로그인 없이 로컬 미리보기로 입장할 수 있습니다.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("HUFS SSO로 로그인해 공간에 입장할 수 있습니다.", {
        exact: true,
      }),
    ).toHaveCount(0);
    await page.getByLabel("언어").selectOption("en");
    await expect(capacityLabel).toHaveText("Space · Up to 100 people");
  }
});

test("mobile English header uses the GDG HUFS name without decorative copy", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("hufs.language", "en"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const brand = page.locator(".landing-header .brand");
  await expect(brand).toHaveText("GDG HUFS Town");
  await expect(page.locator(".brand small")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
});
