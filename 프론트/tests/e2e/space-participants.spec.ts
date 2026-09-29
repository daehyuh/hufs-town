import { expect, test, type Page } from "@playwright/test";

type Probe = {
  mapIds: string[];
  joinResults: Array<Record<string, unknown>>;
};

async function joinOnMap(page: Page, name: string, mapId: string) {
  await page.addInitScript(
    ({ initialMapId, profileName }) => {
      localStorage.setItem(
        "hufs-town.preview-profile",
        JSON.stringify({
          name: profileName,
          avatar: 0,
          skin: "light",
          clothing: "casual_white",
          hair: "hair_short_black",
          bio: `소개: ${profileName}`,
          links: [`https://example.org/${initialMapId}`],
        }),
      );
      let activeMapId = initialMapId;
      const probe: Probe = { mapIds: [], joinResults: [] };
      Object.assign(window, { __spaceJoinProbe: probe });
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          let target: string | URL = url;
          if (String(url).includes("/world/socket")) {
            const parsed = new URL(String(url), window.location.href);
            parsed.searchParams.set("townMapId", activeMapId);
            target = parsed;
            probe.mapIds.push(activeMapId);
          }
          super(target, protocols);
          if (!String(target).includes("/world/socket")) return;
          this.addEventListener("message", (event) => {
            try {
              const message = JSON.parse(String(event.data));
              if (message.type === "joinResult") {
                probe.joinResults.push(message);
                if (message.accepted && message.destinationMapId)
                  activeMapId = message.destinationMapId;
              }
            } catch {
              // Ignore unrelated non-JSON WebSocket frames in the browser probe.
            }
          });
        }
      };
    },
    { initialMapId: mapId, profileName: name },
  );

  await page.goto("/");
  await page.getByPlaceholder("이름이나 닉네임을 알려주세요").fill(name);
  await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect(page.locator(".connection-status")).toHaveText("연결됨", {
    timeout: 20_000,
  });
}

async function probe(page: Page): Promise<Probe> {
  return page.evaluate(
    () =>
      (window as typeof window & { __spaceJoinProbe: Probe }).__spaceJoinProbe,
  );
}

test("finds a participant on another map and completes an approved join", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const contexts = await Promise.all([0, 1].map(() => browser.newContext()));
  try {
    const [requesterPage, targetPage] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    await Promise.all([
      joinOnMap(requesterPage, "캠퍼스 참가자", "campus-map"),
      joinOnMap(targetPage, "스터디룸 참가자", "study-room"),
    ]);

    await requesterPage.getByRole("button", { name: "참가자 보기" }).click();
    const otherParticipants = requesterPage.getByRole("tabpanel", {
      name: "참가자",
    });
    await expect(otherParticipants).toContainText("스터디룸 참가자");
    await otherParticipants
      .getByRole("button", { name: "스터디룸 참가자님 프로필 보기" })
      .click();
    const profile = requesterPage.locator(".participant-profile-card");
    await expect(profile).toContainText("스터디룸 참가자");
    await expect(profile).toContainText("소개: 스터디룸 참가자");
    await expect(
      profile.getByRole("link", { name: "https://example.org/study-room" }),
    ).toHaveAttribute("href", "https://example.org/study-room");
    await profile.getByRole("button", { name: "합류" }).click();

    await expect(
      targetPage
        .getByRole("status")
        .filter({ hasText: "캠퍼스 참가자님이 이곳에 합류하고 싶어 해요." }),
    ).toBeVisible();
    await targetPage.getByRole("button", { name: "승인" }).click();
    await expect
      .poll(async () => (await probe(requesterPage)).joinResults)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accepted: true,
            moved: true,
            destinationMapId: "study-room",
          }),
        ]),
      );
    await expect
      .poll(async () => (await probe(requesterPage)).mapIds)
      .toContain("study-room");
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
