import { expect, test, type Page } from "@playwright/test";
import type { Snapshot, Welcome } from "../../src/generated/protocol";

async function join(page: Page) {
  const seen: {
    welcome?: Welcome;
    players: Map<string, Snapshot["players"][number]>;
  } = {
    players: new Map(),
  };
  page.on("websocket", (socket) =>
    socket.on("framereceived", (event) => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame.type === "welcome") seen.welcome = frame as Welcome;
        if (frame.type !== "snapshot") return;
        const snapshot = frame as Snapshot;
        if (snapshot.full) seen.players.clear();
        snapshot.removedPlayerIds.forEach((id) => seen.players.delete(id));
        snapshot.players.forEach((player) =>
          seen.players.set(player.id, player),
        );
      } catch {
        // Ignore non-JSON frames so the test reports state through its assertions.
      }
    }),
  );

  await page.goto("/");
  await page
    .getByPlaceholder("이름이나 닉네임을 알려주세요")
    .fill("auto-away-e2e");
  await page.getByLabel("체형").selectOption("0");
  await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect(page.locator(".connection-status")).toHaveText("연결됨");
  await expect(page.locator("canvas")).toBeVisible();
  await expect.poll(() => seen.welcome?.playerId).toBeTruthy();
  return seen;
}

test("automatically goes away after five idle minutes and returns on activity", async ({
  page,
}) => {
  await page.clock.install({ time: new Date() });
  const seen = await join(page);
  const playerId = seen.welcome!.playerId;
  const status = () => seen.players.get(playerId)?.status;

  await expect.poll(status).toBe("AVAILABLE");
  await page.clock.fastForward(5 * 60 * 1000 - 1_000);
  await expect.poll(status).toBe("AVAILABLE");

  // The client checks its idle threshold every ten seconds, so allow one check interval.
  await page.clock.fastForward(11_000);
  await expect.poll(status).toBe("AWAY");

  // The browser clock is mocked, but the isolated World server uses real time.
  await page.clock.resume();
  await new Promise((resolve) => setTimeout(resolve, 800));
  await page.mouse.move(20, 20);
  await expect.poll(status).toBe("AVAILABLE");

  await page.getByRole("button", { name: "참가자 보기" }).click();
  await page.getByRole("tab", { name: "설정" }).click();
  await page.getByRole("combobox", { name: "내 상태" }).selectOption("AWAY");
  await expect.poll(status).toBe("AWAY");
  await page.mouse.move(40, 40);
  await expect.poll(status).toBe("AWAY");
});
