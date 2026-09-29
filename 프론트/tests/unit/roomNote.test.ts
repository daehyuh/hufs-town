import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { RoomNoteState } from "../../src/generated/protocol";
import { LanguageProvider } from "../../src/i18n/language";
import {
  ROOM_NOTE_MAX_CHARACTERS,
  RoomNoteDialog,
  roomNoteCharacterCount,
  truncateRoomNote,
} from "../../src/spaces/RoomNoteDialog";

const roomNote: RoomNoteState = {
  type: "roomNoteState",
  zoneId: "meeting-a",
  revision: 4,
  body: "결정 사항",
  updatedAt: 1_700_000_000_000,
  updatedBy: "민지",
  meetingEndedAt: 1_700_000_000_000,
  retentionExpiresAt: 1_700_100_000_000,
  history: [
    {
      revision: 3,
      authorName: "도윤",
      editedAt: 1_699_999_000_000,
    },
  ],
};

function renderRoomNote(language: "ko" | "en", value: RoomNoteState | null) {
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
        createElement(RoomNoteDialog, {
          roomName: "회의실 A",
          roomNote: value,
          ack: null,
          connection: {} as never,
          online: value !== null,
          close: () => {},
        }),
      ),
    );
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

it("counts Unicode characters and truncates shared notes at 4,000 characters", () => {
  const mixed = `${"가".repeat(3999)}😀x`;

  expect(roomNoteCharacterCount(mixed)).toBe(4001);
  expect(roomNoteCharacterCount(truncateRoomNote(mixed))).toBe(
    ROOM_NOTE_MAX_CHARACTERS,
  );
  expect(truncateRoomNote(mixed).endsWith("😀")).toBe(true);
});

it("renders accessible shared notes, revision history, and dates in Korean", () => {
  const markup = renderRoomNote("ko", roomNote);

  expect(markup).toContain("회의실 A 공유 메모");
  expect(markup).toContain('aria-label="회의실 공유 메모"');
  expect(markup).toContain('aria-label="닫기"');
  expect(markup).toContain('aria-describedby="');
  expect(markup).toContain('role="status"');
  expect(markup).toContain("회의 메모");
  expect(markup).toContain("결정 사항");
  expect(markup).toContain("최근 변경 이력");
  expect(markup).toContain("회의 종료:");
  expect(markup).toContain("보존 기한:");
  expect(markup).toContain("2023. 11.");
  expect(markup).toContain("도윤");
  expect(markup).toContain("v4 · 민지");
});

it("renders shared notes, revision history, actions, and dates in English", () => {
  const markup = renderRoomNote("en", roomNote);

  expect(markup).toContain("Shared notes · 회의실 A");
  expect(markup).toContain('aria-label="Shared meeting room notes"');
  expect(markup).toContain('aria-label="Close"');
  expect(markup).toContain("Meeting notes");
  expect(markup).toContain("4,000 characters");
  expect(markup).toContain("Recent changes");
  expect(markup).toContain("Meeting ended:");
  expect(markup).toContain("Retention expires:");
  expect(markup).toContain("Nov");
  expect(markup).toContain("도윤");
  expect(markup).toContain("v4 · 민지");
  expect(markup).not.toContain("최근 변경 이력");
  expect(markup).not.toContain("회의 종료:");
});

it("shows localized reconnect status when notes are offline", () => {
  expect(renderRoomNote("ko", null)).toContain(
    "월드에 다시 연결되면 메모를 불러올게요.",
  );
  expect(renderRoomNote("en", null)).toContain(
    "Notes will load when you reconnect to the world.",
  );
});
