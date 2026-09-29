import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Client = {
  url: string;
  visibilityState?: string;
  postMessage: ReturnType<typeof vi.fn>;
  navigate?: ReturnType<typeof vi.fn>;
  focus?: ReturnType<typeof vi.fn>;
};

function createWorker(clients: Client[] = []) {
  const listeners = new Map<string, (event: any) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const worker = {
    addEventListener: (type: string, callback: (event: any) => void) => {
      listeners.set(type, callback);
    },
    clients: {
      matchAll: vi.fn().mockResolvedValue(clients),
      openWindow,
    },
    location: { origin: "https://town.example" },
    registration: { showNotification },
  };
  const source = readFileSync(
    fileURLToPath(new URL("../../public/service-worker.js", import.meta.url)),
    "utf8",
  );
  runInNewContext(source, { self: worker, URL, Date });
  return { listeners, showNotification, openWindow };
}

async function dispatchPush(listener: (event: any) => void, payload: unknown) {
  let pending: Promise<unknown> | undefined;
  listener({
    data: { json: () => payload },
    waitUntil: (promise: Promise<unknown>) => {
      pending = promise;
    },
  });
  await pending;
}

describe("service worker push routing", () => {
  it("refreshes an open app for a friend request without showing a notification", async () => {
    const visibleWindow: Client = {
      url: "https://town.example/",
      visibilityState: "visible",
      postMessage: vi.fn(),
    };
    const worker = createWorker([visibleWindow]);

    await dispatchPush(worker.listeners.get("push")!, {
      kind: "FRIEND",
      eventType: "FRIEND_REQUEST",
    });

    expect(visibleWindow.postMessage).toHaveBeenCalledWith({
      type: "incoming-friend-request",
    });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("shows a generic background friend notification and ignores unknown events", async () => {
    const worker = createWorker();
    const push = worker.listeners.get("push")!;

    await dispatchPush(push, {
      kind: "FRIEND",
      eventType: "FRIEND_ACCEPTED",
      title: "친구 알림",
      body: "친구 요청을 수락했어요.",
    });

    expect(worker.showNotification).toHaveBeenCalledWith(
      "친구 알림",
      expect.objectContaining({
        body: "친구 요청을 수락했어요.",
        data: { kind: "FRIEND" },
        tag: expect.stringMatching(/^hufs-town-friend-FRIEND_ACCEPTED-/),
      }),
    );

    await dispatchPush(push, {
      kind: "FRIEND",
      eventType: "FRIEND_REMOVED",
    });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
  });

  it("opens the friends dialog when a background friend notification is clicked", async () => {
    const existingWindow: Client = {
      url: "https://town.example/",
      postMessage: vi.fn(),
      navigate: vi.fn().mockResolvedValue(undefined),
      focus: vi.fn().mockResolvedValue(undefined),
    };
    const worker = createWorker([existingWindow]);
    const notification = { data: { kind: "FRIEND" }, close: vi.fn() };
    let pending: Promise<unknown> | undefined;

    worker.listeners.get("notificationclick")!({
      notification,
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;

    expect(notification.close).toHaveBeenCalledOnce();
    expect(existingWindow.navigate).toHaveBeenCalledWith(
      "https://town.example/?friends=1",
    );
    expect(existingWindow.focus).toHaveBeenCalledOnce();
    expect(existingWindow.postMessage).toHaveBeenCalledWith({
      type: "open-friends",
    });
  });
});
