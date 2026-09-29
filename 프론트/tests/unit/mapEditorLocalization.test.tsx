import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LanguageProvider, translate } from "../../src/i18n/language";
import { DialogActionsProvider } from "../../src/components/DialogActions";
import { MapEditor } from "../../src/editor/MapEditor";
import {
  EditorCanvas,
  type EditorOptions,
} from "../../src/editor/EditorCanvas";
import type { MapDefinition } from "../../src/generated/protocol";
import type { Space } from "../../src/spaces/client";

const map: MapDefinition = {
  schemaVersion: 2,
  id: "map",
  revision: "revision",
  name: "Map",
  width: 8,
  height: 8,
  spawnX: 2,
  spawnY: 2,
  collisions: [],
  objects: [],
  zones: [],
  floors: [],
  walls: [],
  labels: [],
  portals: [],
};
const options: EditorOptions = {
  tool: "select",
  asset: "desk-monitor",
  direction: "down",
  floor: "OAK",
  wall: "CREAM",
  zoom: 1,
  grid: true,
  snapToGrid: true,
  collisions: false,
  zones: false,
  lockedLayers: {
    objects: false,
    floors: false,
    walls: false,
    zones: false,
    labels: false,
    portals: false,
  },
};

function renderMapEditor(language: "ko" | "en") {
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
          createElement(MapEditor, {
            space: { id: "space", name: "Test Space" } as Space,
            user: "user",
            close: () => undefined,
          }),
        ),
      ),
    );
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

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
        createElement(EditorCanvas, {
          map,
          options,
          selected: [],
          select: () => undefined,
          edit: () => undefined,
          writable: true,
          assetRevision: 0,
          onError: () => undefined,
        }),
      ),
    );
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

it("renders the map editor toolbar and catalog in Korean and English", () => {
  const korean = renderMapEditor("ko");
  const english = renderMapEditor("en");

  expect(korean).toContain('aria-label="맵 편집 도구"');
  expect(korean).toContain('aria-label="선택 도구"');
  expect(korean).toContain("공간 지도");
  expect(korean).toContain("HUFS TOWN · 맵 편집기");
  expect(korean).toContain("나만의 공간 만들기");
  expect(korean).toContain("맵 파일 내보내기");
  expect(korean).toContain('title="격자 표시"');
  expect(korean).toContain("속성");

  expect(english).toContain('aria-label="Map editing tools"');
  expect(english).toContain('aria-label="Select tool"');
  expect(english).toContain("Space maps");
  expect(english).toContain("HUFS TOWN · MAP MAKER");
  expect(english).toContain("Build your space");
  expect(english).toContain("Search furniture");
  expect(english).toContain("Export map file");
  expect(english).toContain("Import JSON");
  expect(english).toContain("Show grid");
  expect(english).toContain("Collisions");
  expect(english).toContain("Properties");
  expect(english).not.toContain("맵 편집 도구");
  expect(english).not.toContain("공간 지도");
  expect(english).not.toContain("맵 파일 내보내기");
  expect(english).not.toContain("그리드 표시");
});

it("localizes canvas instructions and the detailed editor vocabulary", () => {
  const korean = renderCanvas("ko");
  const english = renderCanvas("en");

  expect(korean).toContain('aria-label="맵 편집 캔버스"');
  expect(korean).toContain("맵 항목 목록에서 항목을 선택할 수 있습니다.");
  expect(english).toContain('aria-label="Map editing canvas"');
  expect(english).toContain("Select items from the map item list.");
  expect(english).not.toMatch(/[가-힣]/);

  expect(translate("ko", "editor.inspector.field.interaction")).toBe(
    "클릭 상호작용",
  );
  expect(translate("en", "editor.inspector.field.interaction")).toBe(
    "Click interaction",
  );
  expect(translate("en", "editor.inspector.help.zonePrivate")).toContain(
    "host manages capacity",
  );
  expect(translate("en", "editor.history.title")).toBe("Publish history");
  expect(translate("en", "editor.dialog.restoreConfirm")).not.toMatch(
    /[가-힣]/,
  );
});
