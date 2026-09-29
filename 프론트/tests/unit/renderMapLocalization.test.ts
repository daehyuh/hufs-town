import { expect, it, vi } from "vitest";
import type { MapDefinition } from "../../src/generated/protocol";
import { translate } from "../../src/i18n/language";
import { paintStageZones } from "../../src/game/renderMap";

const map = {
  width: 20,
  height: 12,
  zones: [
    {
      id: "stage",
      name: "Meetup stage",
      kind: "STAGE",
      bounds: { x: 3, y: 2, width: 6, height: 4 },
    },
  ],
} as unknown as MapDefinition;

function paint(language: "ko" | "en") {
  const fillText = vi.fn();
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    setLineDash: vi.fn(),
    measureText: vi.fn(() => ({ width: 100 })),
    fillText,
  } as unknown as CanvasRenderingContext2D;

  paintStageZones(
    context,
    map,
    translate(language, "editor.inspector.kind.stage"),
  );
  return fillText.mock.calls[0]?.[0];
}

it("renders the stage marker in the selected language", () => {
  expect(paint("ko")).toBe("▶ Meetup stage · 발표 무대");
  expect(paint("en")).toBe("▶ Meetup stage · Presentation stage");
});
