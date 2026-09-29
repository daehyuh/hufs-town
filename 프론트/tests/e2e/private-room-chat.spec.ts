import { expect, test, type Page } from "@playwright/test";

type ChatEvent = {
  channel: "nearby" | "room" | "space" | "dm";
  text: string;
  type: "chatEvent";
};

async function installWalker(page: Page) {
  await page.addInitScript(() => {
    const drawnCanvasText: string[] = [];
    Object.assign(window, { __townDrawnCanvasText: drawnCanvasText });
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      text: string,
      x: number,
      y: number,
      maxWidth?: number,
    ) {
      drawnCanvasText.push(text);
      return maxWidth === undefined
        ? originalFillText.call(this, text, x, y)
        : originalFillText.call(this, text, x, y, maxWidth);
    };

    const OriginalSocket = window.WebSocket;
    window.WebSocket = class extends OriginalSocket {
      epoch = 0;
      playerId = "";
      sequence = 0;
      manual = false;
      position = { x: 0, y: 0 };

      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes("/world/socket"))
          Object.assign(window, { __townSocket: this });
        this.addEventListener("message", (event) => {
          const value = JSON.parse(String(event.data));
          if (value.type === "welcome") {
            this.epoch = value.epoch;
            this.playerId = value.playerId;
            this.sequence = 0;
          }
          if (value.type === "snapshot") {
            const self = value.players.find(
              (player: { id: string }) => player.id === this.playerId,
            );
            if (self) this.position = self;
          }
        });
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") {
          const message = JSON.parse(data);
          if (message.type === "move") {
            if (this.manual) return;
            message.seq = ++this.sequence;
            data = JSON.stringify(message);
          }
        }
        super.send(data);
      }

      async walk(axis: "x" | "y", target: number) {
        const delay = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms));
        const move = (direction: number) =>
          super.send(
            JSON.stringify({
              type: "move",
              epoch: this.epoch,
              seq: ++this.sequence,
              dx: axis === "x" ? direction : 0,
              dy: axis === "y" ? direction : 0,
              running: false,
            }),
          );
        const deadline = Date.now() + 25_000;
        this.manual = true;
        try {
          while (
            Math.abs(target - this.position[axis]) > 0.16 &&
            Date.now() < deadline
          ) {
            const difference = target - this.position[axis];
            move(Math.sign(difference));
            await delay(Math.abs(difference) > 0.9 ? 100 : 50);
            if (Math.abs(difference) <= 0.9) {
              move(0);
              await delay(200);
            }
          }
          move(0);
          await delay(200);
          return this.position[axis];
        } finally {
          move(0);
          this.manual = false;
        }
      }
    };
  });
}

async function join(page: Page, name: string) {
  const events: ChatEvent[] = [];
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      try {
        const event = JSON.parse(String(frame.payload)) as ChatEvent;
        if (event.type === "chatEvent") events.push(event);
      } catch {
        // Ignore non-JSON frames from browser extensions or dev tooling.
      }
    }),
  );
  await installWalker(page);
  await page.goto("/");
  await page.getByPlaceholder("이름이나 닉네임을 알려주세요").fill(name);
  await page.getByLabel("체형").selectOption("0");
  await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect(page.locator(".connection-status")).toHaveText("연결됨");
  return events;
}

async function walk(page: Page, axis: "x" | "y", target: number) {
  const position = await page.evaluate(
    ({ axis, target }) =>
      (
        window as unknown as {
          __townSocket: {
            walk(axis: "x" | "y", target: number): Promise<number>;
          };
        }
      ).__townSocket.walk(axis, target),
    { axis, target },
  );
  expect(
    Math.abs(position - target),
    `Reach ${axis}=${target}, actual=${position}`,
  ).toBeLessThanOrEqual(0.2);
}

test("private-room chat stays inside the room boundary", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all(
    [0, 1, 2].map(() =>
      browser.newContext({ viewport: { width: 960, height: 720 } }),
    ),
  );
  try {
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const [roomSender, roomReceiver, publicPeer] = pages;
    const suffix = Math.random().toString(36).slice(2, 7);
    const [senderEvents, receiverEvents, publicEvents] = await Promise.all([
      join(roomSender, `room-sender-${suffix}`),
      join(roomReceiver, `room-peer-${suffix}`),
      join(publicPeer, `public-peer-${suffix}`),
    ]);

    await Promise.all(
      pages.map(async (page) => {
        await walk(page, "x", 26.95);
        await walk(page, "y", 13.45);
        await walk(page, "x", 7.6);
      }),
    );
    await Promise.all(
      [roomSender, roomReceiver].map((page) => walk(page, "y", 11.7)),
    );
    await Promise.all(
      [roomSender, roomReceiver].map((page) =>
        expect(page.getByText("현재 위치: 회의실 A")).toBeVisible(),
      ),
    );

    for (const page of [roomSender, roomReceiver]) {
      await page.getByRole("button", { name: "채팅 보기" }).click();
      await expect(
        page.getByText("이 회의실에 있는 사람만 볼 수 있어요"),
      ).toBeVisible();
    }
    const privateMessage = `room-${suffix}`;
    await roomSender
      .getByRole("textbox", { name: "채팅 메시지" })
      .fill(privateMessage);
    await roomSender.getByRole("button", { name: "메시지 보내기" }).click();
    await expect
      .poll(() =>
        receiverEvents.some(
          (event) => event.channel === "room" && event.text === privateMessage,
        ),
      )
      .toBe(true);
    await expect(roomReceiver.getByText(privateMessage)).toBeVisible();
    await expect
      .poll(() =>
        roomReceiver.evaluate(
          (text) =>
            (
              window as unknown as { __townDrawnCanvasText: string[] }
            ).__townDrawnCanvasText.includes(text),
          privateMessage,
        ),
      )
      .toBe(true);
    expect(
      senderEvents.find((event) => event.text === privateMessage)?.channel,
    ).toBe("room");
    expect(publicEvents.some((event) => event.text === privateMessage)).toBe(
      false,
    );

    await publicPeer.getByRole("button", { name: "채팅 보기" }).click();
    await publicPeer
      .getByRole("button", { name: "공간 전체", exact: true })
      .click();
    const globalMessage = `outside-${suffix}`;
    await publicPeer
      .getByRole("textbox", { name: "채팅 메시지" })
      .fill(globalMessage);
    await publicPeer.getByRole("button", { name: "메시지 보내기" }).click();
    await expect
      .poll(() => publicEvents.some((event) => event.text === globalMessage))
      .toBe(true);
    await publicPeer.waitForTimeout(500);
    expect(
      senderEvents.some((event) => event.text === globalMessage) ||
        receiverEvents.some((event) => event.text === globalMessage),
    ).toBe(false);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
