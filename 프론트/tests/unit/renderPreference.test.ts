import { describe, expect, it } from "vitest";
import {
  readWorldRenderMode,
  WORLD_RENDER_MODE_STORAGE_KEY,
  worldFpsLimit,
  writeWorldRenderMode,
} from "../../src/game/renderPreference";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("world render preference", () => {
  it("uses standard rendering for a missing or unknown saved mode", () => {
    expect(readWorldRenderMode(memoryStorage())).toBe("standard");
    expect(
      readWorldRenderMode(
        memoryStorage({ [WORLD_RENDER_MODE_STORAGE_KEY]: "invalid" }),
      ),
    ).toBe("standard");
  });

  it("persists the selected mode and limits low-spec rendering to 30 fps", () => {
    const storage = memoryStorage();

    writeWorldRenderMode("low-spec", storage);

    expect(readWorldRenderMode(storage)).toBe("low-spec");
    expect(worldFpsLimit("low-spec")).toBe(30);
    expect(worldFpsLimit("standard")).toBe(0);
  });
});
