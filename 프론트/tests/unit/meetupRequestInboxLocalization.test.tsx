import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LanguageProvider } from "../../src/i18n/language";
import { MeetupRequestInbox } from "../../src/social/MeetupRequestInbox";

function renderInbox(language: "ko" | "en") {
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
        createElement(MeetupRequestInbox, { onOpenDestination: () => false }),
      ),
    );
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

it("renders the meetup request inbox and loading state in Korean and English", () => {
  const korean = renderInbox("ko");
  const english = renderInbox("en");

  expect(korean).toContain('aria-label="만남 요청"');
  expect(korean).toContain("확인 중…");
  expect(korean).toContain(
    "공간 열기는 해당 공간의 공개 범위와 입장 승인 정책을 따라요.",
  );

  expect(english).toContain('aria-label="Meetup requests"');
  expect(english).toContain("Checking…");
  expect(english).toContain(
    "Opening a space follows its visibility and admission approval policy.",
  );
  expect(english).not.toContain("만남 요청");
  expect(english).not.toContain("확인 중");
});
