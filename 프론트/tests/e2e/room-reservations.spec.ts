import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { authApi } from "../fixtures/auth-api";

const spaceId = "00000000-0000-4000-8000-000000000091";
const mapId = "00000000-0000-4000-8000-000000000093";
const zoneId = "00000000-0000-4000-8000-000000000094";
const reservationId = "00000000-0000-4000-8000-000000000095";
const reservationTitle = "HUFS meetup reservation";
const spaceName = "GDG HUFS Test Space";

async function installReservationApi(page: Page, language: "ko" | "en") {
  await page.addInitScript((selectedLanguage) => {
    localStorage.setItem("hufs.language", selectedLanguage);
  }, language);
  await authApi(page, { signedIn: true, displayName: "HUFS member" });

  let createRequests = 0;
  let cancelRequests = 0;
  let cancelledAt = "";
  const reservation = () => {
    const now = Date.now();
    return {
      id: reservationId,
      mapId,
      zoneId,
      mapName: "Main campus",
      zoneName: "Meeting room",
      roomAvailable: true,
      title: reservationTitle,
      organizerName: "HUFS member",
      mine: true,
      canEdit: true,
      startsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
      endsAt: new Date(now + 3 * 60 * 60_000).toISOString(),
      cancelledAt,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
  };
  await page.route("**/api/v1/spaces**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/spaces") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: spaceId,
              name: spaceName,
              description: "Room reservation localization fixture",
              visibility: "PUBLIC",
              capacity: 100,
              templateId: "OFFICE",
              role: "OWNER",
              approvalRequired: false,
              allowedEmailDomains: [],
              guestEntryEnabled: false,
              joinRequestStatus: "",
              favorite: false,
              archived: false,
            },
          ],
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

    const reservationsPath = `/api/v1/spaces/${spaceId}/room-reservations`;
    if (
      path === `${reservationsPath}/${reservationId}` &&
      request.method() === "DELETE"
    ) {
      cancelRequests++;
      cancelledAt = new Date().toISOString();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(reservation()),
      });
      return;
    }

    if (path === reservationsPath) {
      if (request.method() === "POST") createRequests++;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          request.method() === "GET"
            ? {
                rooms: [
                  {
                    mapId,
                    mapName: "Main campus",
                    zoneId,
                    zoneName: "Meeting room",
                    capacity: 12,
                  },
                ],
                reservations: [reservation()],
                canReserve: true,
              }
            : {},
        ),
      });
      return;
    }

    await route.fallback();
  });

  return () => ({ createRequests, cancelRequests });
}

for (const language of ["ko", "en"] as const) {
  test(`${language} room reservation validation stays localized`, async ({
    page,
  }) => {
    const labels =
      language === "ko"
        ? {
            open: `${spaceName} 회의실 예약`,
            title: `${spaceName} 회의실 예약`,
            add: "새 회의실 예약",
            room: "회의실",
            name: "예약 이름",
            startsAt: "시작 시각",
            endsAt: "종료 시각",
            submit: "예약하기",
            cancelAction: "취소",
            confirmTitle: "작업을 확인해 주세요",
            confirmMessage: `‘${reservationTitle}’ 회의실 예약을 취소할까요?`,
            cancelled: "취소됨",
            hide: "옆으로 접기",
            restore: /다시 열기/,
            validation: "예약 시간은 15분에서 8시간 사이로 설정해 주세요.",
          }
        : {
            open: `${spaceName} Room reservations`,
            title: `Room reservations · ${spaceName}`,
            add: "New room reservation",
            room: "Room",
            name: "Reservation name",
            startsAt: "Start time",
            endsAt: "End time",
            submit: "Reserve room",
            cancelAction: "Cancel",
            confirmTitle: "Confirm this action",
            confirmMessage: `Cancel the room reservation “${reservationTitle}”?`,
            cancelled: "Canceled",
            hide: "Fold to side",
            restore: /Restore/,
            validation: "Choose a reservation between 15 minutes and 8 hours.",
          };
    const getRequests = await installReservationApi(page, language);

    await page.goto("/");
    await page.getByRole("button", { name: labels.open }).click();
    const dialog = page.getByRole("dialog", { name: labels.title });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: labels.add }).click();
    await expect(dialog.getByLabel(labels.room)).toHaveValue(
      `${mapId}|${zoneId}`,
    );
    await dialog.getByLabel(labels.name).fill("HUFS meetup");
    await dialog.getByLabel(labels.startsAt).fill("2026-10-01T10:00");
    await dialog.getByLabel(labels.endsAt).fill("2026-10-01T10:10");
    await dialog.getByRole("button", { name: labels.hide }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: labels.restore }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(labels.name)).toHaveValue("HUFS meetup");
    await dialog.getByRole("button", { name: labels.submit }).click();

    await expect(dialog.getByRole("alert")).toHaveText(labels.validation);

    const reservationCard = dialog
      .locator(".room-reservation-card")
      .filter({ hasText: reservationTitle });
    await reservationCard
      .getByRole("button", { name: labels.cancelAction })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: labels.confirmTitle,
    });
    await expect(confirmation).toContainText(labels.confirmMessage);
    await confirmation.locator(".dialog-action-secondary").click();
    expect(getRequests()).toMatchObject({
      createRequests: 0,
      cancelRequests: 0,
    });

    await reservationCard
      .getByRole("button", { name: labels.cancelAction })
      .click();
    await page
      .getByRole("dialog", { name: labels.confirmTitle })
      .locator(".dialog-action-primary")
      .click();
    await expect(reservationCard).toContainText(labels.cancelled);
    expect(getRequests()).toMatchObject({
      createRequests: 0,
      cancelRequests: 1,
    });

    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      accessibility.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map(({ target }) => target),
      })),
    ).toEqual([]);
  });
}
