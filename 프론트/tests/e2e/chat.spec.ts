import { expect, test, type Page } from "@playwright/test";

type ChatEvent = {
  channel: "nearby" | "room" | "space" | "dm";
  clientMessageId?: string;
  text: string;
  type: "chatEvent";
};

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
  await page.goto("/");
  await page.getByPlaceholder("이름이나 닉네임을 알려주세요").fill(name);
  await page.getByLabel("체형").selectOption("0");
  await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect(page.locator(".connection-status")).toHaveText("연결됨");
  await expect(page.locator("canvas")).toBeVisible();
  return events;
}

async function injectLostChatAck(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const nativeSend = NativeWebSocket.prototype.send;
    const stats = {
      ackDrops: 0,
      chatEventsDropped: 0,
      closedSockets: 0,
      incomingTypes: [] as string[],
      socketCount: 0,
      sentClientMessageIds: [] as string[],
    };
    Object.assign(window, {
      __townReconnectStats: stats,
      __townDropNextChatAck: false,
      __townDropChatEventText: "",
    });
    const FaultSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        stats.socketCount++;
        super.addEventListener("close", () => stats.closedSockets++);
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") {
          try {
            const message = JSON.parse(data);
            if (message.type === "chatSend")
              stats.sentClientMessageIds.push(message.clientMessageId);
          } catch {
            // Leave non-JSON WebSocket payloads untouched.
          }
        }
        nativeSend.call(this, data);
      }
    };
    Object.defineProperty(FaultSocket.prototype, "onmessage", {
      configurable: true,
      get() {
        return (this as any).__townMessageHandler ?? null;
      },
      set(handler: ((event: MessageEvent) => void) | null) {
        (this as any).__townMessageHandler = handler;
        if ((this as any).__townMessageListenerInstalled) return;
        (this as any).__townMessageListenerInstalled = true;
        (NativeWebSocket.prototype as any).addEventListener.call(
          this,
          "message",
          (event: MessageEvent) => {
            let message: any;
            try {
              message = JSON.parse(String(event.data));
              if (message?.type) stats.incomingTypes.push(message.type);
            } catch {
              // Ignore non-JSON frames while looking for the chat acknowledgement.
            }
            if (
              message?.type === "chatEvent" &&
              message.text === (window as any).__townDropChatEventText
            ) {
              (window as any).__townDropChatEventText = "";
              stats.chatEventsDropped++;
              return;
            }
            if (
              message?.type === "chatAck" &&
              (window as any).__townDropNextChatAck
            ) {
              (window as any).__townDropNextChatAck = false;
              stats.ackDrops++;
              setTimeout(() => (this as WebSocket).close(), 0);
              return;
            }
            (this as any).__townMessageHandler?.call(this, event);
          },
        );
      },
    });
    (window as any).WebSocket = FaultSocket;
  });
}

test("nearby chat shows the delivery scope, emoji insertion, and unread state", async ({
  browser,
}) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const sender = await contexts[0].newPage();
    const receiver = await contexts[1].newPage();
    const suffix = Math.random().toString(36).slice(2, 8);
    const senderName = `chat-sender-${suffix}`;
    const receiverEvents = await join(receiver, `chat-receiver-${suffix}`);
    await join(sender, senderName);

    const openChat = sender.getByRole("button", { name: "채팅 보기" });
    await openChat.click();
    const emptyChat = sender.locator(".chat-empty");
    await expect(emptyChat.getByText("아직 대화가 없어요")).toBeVisible();
    await expect(emptyChat.locator("span, p")).toHaveCount(0);
    await expect(
      sender.getByText("공용 공간에서 6타일 안에 있는 사람과 대화해요"),
    ).toBeVisible();

    const input = sender.getByRole("textbox", { name: "채팅 메시지" });
    await input.fill("안녕");
    await input.evaluate((element) =>
      (element as HTMLInputElement).setSelectionRange(1, 1),
    );
    const emojiTrigger = sender.getByRole("button", { name: "이모지 선택" });
    await emojiTrigger.click();
    await expect(emojiTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(
      sender.getByRole("button", { name: "인사 이모지" }),
    ).toBeFocused();
    await sender.keyboard.press("Escape");
    await expect(emojiTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(emojiTrigger).toBeFocused();
    await emojiTrigger.click();
    await sender.getByRole("button", { name: "미소 이모지" }).click();
    await expect(input).toHaveValue("안😊녕");

    await sender.getByRole("button", { name: "메시지 보내기" }).click();
    await expect
      .poll(() => receiverEvents.some((event) => event.text === "안😊녕"))
      .toBe(true);
    expect(
      receiverEvents.find((event) => event.text === "안😊녕")?.channel,
    ).toBe("nearby");

    const unreadButton = receiver.getByRole("button", {
      name: /채팅 보기, 읽지 않은 메시지 1개/,
    });
    await expect(unreadButton).toBeVisible();
    await unreadButton.click();
    await expect(receiver.getByText("안😊녕")).toBeVisible();
    await expect(
      receiver.getByRole("button", { name: "채팅 보기" }),
    ).toBeVisible();

    await sender
      .getByRole("button", { name: "공간 전체", exact: true })
      .click();
    await expect(
      sender.getByText("독립 회의실을 제외한 같은 공간의 참가자에게 전달돼요"),
    ).toBeVisible();
    const globalMessage = `space-${suffix}`;
    await input.fill(globalMessage);
    await sender.getByRole("button", { name: "메시지 보내기" }).click();
    await expect
      .poll(() => receiverEvents.some((event) => event.text === globalMessage))
      .toBe(true);
    expect(
      receiverEvents.find((event) => event.text === globalMessage)?.channel,
    ).toBe("space");
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("Enter opens map quick chat and sends to nearby people", async ({
  browser,
}) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const sender = await contexts[0].newPage();
    const receiver = await contexts[1].newPage();
    const suffix = Math.random().toString(36).slice(2, 8);
    const receiverEvents = await join(receiver, `quick-chat-peer-${suffix}`);
    await join(sender, `quick-chat-sender-${suffix}`);

    const quickChat = sender.locator(".map-quick-chat");
    await expect(
      quickChat.getByRole("button", { name: "Enter로 가까운 사람에게 채팅" }),
    ).toBeVisible();
    await sender.locator(".world-canvas").focus();
    await sender.keyboard.press("Enter");

    const input = sender.getByRole("textbox", {
      name: "가까운 사람에게 보낼 메시지",
    });
    await expect(input).toBeFocused();
    const text = `맵 빠른 채팅 ${suffix}`;
    await input.fill(text);
    await sender.keyboard.press("Enter");

    await expect
      .poll(() => receiverEvents.some((event) => event.text === text))
      .toBe(true);
    expect(receiverEvents.find((event) => event.text === text)?.channel).toBe(
      "nearby",
    );
    await expect(input).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("map quick chat fits beside the movement controls on a phone", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await join(page, "mobile-quick-chat-test");
    const trigger = page.getByRole("button", {
      name: "Enter로 가까운 사람에게 채팅",
    });
    await expect(trigger).toBeVisible();
    const bounds = await trigger.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThanOrEqual(170);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x).toBeGreaterThanOrEqual(140);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  } finally {
    await context.close();
  }
});

test("mobile chat composer stays above the virtual keyboard", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await join(page, "mobile-chat-test");
    await page.getByRole("button", { name: "채팅 보기" }).click();
    const input = page.getByRole("textbox", { name: "채팅 메시지" });
    await input.fill("모바일 키보드 확인");

    await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (!viewport) throw new Error("visualViewport is unavailable");
      Object.defineProperty(viewport, "height", {
        configurable: true,
        value: 500,
      });
      viewport.dispatchEvent(new Event("resize"));
    });

    const panel = page.locator(".info-panel");
    await expect
      .poll(async () => {
        const bounds = await panel.boundingBox();
        return bounds ? bounds.y + bounds.height : 0;
      })
      .toBeLessThanOrEqual(501);
    await expect(input).toBeVisible();
    await page.getByRole("button", { name: "메시지 보내기" }).click();
    await expect(page.getByText("모바일 키보드 확인")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a persisted chat with a lost ACK replays the same ID exactly once", async ({
  browser,
}) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const sender = await contexts[0].newPage();
    const receiver = await contexts[1].newPage();
    const message = `ack-loss-${Math.random().toString(36).slice(2, 8)}`;
    const receiverEvents = await join(receiver, `ack-receiver-${message}`);
    await injectLostChatAck(sender);
    await join(sender, `ack-sender-${message}`);
    const initialSocketCount = await sender.evaluate(
      () => (window as any).__townReconnectStats.socketCount,
    );

    await sender.getByRole("button", { name: "채팅 보기" }).click();
    await sender.getByRole("textbox", { name: "채팅 메시지" }).fill(message);
    await sender.evaluate((expectedText) => {
      (window as any).__townDropNextChatAck = true;
      (window as any).__townDropChatEventText = expectedText;
    }, message);
    await sender.getByRole("button", { name: "메시지 보내기" }).click();

    await expect
      .poll(() =>
        sender.evaluate(() => (window as any).__townReconnectStats.ackDrops),
      )
      .toBe(1);
    await expect
      .poll(() =>
        sender.evaluate(() => (window as any).__townReconnectStats.socketCount),
      )
      .toBeGreaterThan(initialSocketCount);
    await expect
      .poll(() =>
        sender.evaluate(
          () =>
            (window as any).__townReconnectStats.sentClientMessageIds.length,
        ),
      )
      .toBeGreaterThanOrEqual(2);

    const sentIds = await sender.evaluate(
      () => (window as any).__townReconnectStats.sentClientMessageIds,
    );
    expect(new Set(sentIds).size).toBe(1);
    const messageId = sentIds[0];
    await expect
      .poll(
        () =>
          receiverEvents.filter((event) => event.clientMessageId === messageId)
            .length,
      )
      .toBe(1);
    await expect(sender.getByText(message)).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
