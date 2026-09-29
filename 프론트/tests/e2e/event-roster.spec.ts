import { expect, test, type Page } from "@playwright/test";
import type { EventState, Welcome } from "../../src/generated/protocol";

type Seen = {
  event?: EventState;
  welcome?: Welcome;
  errors: string[];
};

async function join(
  page: Page,
  name: string,
  enableEventTools = false,
): Promise<Seen> {
  const seen: Seen = { errors: [] };
  page.on("pageerror", (error) => seen.errors.push(error.message));
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === "eventState") seen.event = message;
      if (message.type === "welcome") seen.welcome = message;
    }),
  );

  if (enableEventTools)
    await page.addInitScript(() =>
      localStorage.setItem("hufs-town.event-tools.v11", "true"),
    );
  await page.route("**/api/v1/auth/config", (route) =>
    route.fulfill({
      json: { mode: "preview", configured: false, provider: "preview" },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText("로그인 없이 로컬 미리보기로 입장할 수 있습니다."),
  ).toBeVisible();
  await page.getByPlaceholder("이름이나 닉네임을 알려주세요").fill(name);
  await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect(page.locator(".connection-status")).toHaveText("연결됨", {
    timeout: 20_000,
  });
  if (enableEventTools) {
    const controls = page.getByLabel("행사 도구");
    await expect(controls).toBeVisible();
    await expect(controls.locator("#event-controls-body")).toBeHidden();
    await expect(
      controls.getByRole("button", { name: "도구 열기" }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const tools = document.querySelector(".event-controls")!;
          const status = document.querySelector(".call-status")!;
          return (
            tools.getBoundingClientRect().bottom <=
            status.getBoundingClientRect().top
          );
        }),
      )
      .toBe(true);
  } else {
    await expect(page.locator(".event-controls")).toHaveCount(0);
  }
  return seen;
}

test("presenter tools stay off by default while core communication controls remain available", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 960, height: 720 },
  });

  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("hufs-town.event-tools", "true");
      localStorage.setItem("hufs-town.event-tools.v2", "true");
      localStorage.setItem("hufs-town.event-tools.v3", "true");
      localStorage.setItem("hufs-town.event-tools.v4", "true");
      localStorage.setItem("hufs-town.event-tools.v5", "true");
      localStorage.setItem("hufs-town.event-tools.v6", "true");
      localStorage.setItem("hufs-town.event-tools.v7", "true");
      localStorage.setItem("hufs-town.event-tools.v8", "true");
      localStorage.setItem("hufs-town.event-tools.v9", "true");
      localStorage.setItem("hufs-town.event-tools.v10", "true");
    });
    await join(page, "기본 기능 참가자", false);

    await expect(page.locator(".event-controls")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "마이크 켜기", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "카메라 켜기", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "화면 공유 시작", exact: true }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Enter로 가까운 사람에게 채팅" })
      .click();
    await expect(page.getByLabel("가까운 사람에게 보낼 메시지")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("event roster shows all participants and managers can grant a raised hand", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({ viewport: { width: 960, height: 720 } }),
    ),
  );

  try {
    const [managerPage, participantPage] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const [manager, participant] = await Promise.all([
      join(managerPage, "명단 운영자", true),
      join(participantPage, "손든 참가자", false),
    ]);
    const controls = managerPage.getByLabel("행사 도구");
    await controls.getByRole("button", { name: "도구 열기" }).click();
    await controls.getByLabel("발표 제목").fill("참가자 명단 검증");
    await controls.getByRole("button", { name: "시작", exact: true }).click();
    await expect.poll(() => manager.event?.active).toBe(true);
    await expect.poll(() => participant.event?.active).toBe(true);
    await expect(participantPage.locator(".event-controls")).toHaveCount(0);
    await expect(
      participantPage.getByRole("button", { name: "마이크 켜기", exact: true }),
    ).toBeVisible();
    await expect(
      participantPage.getByRole("button", { name: "카메라 켜기", exact: true }),
    ).toBeVisible();
    await expect(
      participantPage.getByRole("button", {
        name: "화면 공유 시작",
        exact: true,
      }),
    ).toBeVisible();
    await participantPage.getByRole("button", { name: "참가자 보기" }).click();
    await participantPage.getByRole("tab", { name: "설정" }).click();
    await participantPage
      .getByRole("checkbox", { name: /추가 행사 기능 표시/ })
      .check();
    const attendeeControls = participantPage.getByLabel("행사 도구");
    await expect(attendeeControls).toBeVisible();
    await expect(
      attendeeControls.getByRole("button", { name: "도구 접기" }),
    ).toHaveAttribute("aria-expanded", "true");

    const roster = managerPage.locator(".event-participant-list");
    await expect(roster.locator("summary")).toHaveText("참가자 목록 (2)");
    await roster.locator("summary").click();
    await expect(roster).toContainText("명단 운영자");
    await expect(roster).toContainText("손든 참가자");
    await expect(roster).toContainText("현재 맵");
    await expect(managerPage.getByLabel("발표 참가 정보")).toContainText(
      "미디어 대상",
    );
    await expect(managerPage.getByLabel("발표 참가 정보")).toContainText(
      "수신 영상 0개",
    );

    await attendeeControls.getByRole("button", { name: "손들기" }).click();
    await expect
      .poll(() => participant.event?.raisedHandPlayerIds)
      .toContain(participant.welcome!.playerId);
    const hands = controls.locator(".event-hands");
    await expect(hands).toContainText("손든 참가자");
    await hands.getByRole("button", { name: "발표자로 지정" }).click();
    await expect
      .poll(() => manager.event?.speakerPlayerIds)
      .toContain(participant.welcome!.playerId);
    await expect
      .poll(() => participant.event?.speakerPlayerIds)
      .toContain(participant.welcome!.playerId);
    await expect(roster).toContainText("손든 참가자 · 발표자");

    await controls.getByRole("button", { name: "발표 종료" }).click();
    await expect.poll(() => manager.event?.active).toBe(false);
    await expect.poll(() => participant.event?.active).toBe(false);
    expect(manager.errors).toEqual([]);
    expect(participant.errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
