import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { MapDefinition } from "../../src/generated/protocol";
import { LanguageProvider, translate } from "../../src/i18n/language";
import { WorldCanvas } from "../../src/game/WorldCanvas";

const map = {
  name: "Test map",
} as MapDefinition;

function renderCanvas(language: "ko" | "en") {
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
        createElement(WorldCanvas, {
          map,
          connection: {} as never,
          sceneRef: { current: null },
          renderMode: "standard",
        }),
      ),
    );
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

it("labels the world canvas in the selected language", () => {
  const korean = renderCanvas("ko");
  const english = renderCanvas("en");

  expect(korean).toContain('aria-label="Test map 가상 공간"');
  expect(english).toContain('aria-label="Test map virtual space"');
  expect(english).not.toContain("가상 공간");
});

it("localizes world asset and connection errors", () => {
  expect(translate("ko", "world.canvas.error.asset", { name: "큰 나무" })).toBe(
    "큰 나무 에셋을 불러오지 못했어요.",
  );
  expect(
    translate("en", "world.canvas.error.asset", { name: "Large tree" }),
  ).toBe("Could not load the Large tree asset.");
  expect(translate("en", "world.canvas.error.network")).toBe(
    "Check your network connection and try again.",
  );
});
