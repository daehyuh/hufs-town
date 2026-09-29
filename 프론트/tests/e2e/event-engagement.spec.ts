import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";

async function expectAccessible(page: Page, view: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    })),
    view,
  ).toEqual([]);
}

async function joinEventPreview(page: Page, name: string, language = "ko") {
  if (language === "en")
    await page.addInitScript(() => localStorage.setItem("hufs.language", "en"));
  await page.goto("/");
  await page
    .getByPlaceholder(
      language === "en"
        ? "Enter your name or nickname"
        : "이름이나 닉네임을 알려주세요",
    )
    .fill(name);
  await page
    .getByLabel(language === "en" ? "Body type" : "체형")
    .selectOption("0");
  await page
    .getByRole("button", {
      name: language === "en" ? "Enter campus" : "캠퍼스 입장하기",
    })
    .click();
  await expect(page.locator(".connection-status")).toHaveText(
    language === "en" ? "Connected" : "연결됨",
  );
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.locator(".event-controls")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: language === "en" ? "View participants" : "참가자 보기",
    })
    .click();
  await page
    .getByRole("tab", { name: language === "en" ? "Settings" : "설정" })
    .click();
  await page
    .getByRole("checkbox", {
      name:
        language === "en"
          ? /Show additional event tools/
          : /추가 행사 기능 표시/,
    })
    .check();
  const controls = page.locator(".event-controls");
  await expect(controls).toBeVisible();
  await expect(
    page.getByLabel(language === "en" ? "Event tools" : "행사 도구", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(controls.locator("#event-controls-body")).toBeHidden();
  await controls
    .getByRole("button", {
      name: language === "en" ? "Open tools" : "도구 열기",
    })
    .click();
}

test("live-event authoring starts with localized title and poll choices", async ({
  page,
}) => {
  await joinEventPreview(page, "event-defaults-en", "en");

  await expect(page.getByLabel("Presentation title")).toHaveValue(
    "Campus-wide presentation",
  );
  await expect(page.getByLabel("Record attendance")).not.toBeChecked();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByLabel("Poll option 1")).toHaveValue("Agree");
  await expect(page.getByLabel("Poll option 2")).toHaveValue("Disagree");
});

test("event Q&A and polls stay localized for an English host and attendee", async ({
  browser,
}) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const [host, attendee] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const attendeeName = "event-attendee-en";
    await Promise.all([
      joinEventPreview(host, "event-host-en", "en"),
      joinEventPreview(attendee, attendeeName, "en"),
    ]);

    await host.getByLabel("Presentation title").fill("English event E2E");
    await host.getByRole("button", { name: "Start", exact: true }).click();
    await expect(attendee.locator("html")).toHaveAttribute("lang", "en");
    await expect(attendee.locator(".event-attendance-notice")).toContainText(
      "This is a preview event.",
    );
    await expectAccessible(
      attendee,
      "English event attendee accessibility violations",
    );

    const question = "Can everyone read this question?";
    await attendee.getByLabel("Question", { exact: true }).fill(question);
    await attendee.getByRole("button", { name: "Send question" }).click();
    await expect(host.getByText(question)).toBeVisible();
    const answer = host.getByLabel(`Answer ${attendeeName}'s question`);
    await answer.fill("Yes, the English event flow works.");
    await host.getByRole("button", { name: "Answer", exact: true }).click();
    await expect(
      attendee.getByText("Yes, the English event flow works."),
    ).toBeVisible();

    await host.getByLabel("Poll question").fill("Can attendees vote?");
    await host.getByRole("button", { name: "Start poll" }).click();
    const agree = attendee.getByRole("button", { name: /^Agree\b/ });
    await expect(agree).toBeVisible();
    await agree.click();
    await expect(agree).toBeDisabled();
    await host.getByRole("button", { name: "Close poll" }).click();
    await expect(attendee.locator(".event-poll")).toContainText("Closed");
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("event Q&A and polls synchronize across attendees and close safely", async ({
  browser,
}) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const [host, attendee] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const attendeeName = `event-guest-${Math.random().toString(36).slice(2, 6)}`;
    await Promise.all([
      joinEventPreview(host, "event-host", "ko"),
      joinEventPreview(attendee, attendeeName, "ko"),
    ]);

    await host.getByLabel("발표 제목").fill("행사 Q&A E2E");
    await host.getByRole("button", { name: "시작", exact: true }).click();
    await expect(
      attendee
        .getByRole("region", { name: "발표 참가 정보" })
        .getByText("행사 Q&A E2E", { exact: true }),
    ).toBeVisible();
    await expect(attendee.locator(".event-attendance-notice")).toContainText(
      "미리보기 행사입니다. 질문·답변·투표·퀴즈 결과와 개인별 출석 정보는 저장되지 않습니다.",
    );
    await expectAccessible(
      attendee,
      "Korean event attendee accessibility violations",
    );

    await attendee
      .getByLabel("질문 내용")
      .fill("질문과 답변이 실시간으로 보이나요?");
    await attendee.getByRole("button", { name: "질문 보내기" }).click();
    await expect(
      host.getByText("질문과 답변이 실시간으로 보이나요?"),
    ).toBeVisible();
    const answer = host.getByLabel(`${attendeeName} 질문 답변`);
    await answer.fill("두 브라우저에 바로 반영됩니다.");
    await host.getByRole("button", { name: "답변", exact: true }).click();
    await expect(
      attendee.getByText("두 브라우저에 바로 반영됩니다."),
    ).toBeVisible();

    await host.getByLabel("투표 질문").fill("행사 도구 검증");
    await host.getByRole("button", { name: "투표 시작" }).click();
    const yesOption = attendee
      .locator(".event-poll-option")
      .filter({ hasText: "찬성" });
    await expect(yesOption).toBeVisible();
    await yesOption.click();
    const hostYesOption = host
      .locator(".event-poll-option")
      .filter({ hasText: "찬성" });
    await expect(hostYesOption).toContainText("1");

    await expect(yesOption).toBeDisabled();
    await host.getByRole("button", { name: "투표 종료" }).click();
    await expect(attendee.getByText("종료됨")).toBeVisible();
    await expect(attendee.locator(".event-poll-option").first()).toBeDisabled();

    await host.getByRole("button", { name: "퀴즈" }).click();
    await host.getByLabel("퀴즈 질문").fill("캠퍼스 색상은?");
    await host.getByLabel("퀴즈 정답 선택지").selectOption("1");
    await host.getByRole("button", { name: "퀴즈 시작" }).click();
    await expect(host.locator(".event-poll-option b")).toHaveCount(0);
    await expect(attendee.locator(".event-poll-option b")).toHaveCount(0);
    await expect(attendee.locator(".event-poll-option.correct")).toHaveCount(0);
    await expect(attendee.getByText("정답", { exact: true })).toHaveCount(0);
    await host
      .locator(".event-poll-option")
      .filter({ hasText: "찬성" })
      .click();
    const correctAnswer = attendee
      .locator(".event-poll-option")
      .filter({ hasText: "반대" });
    await correctAnswer.click();
    await expect(correctAnswer).toBeDisabled();
    await expect(attendee.locator(".event-poll-option b")).toHaveCount(0);
    await host.getByRole("button", { name: "퀴즈 종료·정답 공개" }).click();
    await expect(attendee.locator(".event-quiz-score")).toContainText(
      "내 점수 1점",
    );
    await expect(attendee.locator(".event-poll-option.correct")).toContainText(
      "반대",
    );
    await expect(attendee.locator(".event-poll-option.correct")).toContainText(
      "정답",
    );
    await expect(host.locator(".event-quiz-score")).toContainText(
      "내 점수 0점",
    );

    await host.getByRole("button", { name: "발표 종료" }).click();
    await expect(host.locator(".event-engagement")).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
