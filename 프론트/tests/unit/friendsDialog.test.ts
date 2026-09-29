import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LanguageProvider } from "../../src/i18n/language";
import { FriendsDialog } from "../../src/social/FriendsDialog";

function renderFriends(language: "ko" | "en") {
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
        createElement(FriendsDialog, { close: () => {}, onChanged: () => {} }),
      ),
    );
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

it("renders friend management labels and accessibility text in Korean", () => {
  const markup = renderFriends("ko");

  expect(markup).toContain('aria-label="친구 관리"');
  expect(markup).toContain('aria-label="닫기"');
  expect(markup).toContain("친구 요청 받기");
  expect(markup).toContain("친구 찾기");
  expect(markup).toContain("친구 정보를 불러오는 중…");
});

it("renders friend management labels and accessibility text in English", () => {
  const markup = renderFriends("en");

  expect(markup).toContain('aria-label="Manage friends"');
  expect(markup).toContain('aria-label="Close"');
  expect(markup).toContain("Allow friend requests");
  expect(markup).toContain("Find friends");
  expect(markup).toContain("Loading friends…");
  expect(markup).not.toContain("친구 요청 받기");
});
