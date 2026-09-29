import { apiGet, apiMutate } from "../auth/client";

interface PushConfiguration {
  enabled: boolean;
  publicKey: string;
}

function decodeBase64Url(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function subscriptionPayload(subscription: PushSubscription) {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!subscription.endpoint || !p256dh || !auth) {
    throw new Error("브라우저 알림 구독 정보를 읽지 못했어요. 다시 시도해 주세요.");
  }
  return { endpoint: subscription.endpoint, p256dh, auth };
}

export function pushSupported() {
  return window.isSecureContext
    && "Notification" in window
    && "serviceWorker" in navigator
    && "PushManager" in window;
}

export async function enableDirectMessagePush() {
  if (!pushSupported()) {
    throw new Error("푸시 알림은 HTTPS 또는 localhost에서 지원되는 브라우저로 사용할 수 있어요.");
  }
  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("브라우저 알림 권한을 허용해야 메시지 알림을 받을 수 있어요.");
  }

  const config = await apiGet<PushConfiguration>("push/config");
  if (!config.enabled || !config.publicKey) {
    throw new Error("푸시 알림 키 설정이 아직 준비되지 않았어요.");
  }
  const registration = await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(config.publicKey),
    });
  await apiMutate("push/subscriptions", subscriptionPayload(subscription));
}

export async function syncDirectMessagePush() {
  if (!pushSupported()) return false;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return false;
  const config = await apiGet<PushConfiguration>("push/config");
  if (!config.enabled) return false;
  await apiMutate("push/subscriptions", subscriptionPayload(subscription));
  return true;
}

export async function disableDirectMessagePush(removeAll = false) {
  const registration = "serviceWorker" in navigator
    ? await navigator.serviceWorker.getRegistration("/")
    : undefined;
  const subscription = await registration?.pushManager.getSubscription();
  if (removeAll) {
    try {
      await apiMutate("push/subscriptions", undefined, "DELETE");
    } finally {
      if (subscription) await subscription.unsubscribe();
    }
  } else if (subscription) {
    try {
      await apiMutate("push/subscriptions", { endpoint: subscription.endpoint }, "DELETE");
    } finally {
      await subscription.unsubscribe();
    }
  }
}
