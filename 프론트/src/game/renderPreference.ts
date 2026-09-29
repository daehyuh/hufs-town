export type WorldRenderMode = "standard" | "low-spec";

export const WORLD_RENDER_MODE_STORAGE_KEY = "hufs-town.render-mode";
export const LOW_SPEC_WORLD_FPS_LIMIT = 30;

export function readWorldRenderMode(
  storage?: Pick<Storage, "getItem">,
): WorldRenderMode {
  try {
    return (storage ?? globalThis.localStorage).getItem(
      WORLD_RENDER_MODE_STORAGE_KEY,
    ) === "low-spec"
      ? "low-spec"
      : "standard";
  } catch {
    return "standard";
  }
}

export function writeWorldRenderMode(
  mode: WorldRenderMode,
  storage?: Pick<Storage, "setItem">,
) {
  try {
    (storage ?? globalThis.localStorage).setItem(
      WORLD_RENDER_MODE_STORAGE_KEY,
      mode,
    );
  } catch {
    // The current session still uses the selected mode if storage is unavailable.
  }
}

export function worldFpsLimit(mode: WorldRenderMode) {
  return mode === "low-spec" ? LOW_SPEC_WORLD_FPS_LIMIT : 0;
}
