export const EVENT_TOOLS_STORAGE_KEY = "hufs-town.event-tools.v11";

const LEGACY_EVENT_TOOLS_STORAGE_KEYS = [
  "hufs-town.event-tools",
  "hufs-town.event-tools.v2",
  "hufs-town.event-tools.v3",
  "hufs-town.event-tools.v4",
  "hufs-town.event-tools.v5",
  "hufs-town.event-tools.v6",
  "hufs-town.event-tools.v7",
  "hufs-town.event-tools.v8",
  "hufs-town.event-tools.v9",
  "hufs-town.event-tools.v10",
] as const;

export type EventToolsStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export function readEventToolsEnabled(storage: EventToolsStorage): boolean {
  try {
    for (const key of LEGACY_EVENT_TOOLS_STORAGE_KEYS) {
      storage.removeItem(key);
    }
    return storage.getItem(EVENT_TOOLS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeEventToolsEnabled(
  enabled: boolean,
  storage: EventToolsStorage,
): void {
  storage.setItem(EVENT_TOOLS_STORAGE_KEY, String(enabled));
}
