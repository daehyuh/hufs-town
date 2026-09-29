import { expect, test } from "@playwright/test";

test("untouched media windows migrate to a screen-first, camera-visible layout", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "hufs.media.screen-frame.v1",
      JSON.stringify({ x: 24, y: 138, width: 500, height: 330 }),
    );
  });
  await page.goto("/");
  await page
    .getByPlaceholder("이름이나 닉네임을 알려주세요")
    .fill("화면 레이아웃");
  await page.getByLabel("체형").selectOption("0");
  await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect(page.locator(".connection-status")).toHaveText("연결됨");

  await expect
    .poll(() =>
      page.evaluate(() => {
        const stage = document
          .querySelector(".world-stage")!
          .getBoundingClientRect();
        const frame = JSON.parse(
          localStorage.getItem("hufs.media.screen-frame.v1") ?? "{}",
        );
        const camera = JSON.parse(
          localStorage.getItem("hufs.media.camera-frame.v1") ?? "{}",
        );
        return (
          frame.width > 500 &&
          frame.height > 330 &&
          frame.x + frame.width <= stage.width - 8 &&
          frame.y + frame.height <= stage.height - 8 &&
          camera.width === 220 &&
          camera.x + camera.width <= stage.width - 8
        );
      }),
    )
    .toBe(true);

  const frames = await page.evaluate(() => {
    const stage = document
      .querySelector(".world-stage")!
      .getBoundingClientRect();
    return {
      stage: { width: stage.width, height: stage.height },
      screen: JSON.parse(
        localStorage.getItem("hufs.media.screen-frame.v1") ?? "{}",
      ),
      camera: JSON.parse(
        localStorage.getItem("hufs.media.camera-frame.v1") ?? "{}",
      ),
    };
  });

  expect(frames.screen.height).toBeGreaterThan(330);
  expect(frames.screen.x + frames.screen.width).toBeLessThanOrEqual(
    frames.stage.width - 8,
  );
  expect(frames.screen.y + frames.screen.height).toBeLessThanOrEqual(
    frames.stage.height - 8,
  );
  expect(frames.camera.width).toBe(220);
  expect(frames.camera.x + frames.camera.width).toBeLessThanOrEqual(
    frames.stage.width - 8,
  );
});
