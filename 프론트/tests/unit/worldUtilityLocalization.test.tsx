import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { MapDefinition, PlayerView } from "../../src/generated/protocol";
import { LanguageProvider } from "../../src/i18n/language";
import { DialogActionsProvider } from "../../src/components/DialogActions";
import { MiniMapPanel } from "../../src/game/MiniMapPanel";
import { MobileMovementPad } from "../../src/game/MobileMovementPad";
import { SharedWhiteboard } from "../../src/spaces/SharedWhiteboard";

const map = {
  schemaVersion: 2,
  id: "test-map",
  revision: "1",
  name: "Test map",
  width: 10,
  height: 10,
  spawnX: 1,
  spawnY: 1,
  collisions: [],
  objects: [],
  zones: [
    {
      id: "public",
      name: "Lounge",
      kind: "PUBLIC",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    },
  ],
  floors: [],
  walls: [],
  labels: [],
} as unknown as MapDefinition;

function renderUtilities(language: "ko" | "en") {
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
        createElement(
          DialogActionsProvider,
          null,
          createElement(
            Fragment,
            null,
            createElement(MobileMovementPad, {
              sceneRef: { current: null },
            }),
            createElement(MiniMapPanel, {
              map,
              players: [
                {
                  id: "self",
                  name: "Alex",
                  x: 1.2,
                  y: 2.4,
                  zoneId: "public",
                } as PlayerView,
              ],
              selfId: "self",
              selfZoneId: "public",
              rooms: [],
              onFocus: () => undefined,
            }),
            createElement(SharedWhiteboard, {
              spaceId: "space",
              boardId: "board",
            }),
          ),
        ),
      ),
    );
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

it("renders world utility controls in Korean and English", () => {
  const korean = renderUtilities("ko");
  const english = renderUtilities("en");

  expect(korean).toContain('aria-label="이동 조이스틱"');
  expect(korean).toContain('aria-describedby="mobile-joystick-status"');
  expect(korean).toContain('aria-live="polite">걷기</span>');
  expect(korean).toContain("달리기");
  expect(korean).toContain("지도 범례");
  expect(korean).toContain("공동 화이트보드");
  expect(korean).toContain("처음 그리면 공간 참가자에게 함께 보여요.");

  expect(english).toContain('aria-label="Movement joystick"');
  expect(english).toContain('aria-describedby="mobile-joystick-status"');
  expect(english).toContain('aria-live="polite">Walk</span>');
  expect(english).toContain("Run");
  expect(english).toContain("Map legend");
  expect(english).toContain("Shared whiteboard");
  expect(english).toContain(
    "Your first drawing will be shared with everyone in this space.",
  );
  expect(english).not.toContain("터치 이동 조작");
  expect(english).not.toContain("지도 범례");
  expect(english).not.toContain("공동 화이트보드");
});
