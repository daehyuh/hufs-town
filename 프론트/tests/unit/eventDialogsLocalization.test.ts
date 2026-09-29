import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LanguageProvider } from "../../src/i18n/language";
import { DialogActionsProvider } from "../../src/components/DialogActions";
import { RoomReservationsDialog } from "../../src/events/RoomReservationsDialog";
import { ScheduledEventsDialog } from "../../src/events/ScheduledEventsDialog";
import { ChatRetentionSettingsDialog } from "../../src/social/ChatRetentionSettingsDialog";

function renderDialog(language: "ko" | "en", component: ReactNode) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: { getItem: () => language, setItem: () => undefined },
    },
  });
  try {
    return renderToStaticMarkup(
      createElement(
        LanguageProvider,
        null,
        createElement(DialogActionsProvider, null, component),
      ),
    );
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

function scheduledEvents(language: "ko" | "en") {
  return renderDialog(
    language,
    createElement(ScheduledEventsDialog, {
      space: { id: "space-id", name: "캠퍼스" },
      canManage: true,
      close: () => {},
      enter: () => {},
    }),
  );
}

function roomReservations(language: "ko" | "en") {
  return renderDialog(
    language,
    createElement(RoomReservationsDialog, {
      space: { id: "space-id", name: "캠퍼스" },
      close: () => {},
      enter: () => {},
      canEditMap: false,
      editMap: () => {},
    }),
  );
}

function chatRetention(language: "ko" | "en") {
  return renderDialog(
    language,
    createElement(ChatRetentionSettingsDialog, { close: () => {} }),
  );
}

it("renders the event schedule entry and loading state in both languages", () => {
  const korean = scheduledEvents("ko");
  const english = scheduledEvents("en");

  expect(korean).toContain("캠퍼스 행사 일정");
  expect(korean).toContain("행사 일정 등록");
  expect(korean).toContain("일정을 불러오는 중…");
  expect(english).toContain("Events · 캠퍼스");
  expect(english).toContain("Add event");
  expect(english).toContain("Loading events…");
  expect(english).toContain('aria-label="Close"');
  expect(english).not.toContain("행사 일정 등록");
});

it("renders room reservation guidance and loading state in both languages", () => {
  const korean = roomReservations("ko");
  const english = roomReservations("en");

  expect(korean).toContain("캠퍼스 회의실 예약");
  expect(korean).toContain("회의실 예약을 불러오는 중…");
  expect(english).toContain("Room reservations · 캠퍼스");
  expect(english).toContain("Loading room reservations…");
  expect(english).toContain('aria-label="Close"');
  expect(english).not.toContain("회의실 예약을 불러오는 중");
});

it("renders administrator chat retention settings in both languages", () => {
  const korean = chatRetention("ko");
  const english = chatRetention("en");

  expect(korean).toContain("채팅 보존 설정");
  expect(korean).toContain("설정을 불러오는 중…");
  expect(english).toContain("Chat retention settings");
  expect(english).toContain("Loading settings…");
  expect(english).toContain('aria-label="Close"');
});
