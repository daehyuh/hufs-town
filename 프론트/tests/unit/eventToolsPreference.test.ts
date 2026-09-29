import { describe, expect, it } from "vitest";
import {
  EVENT_TOOLS_STORAGE_KEY,
  readEventToolsEnabled,
  writeEventToolsEnabled,
} from "../../src/events/eventToolsPreference";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    has: (key: string) => values.has(key),
  };
}

describe("presenter tools preference", () => {
  it("resets every previous opt-in so presenter tools start hidden after an update", () => {
    const storage = memoryStorage({
      "hufs-town.event-tools": "true",
      "hufs-town.event-tools.v2": "true",
      "hufs-town.event-tools.v3": "true",
      "hufs-town.event-tools.v4": "true",
      "hufs-town.event-tools.v5": "true",
      "hufs-town.event-tools.v6": "true",
      "hufs-town.event-tools.v7": "true",
      "hufs-town.event-tools.v8": "true",
      "hufs-town.event-tools.v9": "true",
      "hufs-town.event-tools.v10": "true",
    });

    expect(readEventToolsEnabled(storage)).toBe(false);
    expect(storage.has("hufs-town.event-tools.v4")).toBe(false);
    expect(storage.has("hufs-town.event-tools.v5")).toBe(false);
    expect(storage.has("hufs-town.event-tools.v6")).toBe(false);
    expect(storage.has("hufs-town.event-tools.v7")).toBe(false);
    expect(storage.has("hufs-town.event-tools.v8")).toBe(false);
    expect(storage.has("hufs-town.event-tools.v9")).toBe(false);
    expect(storage.has("hufs-town.event-tools.v10")).toBe(false);
  });

  it("remembers an explicit choice made in the current settings version", () => {
    const storage = memoryStorage();

    writeEventToolsEnabled(true, storage);

    expect(storage.getItem(EVENT_TOOLS_STORAGE_KEY)).toBe("true");
    expect(readEventToolsEnabled(storage)).toBe(true);
  });
});
