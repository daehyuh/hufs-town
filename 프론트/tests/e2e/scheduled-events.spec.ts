import { expect, test, type Page } from "@playwright/test";
import { authApi } from "../fixtures/auth-api";

const spaceId = "00000000-0000-4000-8000-000000000091";
const eventId = "00000000-0000-4000-8000-000000000092";
const events: Array<{
  id: string;
  title: string;
  description: string;
  instructions: string;
  resourceUrl: string;
  startsAt: string;
  endsAt: string;
  cancelled: boolean;
  createdAt: string;
  updatedAt: string;
  goingCount: number;
  interestedCount: number;
  declinedCount: number;
  myResponse: "";
}> = [];

async function installSpaceApi(page: Page, role: "OWNER" | "MEMBER") {
  await authApi(page, { signedIn: true });
  await page.route("**/api/v1/spaces**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const collection = `/api/v1/spaces/${spaceId}/scheduled-events`;
    const space = {
      id: spaceId,
      name: "GDG 행사 라운지",
      description: "일정 변경을 함께 확인하는 공간",
      visibility: "PUBLIC",
      capacity: 100,
      templateId: "CAMPUS_SQUARE",
      role,
      approvalRequired: false,
      joinRequestStatus: "",
      favorite: false,
    };

    if (request.method() !== "GET")
      expect(request.headers()["x-csrf-token"]).toBe("test-csrf");

    if (path === "/api/v1/spaces") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [space],
          page: 1,
          pageSize: 12,
          totalItems: 1,
          totalPages: 1,
          hasNext: false,
          hasPrevious: false,
        }),
      });
      return;
    }

    if (path === collection && request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(events),
      });
      return;
    }

    if (path === collection && request.method() === "POST") {
      const draft = request.postDataJSON();
      const now = new Date().toISOString();
      const event = {
        id: eventId,
        ...draft,
        cancelled: false,
        createdAt: now,
        updatedAt: now,
        goingCount: 0,
        interestedCount: 0,
        declinedCount: 0,
        myResponse: "" as const,
      };
      events.push(event);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(event),
      });
      return;
    }

    if (path === `${collection}/${eventId}` && request.method() === "PATCH") {
      const event = events[0];
      Object.assign(event, request.postDataJSON(), {
        updatedAt: new Date().toISOString(),
      });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(event),
      });
      return;
    }

    if (path === `${collection}/${eventId}` && request.method() === "DELETE") {
      const event = events[0];
      Object.assign(event, {
        cancelled: true,
        updatedAt: new Date().toISOString(),
      });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(event),
      });
      return;
    }

    await route.fallback();
  });
}

test("manager schedule edits reach attendees while the schedule stays open", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  events.splice(0, events.length);
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const [manager, attendee] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    await attendee.clock.install();
    await Promise.all([
      installSpaceApi(manager, "OWNER"),
      installSpaceApi(attendee, "MEMBER"),
    ]);
    await Promise.all([manager.goto("/"), attendee.goto("/")]);

    await attendee
      .getByRole("button", { name: "GDG 행사 라운지 행사 일정" })
      .click();
    await expect(
      attendee.getByText("등록된 예정 행사가 없어요."),
    ).toBeVisible();

    await manager
      .getByRole("button", { name: "GDG 행사 라운지 행사 일정" })
      .click();
    await manager.getByRole("button", { name: "행사 일정 등록" }).click();
    await manager.getByLabel("행사 이름").fill("HUFS 오픈 밋업");
    await manager.getByLabel("행사 설명").fill("처음 등록한 안내");
    await manager
      .getByRole("button", { name: "일정 저장", exact: true })
      .click();
    await expect(
      manager.getByRole("heading", { name: "HUFS 오픈 밋업" }),
    ).toBeVisible();

    await manager.getByRole("button", { name: "HUFS 오픈 밋업 수정" }).click();
    await manager.getByLabel("행사 이름").fill("HUFS 오픈 밋업 · 장소 변경");
    await manager
      .getByLabel("참가 안내")
      .fill("입장 후 도트 광장 무대 앞에 모여 주세요.");
    await manager
      .getByRole("button", { name: "일정 저장", exact: true })
      .click();
    await expect(
      manager.getByRole("heading", {
        name: "HUFS 오픈 밋업 · 장소 변경",
      }),
    ).toBeVisible();

    await attendee.clock.fastForward(30_001);
    await expect(
      attendee.getByRole("heading", {
        name: "HUFS 오픈 밋업 · 장소 변경",
      }),
    ).toBeVisible();
    await expect(
      attendee.getByText("입장 후 도트 광장 무대 앞에 모여 주세요."),
    ).toBeVisible();

    const updatedTitle = "HUFS 오픈 밋업 · 장소 변경";
    const eventCard = manager
      .locator(".scheduled-event-card")
      .filter({ hasText: updatedTitle });
    await eventCard
      .getByRole("button", { name: `${updatedTitle} 취소` })
      .click();
    const cancelDialog = manager.getByRole("dialog", {
      name: "작업을 확인해 주세요",
    });
    await expect(cancelDialog).toContainText(
      `‘${updatedTitle}’ 일정을 취소할까요? 참가자에게 취소 상태가 표시됩니다.`,
    );
    await cancelDialog.locator(".dialog-action-secondary").click();
    await expect(eventCard).not.toContainText("취소됨");

    await eventCard
      .getByRole("button", { name: `${updatedTitle} 취소` })
      .click();
    await manager
      .getByRole("dialog", { name: "작업을 확인해 주세요" })
      .locator(".dialog-action-primary")
      .click();
    await expect(eventCard).toContainText("취소됨");
    expect(events[0].cancelled).toBe(true);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
