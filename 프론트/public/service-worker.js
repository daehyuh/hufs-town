self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload = {};
      try {
        payload = event.data ? event.data.json() : {};
      } catch {
        /* Ignore malformed provider payloads. */
      }

      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const visible = windows.find(
        (client) => client.visibilityState === "visible",
      );

      if (payload.kind === "FRIEND") {
        const eventType = payload.eventType;
        if (eventType !== "FRIEND_REQUEST" && eventType !== "FRIEND_ACCEPTED")
          return;
        if (visible) {
          visible.postMessage({
            type:
              eventType === "FRIEND_REQUEST"
                ? "incoming-friend-request"
                : "friend-request-accepted",
          });
          return;
        }
        await self.registration.showNotification(
          typeof payload.title === "string" ? payload.title : "친구 알림",
          {
            body:
              typeof payload.body === "string"
                ? payload.body
                : "친구 소식이 도착했어요.",
            tag: `hufs-town-friend-${eventType}-${Date.now()}`,
            data: { kind: "FRIEND" },
          },
        );
        return;
      }

      if (payload.kind !== "DIRECT_MESSAGE") return;
      const conversationId =
        typeof payload.conversationId === "string"
          ? payload.conversationId
          : "";
      if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return;

      if (visible) {
        visible.postMessage({
          type: "incoming-direct-message",
          conversationId,
        });
        return;
      }

      await self.registration.showNotification(
        typeof payload.title === "string" ? payload.title : "HUFS Town 메시지",
        {
          body:
            typeof payload.body === "string"
              ? payload.body
              : "새 메시지가 도착했어요.",
          tag: `hufs-town-dm-${conversationId}`,
          data: { kind: "DIRECT_MESSAGE", conversationId },
        },
      );
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const isFriend = data.kind === "FRIEND";
  const conversationId = data.conversationId;
  if (
    !isFriend &&
    (typeof conversationId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(conversationId))
  )
    return;

  event.waitUntil(
    (async () => {
      const target = new URL(
        isFriend ? "/?friends=1" : `/?dm=${encodeURIComponent(conversationId)}`,
        self.location.origin,
      ).href;
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const client = windows.find(
        (item) => new URL(item.url).origin === self.location.origin,
      );
      if (client) {
        const routed = await client.navigate(target);
        const focused = routed ?? client;
        await focused.focus();
        focused.postMessage(
          isFriend
            ? { type: "open-friends" }
            : { type: "open-direct-conversation", conversationId },
        );
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
