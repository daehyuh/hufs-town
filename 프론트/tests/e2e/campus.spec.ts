import { test, expect, type Locator, type Page } from "@playwright/test";
import type {
  PokeEvent,
  PokeAck,
  PokePreferenceState,
  Snapshot,
  Welcome,
} from "../../src/generated/protocol";
import { findPokeTarget } from "../../src/game/pokeTarget";

declare global {
  interface Window {
    __hufsCanvasText?: string[];
  }
}

async function join(page: Page, name: string, avatar = "아바타 1") {
  const seen: {
    welcome?: Welcome;
    welcomes: Welcome[];
    snapshot?: Snapshot;
    errors: string[];
    pokeEvents: PokeEvent[];
    pokeAcks: PokeAck[];
    pokeRequests: number[];
    pokePreferences: PokePreferenceState[];
    movingPositions: Array<{ x: number; y: number; tick: number }>;
  } = {
    welcomes: [],
    errors: [],
    pokeEvents: [],
    pokeAcks: [],
    pokeRequests: [],
    pokePreferences: [],
    movingPositions: [],
  };
  const players = new Map<string, Snapshot["players"][number]>();
  page.on("pageerror", (error) => seen.errors.push(error.message));
  page.on("websocket", (ws) => {
    ws.on("framesent", (e) => {
      try {
        const data = JSON.parse(String(e.payload));
        if (data.type === "poke") seen.pokeRequests.push(performance.now());
      } catch {
        // Ignore non-JSON frames.
      }
    });
    ws.on("framereceived", (e) => {
      const data = JSON.parse(String(e.payload));
      if (data.type === "snapshot") {
        const snapshot = data as Snapshot;
        if (snapshot.full) players.clear();
        snapshot.removedPlayerIds.forEach((id) => players.delete(id));
        snapshot.players.forEach((player) => players.set(player.id, player));
        seen.snapshot = {
          ...snapshot,
          full: true,
          baseTick: snapshot.tick,
          players: [...players.values()],
          removedPlayerIds: [],
        };
        const self = seen.welcome
          ? players.get(seen.welcome.playerId)
          : undefined;
        if (self?.moving)
          seen.movingPositions.push({
            x: self.x,
            y: self.y,
            tick: snapshot.tick,
          });
      }
      if (data.type === "welcome") {
        seen.welcome = data;
        seen.welcomes.push(data);
      }
      if (data.type === "pokeEvent") seen.pokeEvents.push(data as PokeEvent);
      if (data.type === "pokeAck") seen.pokeAcks.push(data as PokeAck);
      if (data.type === "pokePreferenceState")
        seen.pokePreferences.push(data as PokePreferenceState);
    });
  });
  await page.goto("/");
  await page.getByPlaceholder("이름이나 닉네임을 알려주세요").fill(name);
  const avatarIndex = Number(/(\d+)$/.exec(avatar)?.[1] ?? "1") - 1;
  await page.getByLabel("체형").selectOption(String(avatarIndex));
  await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect(page.locator(".connection-status")).toHaveText("연결됨");
  await expect(page.locator("canvas")).toBeVisible();
  await expect
    .poll(() => seen.snapshot?.players.some((p) => p.name === name))
    .toBe(true);
  return seen;
}

async function watchCanvasText(page: Page) {
  await page.addInitScript(() => {
    const rendered: string[] = [];
    Object.assign(window, { __townRenderedCanvasText: rendered });
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      text: string,
      x: number,
      y: number,
      maxWidth?: number,
    ) {
      rendered.push(text);
      return maxWidth === undefined
        ? fillText.call(this, text, x, y)
        : fillText.call(this, text, x, y, maxWidth);
    };
  });
}

async function injectMovementNetworkFaults(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const nativeSend = NativeWebSocket.prototype.send;
    const stats = { delayed: 0, dropped: 0, movementFrames: 0 };
    Object.assign(window, { __townMovementFaultStats: stats });
    (window as any).WebSocket = class extends NativeWebSocket {
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") {
          try {
            const message = JSON.parse(data);
            if (message.type === "move") {
              stats.movementFrames++;
              if (stats.movementFrames % 5 === 0) {
                stats.dropped++;
                return;
              }
              stats.delayed++;
              setTimeout(
                () => nativeSend.call(this, data),
                120 + (stats.movementFrames % 3) * 40,
              );
              return;
            }
          } catch {
            // Pass any non-JSON application frame through unchanged.
          }
        }
        nativeSend.call(this, data);
      }
    };
  });
}

async function captureWorldSockets(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    Object.assign(window, { __townWorldSockets: sockets });
    (window as any).WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes("/world/socket")) sockets.push(this);
      }
    };
  });
}

test("three browsers share movement, emotes, focus stop, and departures", async ({
  browser,
}) => {
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()));
  try {
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    await watchCanvasText(pages[1]);
    const a = await join(pages[0], "e2e-0", "아바타 1");
    const b = await join(pages[1], "e2e-1", "아바타 2");
    const c = await join(pages[2], "e2e-2", "아바타 3");
    for (const seen of [a, b, c])
      await expect
        .poll(
          () =>
            seen.snapshot?.players.filter((p) => p.name.startsWith("e2e-"))
              .length,
        )
        .toBe(3);
    const id = a.welcome!.playerId;
    const before = a.snapshot!.players.find((p) => p.id === id)!.x;
    await pages[0].locator("canvas").click();
    await pages[0].keyboard.down("KeyD");
    await expect
      .poll(() => b.snapshot?.players.find((p) => p.id === id)?.x ?? 0)
      .toBeGreaterThan(before + 1);
    await pages[0].keyboard.up("KeyD");
    const beforeClick = b.snapshot!.players.find((p) => p.id === id)!;
    const canvasBounds = await pages[0].locator("canvas").boundingBox();
    expect(canvasBounds).not.toBeNull();
    await pages[0].locator("canvas").click({
      position: {
        x: Math.min(canvasBounds!.width - 12, canvasBounds!.width / 2 + 100),
        y: canvasBounds!.height / 2,
      },
    });
    await expect
      .poll(() => {
        const player = b.snapshot?.players.find((p) => p.id === id);
        return player
          ? Math.hypot(player.x - beforeClick.x, player.y - beforeClick.y)
          : 0;
      })
      .toBeGreaterThan(0.75);
    await pages[0]
      .getByRole("button", { name: "감정표현", exact: true })
      .click();
    await pages[0].getByRole("button", { name: "인사", exact: true }).click();
    await expect
      .poll(() => c.snapshot?.players.find((p) => p.id === id)?.emoji)
      .toBe("wave");
    await expect
      .poll(() =>
        pages[1].evaluate(() =>
          (
            window as typeof window & {
              __townRenderedCanvasText: string[];
            }
          ).__townRenderedCanvasText.includes("👋"),
        ),
      )
      .toBe(true);
    await pages[0].getByRole("button", { name: "참가자 보기" }).click();
    await pages[0].getByRole("textbox", { name: "참가자 검색" }).fill("wads");
    const tick = b.snapshot!.tick;
    await expect.poll(() => b.snapshot!.tick).toBeGreaterThan(tick + 6);
    const stopped = b.snapshot!.players.find((p) => p.id === id)!;
    expect(stopped.moving).toBe(false);
    await pages[2].getByRole("button", { name: "나가기", exact: true }).click();
    await expect
      .poll(() => b.snapshot?.players.some((p) => p.name === "e2e-2"))
      .toBe(false);
    expect([...a.errors, ...b.errors, ...c.errors]).toEqual([]);
    await pages[1].screenshot({ path: "test-results/campus-desktop.png" });
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test("click-to-walk crosses a partition smoothly without backing up", async ({
  page,
}) => {
  const seen = await join(page, "smooth-click-route");
  const playerId = seen.welcome!.playerId;

  // At the default camera zoom, the viewport is wider than the distance to
  // the map edge, so Phaser clamps the camera and the canvas center no longer
  // represents the minimap focus point. Zoom in before centering on this target.
  for (let zoom = 0; zoom < 5; zoom++)
    await page.getByRole("button", { name: "확대", exact: true }).click();
  await page.getByRole("button", { name: "탐색 지도 보기" }).click();
  const miniMap = page.locator(".mini-map-canvas");
  await expect(miniMap).toBeVisible();
  const miniMapBounds = await miniMap.boundingBox();
  expect(miniMapBounds).not.toBeNull();
  const target = { x: 12.5, y: 23.5 };
  await miniMap.click({
    position: {
      x: (target.x / 48) * miniMapBounds!.width,
      y: (target.y / 34) * miniMapBounds!.height,
    },
  });
  await page.getByRole("button", { name: "탐색 지도 보기" }).click();
  const canvas = page.locator("canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const worldZoom = 1.5;
  const tileSize = 32;
  const worldWidth = bounds!.width / (tileSize * worldZoom);
  const worldHeight = bounds!.height / (tileSize * worldZoom);
  const cameraCenter = (
    coordinate: number,
    mapLength: number,
    viewLength: number,
  ) =>
    Math.max(viewLength / 2, Math.min(mapLength - viewLength / 2, coordinate));
  const cameraX = cameraCenter(target.x, 48, worldWidth);
  const cameraY = cameraCenter(target.y, 34, worldHeight);
  await canvas.click({
    position: {
      x: bounds!.width / 2 + (target.x - cameraX) * tileSize * worldZoom,
      y: bounds!.height / 2 + (target.y - cameraY) * tileSize * worldZoom,
    },
  });

  await expect
    .poll(
      () => seen.snapshot?.players.find((item) => item.id === playerId)?.zoneId,
      { timeout: 18_000 },
    )
    .toBe("lounge");
  await expect
    .poll(
      () => seen.snapshot?.players.find((item) => item.id === playerId)?.moving,
      { timeout: 8_000 },
    )
    .toBe(false);
  await expect
    .poll(
      () => {
        const player = seen.snapshot?.players.find(
          (item) => item.id === playerId,
        );
        return player
          ? Math.hypot(player.x - target.x, player.y - target.y)
          : Infinity;
      },
      { timeout: 10_000 },
    )
    .toBeLessThan(0.35);

  expect(seen.movingPositions.length).toBeGreaterThan(20);
  let backwardsSamples = 0;
  for (let index = 2; index < seen.movingPositions.length; index++) {
    const before = seen.movingPositions[index - 1];
    const current = seen.movingPositions[index];
    const previous = seen.movingPositions[index - 2];
    const incoming = { x: before.x - previous.x, y: before.y - previous.y };
    const outgoing = { x: current.x - before.x, y: current.y - before.y };
    const lengths =
      Math.hypot(incoming.x, incoming.y) * Math.hypot(outgoing.x, outgoing.y);
    if (
      lengths > 0.0001 &&
      incoming.x * outgoing.x + incoming.y * outgoing.y < -0.25 * lengths
    )
      backwardsSamples++;
  }
  expect(backwardsSamples).toBe(0);
  expect(seen.errors).toEqual([]);
});

test("authoritative movement converges under delayed and dropped inputs", async ({
  browser,
}) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext()));
  try {
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    await injectMovementNetworkFaults(pages[0]);
    const [sender, observer] = await Promise.all([
      join(pages[0], "lag-move-sender"),
      join(pages[1], "lag-move-observer", "아바타 2"),
    ]);
    const playerId = sender.welcome!.playerId;
    await expect
      .poll(
        () =>
          observer.snapshot?.players.filter((player) =>
            player.name.startsWith("lag-move-"),
          ).length,
      )
      .toBe(2);
    const before = sender.snapshot!.players.find(
      (player) => player.id === playerId,
    )!.x;

    await pages[0].locator("canvas").click();
    await pages[0].keyboard.down("KeyD");
    await expect
      .poll(
        () =>
          observer.snapshot?.players.find((player) => player.id === playerId)
            ?.x ?? before,
      )
      .toBeGreaterThan(before + 1);
    await pages[0].waitForTimeout(900);
    await pages[0].keyboard.up("KeyD");

    await expect
      .poll(
        () =>
          sender.snapshot?.players.find((player) => player.id === playerId)
            ?.moving,
      )
      .toBe(false);
    await expect
      .poll(
        () =>
          observer.snapshot?.players.find((player) => player.id === playerId)
            ?.moving,
      )
      .toBe(false);
    await expect
      .poll(async () => {
        const local = sender.snapshot?.players.find(
          (player) => player.id === playerId,
        );
        const remote = observer.snapshot?.players.find(
          (player) => player.id === playerId,
        );
        return local && remote
          ? Math.abs(local.x - remote.x)
          : Number.POSITIVE_INFINITY;
      })
      .toBeLessThan(0.1);
    await expect
      .poll(() =>
        pages[0].evaluate(
          () =>
            (window as any).__townMovementFaultStats.dropped > 0 &&
            (window as any).__townMovementFaultStats.delayed > 0,
        ),
      )
      .toBe(true);
    expect(sender.snapshot!.inputAckSeq).toBeGreaterThan(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("an offline client retries without blocking another player and resumes its seat", async ({
  browser,
}) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const slowPage = await contexts[0].newPage();
    const activePage = await contexts[1].newPage();
    await captureWorldSockets(slowPage);
    const suffix = Math.random().toString(36).slice(2, 7);
    const [slow, active] = await Promise.all([
      join(slowPage, `offline-${suffix}`),
      join(activePage, `active-${suffix}`, "아바타 2"),
    ]);
    const slowId = slow.welcome!.playerId;
    const startEpoch = slow.welcome!.epoch;
    const retainedPosition = slow.snapshot!.players.find(
      (player) => player.id === slowId,
    )!;
    const activeId = active.welcome!.playerId;
    const activeX = active.snapshot!.players.find(
      (player) => player.id === activeId,
    )!.x;

    await contexts[0].setOffline(true);
    await slowPage.evaluate(() => {
      const sockets = (window as any).__townWorldSockets as WebSocket[];
      sockets.at(-1)?.close();
    });
    await activePage.locator("canvas").click();
    await activePage.keyboard.down("KeyD");
    await expect
      .poll(
        () =>
          active.snapshot?.players.find((player) => player.id === activeId)
            ?.x ?? activeX,
      )
      .toBeGreaterThan(activeX + 1);
    await activePage.keyboard.up("KeyD");

    await contexts[0].setOffline(false);
    await expect
      .poll(() => slow.welcomes.length, { timeout: 20_000 })
      .toBeGreaterThan(1);
    const resumed = slow.welcomes.at(-1)!;
    expect(resumed.playerId).toBe(slowId);
    expect(resumed.epoch).toBeGreaterThan(startEpoch);
    await expect
      .poll(
        () =>
          slow.snapshot?.players.filter((player) => player.id === slowId)
            .length,
      )
      .toBe(1);
    const resumedPosition = slow.snapshot!.players.find(
      (player) => player.id === slowId,
    )!;
    expect(
      Math.hypot(
        resumedPosition.x - retainedPosition.x,
        resumedPosition.y - retainedPosition.y,
      ),
    ).toBeLessThan(0.1);
    expect(
      active.snapshot!.players.some((player) => player.id === activeId),
    ).toBe(true);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("pokes respect receiver settings, reach only the target, and enforce cooldown", async ({
  browser,
}) => {
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()));
  try {
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    await watchCanvasText(pages[1]);
    const suffix = Math.random().toString(36).slice(2, 7);
    const senderName = `poke-sender-${suffix}`;
    const targetName = `poke-target-${suffix}`;
    const bystanderName = `poke-bystander-${suffix}`;
    const [senderState, targetState, bystanderState] = await Promise.all([
      join(pages[0], senderName),
      join(pages[1], targetName, "아바타 2"),
      join(pages[2], bystanderName, "아바타 3"),
    ]);
    for (const state of [senderState, targetState, bystanderState])
      await expect
        .poll(
          () =>
            state.snapshot?.players.filter((player) =>
              player.name.startsWith("poke-"),
            ).length,
        )
        .toBe(3);

    await pages[1].getByRole("button", { name: "참가자 보기" }).click();
    await pages[1].getByRole("tab", { name: "설정" }).click();
    const receivePokes = pages[1].getByRole("checkbox", {
      name: /찌르기 받기/,
    });
    await expect(receivePokes).toBeChecked();
    await receivePokes.uncheck();
    await expect
      .poll(() => targetState.pokePreferences.at(-1)?.enabled)
      .toBe(false);

    await pages[0].getByRole("button", { name: "참가자 보기" }).click();
    await pages[0]
      .getByRole("textbox", { name: "참가자 검색" })
      .fill(targetName);
    const pokeTarget = pages[0].getByRole("button", {
      name: `${targetName}님 찌르기`,
    });
    await expect(pokeTarget).toBeEnabled();
    await pokeTarget.click();
    await expect.poll(() => senderState.pokeRequests.length).toBe(1);
    await expect
      .poll(() => senderState.pokeAcks.at(-1)?.code)
      .toBe("POKE_DISABLED");
    await expect(
      pages[0].getByText("상대가 지금은 찌르기를 받지 않아요."),
    ).toBeVisible();
    expect(targetState.pokeEvents).toHaveLength(0);
    expect(bystanderState.pokeEvents).toHaveLength(0);

    await pokeTarget.click();
    await expect.poll(() => senderState.pokeRequests.length).toBe(2);
    expect(
      senderState.pokeRequests[1] - senderState.pokeRequests[0],
    ).toBeLessThan(3000);
    await expect.poll(() => senderState.pokeAcks.length).toBe(2);
    expect(senderState.pokeAcks.at(-1)?.code).toBe("POKE_COOLDOWN");
    await expect(
      pages[0].getByText("조금 기다렸다가 다시 찔러 주세요."),
    ).toBeVisible();
    await pages[0].waitForTimeout(2100);

    await receivePokes.check();
    await expect
      .poll(() => targetState.pokePreferences.at(-1)?.enabled)
      .toBe(true);
    await pokeTarget.click();
    await expect.poll(() => senderState.pokeRequests.length).toBe(3);
    await expect.poll(() => senderState.pokeAcks.at(-1)?.accepted).toBe(true);
    await expect.poll(() => targetState.pokeEvents.length).toBe(1);
    await expect(
      pages[1].getByText(`${senderName}님이 콕 찔렀어요.`),
    ).toBeVisible();
    await expect
      .poll(() =>
        pages[1].evaluate(() =>
          (
            window as typeof window & {
              __townRenderedCanvasText: string[];
            }
          ).__townRenderedCanvasText.includes("👉"),
        ),
      )
      .toBe(true);

    await pokeTarget.click();
    await expect.poll(() => senderState.pokeRequests.length).toBe(4);
    await expect.poll(() => senderState.pokeAcks.length).toBe(4);
    expect(
      senderState.pokeRequests[3] - senderState.pokeRequests[2],
    ).toBeLessThan(3000);
    expect(senderState.pokeAcks.at(-1)?.code).toBe("POKE_COOLDOWN");
    await expect(
      pages[0].getByText("조금 기다렸다가 다시 찔러 주세요."),
    ).toBeVisible();
    expect(targetState.pokeEvents[0].senderName).toBe(senderName);
    expect(senderState.pokeEvents).toHaveLength(0);
    expect(bystanderState.pokeEvents).toHaveLength(0);

    expect([
      ...senderState.errors,
      ...targetState.errors,
      ...bystanderState.errors,
    ]).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("Z sends a finger poke to the nearest person in front", async ({
  browser,
}) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext()));
  try {
    const [senderPage, targetPage] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    await watchCanvasText(senderPage);
    await watchCanvasText(targetPage);
    const suffix = Math.random().toString(36).slice(2, 7);
    const senderName = `z-poke-sender-${suffix}`;
    const targetName = `z-poke-target-${suffix}`;
    const [senderState, targetState] = await Promise.all([
      join(senderPage, senderName),
      join(targetPage, targetName, "아바타 2"),
    ]);
    for (const state of [senderState, targetState])
      await expect
        .poll(
          () =>
            state.snapshot?.players.filter((player) =>
              player.name.startsWith("z-poke-"),
            ).length,
        )
        .toBe(2);

    const senderId = senderState.welcome!.playerId;
    const targetId = targetState.welcome!.playerId;
    const initialSender = senderState.snapshot!.players.find(
      (player) => player.id === senderId,
    )!;
    const initialTarget = senderState.snapshot!.players.find(
      (player) => player.id === targetId,
    )!;
    await targetPage.locator("canvas").click();
    await targetPage.keyboard.down("ArrowRight");
    await expect
      .poll(
        () =>
          targetState.snapshot?.players.find((player) => player.id === targetId)
            ?.x ?? initialTarget.x,
      )
      .toBeGreaterThan(initialTarget.x + 1);
    await targetPage.keyboard.up("ArrowRight");

    const players = senderState.snapshot!.players;
    const directions = ["down", "left", "right", "up"] as const;
    const direction = directions.find(
      (facing) =>
        findPokeTarget({ ...initialSender, direction: facing }, players)?.id ===
        targetId,
    );
    expect(direction).toBeDefined();

    const directionKey = {
      down: "ArrowDown",
      left: "ArrowLeft",
      right: "ArrowRight",
      up: "ArrowUp",
    }[direction!];
    await senderPage.locator("canvas").click();
    if (initialSender.direction !== direction) {
      await senderPage.keyboard.down(directionKey);
      await senderPage.waitForTimeout(100);
      await senderPage.keyboard.up(directionKey);
      await expect
        .poll(
          () =>
            senderState.snapshot?.players.find(
              (player) => player.id === senderId,
            )?.direction,
        )
        .toBe(direction);
    }

    await senderPage.keyboard.press("z");
    await expect.poll(() => senderState.pokeAcks.at(-1)?.accepted).toBe(true);
    await expect.poll(() => targetState.pokeEvents.length).toBe(1);
    await expect(
      targetPage.getByText(`${senderName}님이 콕 찔렀어요.`),
    ).toBeVisible();
    for (const page of [senderPage, targetPage])
      await expect
        .poll(() =>
          page.evaluate(() =>
            (
              window as typeof window & {
                __townRenderedCanvasText: string[];
              }
            ).__townRenderedCanvasText.includes("👉"),
          ),
        )
        .toBe(true);
    expect([...senderState.errors, ...targetState.errors]).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("landing fits a small screen and requires a nickname", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "캠퍼스 입장하기" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/landing-mobile.png",
    fullPage: true,
  });
});

test("mobile touch controls move the avatar and remain usable in landscape", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    const state = await join(page, "mobile-movement-test");
    const playerId = state.welcome!.playerId;
    const movementPad = page.getByRole("group", { name: "터치 이동 조작" });
    await expect(movementPad).toBeVisible();
    const initialX = state.snapshot!.players.find(
      (player) => player.id === playerId,
    )!.x;
    const rightButton = page.getByRole("button", { name: "오른쪽 이동" });
    const rightBounds = (await rightButton.boundingBox())!;
    const touch = await context.newCDPSession(page);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        {
          id: 1,
          x: rightBounds.x + rightBounds.width / 2,
          y: rightBounds.y + rightBounds.height / 2,
        },
      ],
    });
    await page.waitForTimeout(600);
    await expect
      .poll(
        () =>
          state.snapshot?.players.find((player) => player.id === playerId)?.x ??
          initialX,
      )
      .toBeGreaterThan(initialX + 0.25);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForTimeout(300);
    const stoppedX = state.snapshot!.players.find(
      (player) => player.id === playerId,
    )!.x;
    await page.waitForTimeout(300);
    const settledX = state.snapshot!.players.find(
      (player) => player.id === playerId,
    )!.x;
    expect(Math.abs(settledX - stoppedX)).toBeLessThan(0.05);
    await page.getByRole("button", { name: "달리기" }).click();
    await expect(page.getByRole("button", { name: "달리기" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.setViewportSize({ width: 844, height: 390 });
    await expect(movementPad).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(state.errors).toEqual([]);
  } finally {
    await context.close();
  }
});

for (const language of ["ko", "en"] as const) {
  test(`${language} keyboard-only joining and movement expose accessible campus status`, async ({
    page,
  }) => {
    const labels =
      language === "ko"
        ? {
            nickname: "이름이나 닉네임을 알려주세요",
            enter: "캠퍼스 입장하기",
            connected: "연결됨",
            spaceInfo: "가상 공간 정보",
            participantStatus: "현재 참가 인원 1명, 정원 100명",
            map: "맵:",
            currentLocation: "현재 위치:",
            participantCount: "참가자: 1명",
            locationStatus: "현재 위치는",
            people: "참가자 보기",
            closePanel: "패널 닫기",
            settingsTab: "설정",
            myStatus: "내 상태",
            allowPokes: "찌르기 받기",
            lowSpec: "저사양 모드",
            chat: "채팅 보기",
            chatTitle: "실시간 채팅",
            nearbyChat: "가까운 사람",
            chatPlaceholder: "메시지를 입력하세요",
          }
        : {
            nickname: "Enter your name or nickname",
            enter: "Enter campus",
            connected: "Connected",
            spaceInfo: "Virtual space information",
            participantStatus: "Participants 1, capacity 100",
            map: "Map:",
            currentLocation: "Current location:",
            participantCount: "Participants: 1",
            locationStatus: "Your location is",
            people: "View participants",
            closePanel: "Close panel",
            settingsTab: "Settings",
            myStatus: "My status",
            allowPokes: "Allow pokes",
            lowSpec: "Low-spec mode",
            chat: "View chat",
            chatTitle: "Live chat",
            nearbyChat: "Nearby",
            chatPlaceholder: "Write a message",
          };
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript((selectedLanguage) => {
      localStorage.setItem("hufs.language", selectedLanguage);
    }, language);
    await page.goto("/");
    const focusByTab = async (target: Locator) => {
      for (let index = 0; index < 80; index++) {
        if (
          await target.evaluate((element) => element === document.activeElement)
        )
          return;
        await page.keyboard.press("Tab");
      }
      throw new Error("The target control was not reachable with Tab.");
    };
    const nickname = page.getByPlaceholder(labels.nickname);
    await focusByTab(nickname);
    await expect(nickname).toBeFocused();
    await page.keyboard.type("keyboard-check");
    await expect(
      page.getByRole("button", { name: labels.enter }),
    ).toBeEnabled();
    await page.keyboard.press("Enter");
    await expect(page.locator(".connection-status")).toHaveText(
      labels.connected,
    );
    await expect(page.locator(".world-canvas")).toBeVisible();

    const canvas = page.locator(".world-canvas");
    const worldInfo = page.getByRole("region", { name: labels.spaceInfo });
    const participantStatus = page.getByRole("status", {
      name: labels.participantStatus,
    });

    await expect(canvas).toHaveAttribute("role", "application");
    await expect(canvas).toHaveAttribute(
      "aria-describedby",
      "world-controls-description",
    );
    await expect(participantStatus).toBeVisible();
    await expect(worldInfo).toContainText(labels.map);
    await expect(worldInfo).toContainText(labels.currentLocation);
    await expect(worldInfo).toContainText(labels.participantCount);
    await expect(worldInfo.getByRole("status")).toContainText(
      labels.locationStatus,
    );

    const peopleToggle = page.getByRole("button", { name: labels.people });
    await focusByTab(peopleToggle);
    await expect(peopleToggle).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(peopleToggle).toHaveAttribute("aria-expanded", "true");
    await expect(peopleToggle).toHaveAttribute(
      "aria-controls",
      "campus-info-panel",
    );
    await expect(page.locator(".panel-heading .card-kicker")).toHaveCount(0);
    const panelTitle = page.locator("#campus-panel-title");
    await expect(panelTitle).toContainText(
      language === "ko" ? "참가자" : "Participants",
    );
    await expect(panelTitle.locator("span")).toHaveText("1");
    await expect(page.locator("#campus-info-panel")).toHaveAttribute(
      "aria-labelledby",
      "campus-panel-title",
    );
    await page.getByRole("tab", { name: labels.settingsTab }).click();
    await expect(
      page.getByRole("combobox", { name: labels.myStatus }),
    ).toBeVisible();
    await expect(page.getByText(labels.allowPokes)).toBeVisible();
    await expect(page.getByText(labels.lowSpec)).toBeVisible();
    const closePanel = page.getByRole("button", { name: labels.closePanel });
    await focusByTab(closePanel);
    await page.keyboard.press("Enter");
    await expect(peopleToggle).toHaveAttribute("aria-expanded", "false");
    const chatToggle = page.getByRole("button", { name: labels.chat });
    await chatToggle.click();
    await expect(page.locator("#campus-panel-title")).toHaveText(
      labels.chatTitle,
    );
    await expect(
      page.getByRole("button", { name: labels.nearbyChat, exact: true }),
    ).toBeVisible();
    await expect(page.getByPlaceholder(labels.chatPlaceholder)).toBeVisible();
    await chatToggle.click();
    await expect(chatToggle).toHaveAttribute("aria-expanded", "false");

    const coordinates = worldInfo.getByText(
      language === "ko" ? /^좌표:/ : /^Coordinates:/,
    );
    const before = await coordinates.textContent();
    await focusByTab(canvas);
    await expect(canvas).toBeFocused();
    await page.keyboard.down("ArrowRight");
    await expect.poll(() => coordinates.textContent()).not.toBe(before);
    await page.keyboard.up("ArrowRight");
    expect(pageErrors).toEqual([]);
  });
}

test("in-world language picker updates labels and fits the mobile header", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const textWindow = window as Window & { __hufsCanvasText?: string[] };
    textWindow.__hufsCanvasText = [];
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      const text = String(args[0]);
      if (text.includes("language-switch") || text.includes(" · "))
        textWindow.__hufsCanvasText?.push(text);
      return Reflect.apply(originalFillText, this, args);
    };
  });
  await join(page, "language-switch");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__hufsCanvasText?.some((text) =>
          text.includes("language-switch · 나"),
        ),
      ),
    )
    .toBe(true);
  const picker = page.locator(".app-header .language-picker select");
  await expect(picker).toHaveValue("ko");
  await picker.selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__hufsCanvasText?.some((text) =>
          text.includes("language-switch · You"),
        ),
      ),
    )
    .toBe(true);
  await expect(page.locator(".connection-status")).toHaveText("Connected");
  await expect(page.getByRole("button", { name: "Help" })).toHaveCount(0);
  await expect(
    page.getByText(/Campus user guide|캠퍼스 사용 설명서/),
  ).toHaveCount(0);
  await expect(page.locator(".movement-hint")).toContainText(
    "Click the map to walk to a destination",
  );
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("hufs.language")))
    .toBe("en");

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await picker.selectOption("ko");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__hufsCanvasText?.some((text) =>
          text.includes("language-switch · 나"),
        ),
      ),
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: "이용 안내" })).toHaveCount(0);
  await expect(
    page.getByText(/캠퍼스 사용 설명서|첫 인사는 가볍게/),
  ).toHaveCount(0);
});

test("wardrobe changes appear on other players and retain profile details", async ({
  browser,
}) => {
  test.setTimeout(75_000);
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const owner = await contexts[0].newPage();
    const observer = await contexts[1].newPage();
    const ownerState = await join(owner, "wardrobe-owner");
    const observerState = await join(observer, "wardrobe-observer", "아바타 2");
    const playerId = ownerState.welcome!.playerId;

    await owner
      .getByRole("button", { name: "내 이름, 아바타, 소개 편집" })
      .click();
    const dialog = owner.getByRole("dialog", { name: "내 아바타와 프로필" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.locator(".wardrobe-preview-stage .pixel-avatar"),
    ).toHaveCount(1);
    await expect(dialog.locator(".avatar-choice")).toHaveCount(0);
    await expect(dialog.getByLabel("체형")).toBeVisible();
    await dialog
      .getByLabel("캠퍼스에서 불릴 이름", { exact: true })
      .fill("봄날의 편집자");
    await dialog.getByLabel("체형").selectOption({ label: "든든한 체형" });
    await dialog
      .locator(".wardrobe-item-grid")
      .getByRole("button", { name: "갑옷 귀여운" })
      .click();
    await dialog
      .locator(".wardrobe-category-tabs")
      .getByRole("button", { name: "피부색" })
      .click();
    await dialog
      .locator(".wardrobe-skin-grid")
      .getByRole("button", { name: "검정" })
      .click();
    await dialog
      .locator(".wardrobe-category-tabs")
      .getByRole("button", { name: "헤어" })
      .click();
    await dialog
      .locator(".wardrobe-item-grid")
      .getByRole("button", { name: "아프로 검정" })
      .click();
    await dialog.getByLabel("자기소개").fill("함께 걷고 만드는 캠퍼스");
    await dialog.getByRole("button", { name: "링크 추가" }).click();
    await dialog
      .locator('input[type="url"][aria-label="프로필 링크 1"]')
      .fill("https://example.com/hufs");
    await dialog.getByRole("button", { name: "저장하고 적용" }).click();

    await expect(dialog).toBeHidden();
    await expect
      .poll(
        () =>
          observerState.snapshot?.players.find(
            (player) => player.id === playerId,
          )?.name,
      )
      .toBe("봄날의 편집자");
    const updated = observerState.snapshot!.players.find(
      (player) => player.id === playerId,
    )!;
    expect(updated.avatar).toBe(2);
    expect(updated.skin).toBe("black");
    expect(updated.clothing).toBe("armor_cute");
    expect(updated.hair).toBe("hair_afro_black");
    expect(updated.bio).toBe("함께 걷고 만드는 캠퍼스");
    expect(updated.links).toEqual(["https://example.com/hufs"]);
    await observer.getByRole("button", { name: "참가자 보기" }).click();
    await observer
      .getByRole("textbox", { name: "참가자 검색" })
      .fill("봄날의 편집자");
    await observer
      .getByRole("button", { name: "봄날의 편집자님 프로필 보기" })
      .click();
    const profileCard = observer.getByRole("dialog", {
      name: "봄날의 편집자님 프로필",
    });
    await expect(
      profileCard.getByText("함께 걷고 만드는 캠퍼스"),
    ).toBeVisible();
    await expect(
      profileCard.getByRole("link", { name: "https://example.com/hufs" }),
    ).toHaveAttribute("href", "https://example.com/hufs");
    await profileCard.locator(".profile-close").click();

    await owner.goto("/");
    await expect(
      owner.getByPlaceholder("이름이나 닉네임을 알려주세요"),
    ).toHaveValue("봄날의 편집자");
    await owner.getByRole("button", { name: "캠퍼스 입장하기" }).click();
    await expect(owner.locator(".connection-status")).toHaveText("연결됨");
    await expect
      .poll(
        () =>
          observerState.snapshot?.players.filter(
            (player) => player.name === "봄날의 편집자",
          ).length,
      )
      .toBe(1);
    await expect
      .poll(
        () =>
          observerState.snapshot?.players.find(
            (player) => player.name === "봄날의 편집자",
          )?.bio,
      )
      .toBe("함께 걷고 만드는 캠퍼스");
    await expect
      .poll(
        () =>
          observerState.snapshot?.players.find(
            (player) => player.name === "봄날의 편집자",
          )?.links,
      )
      .toEqual(["https://example.com/hufs"]);
    const rejoined = observerState.snapshot!.players.find(
      (player) => player.name === "봄날의 편집자",
    )!;
    expect(rejoined.avatar).toBe(2);
    expect(rejoined.skin).toBe(updated.skin);
    expect(rejoined.clothing).toBe(updated.clothing);
    expect(rejoined.hair).toBe(updated.hair);
    expect(rejoined.bio).toBe("함께 걷고 만드는 캠퍼스");
    expect(rejoined.links).toEqual(["https://example.com/hufs"]);
    expect([...ownerState.errors, ...observerState.errors]).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
