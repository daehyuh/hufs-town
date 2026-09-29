import type { PlayerView } from "../generated/protocol";

// Verified against all three original 48×64 body/clothing/hair sheets.
export const AVATAR_ROWS = { down: 0, left: 1, right: 2, up: 3 } as const;
export function avatarFrame(
  direction: PlayerView["direction"],
  elapsed: number,
  moving: boolean,
  running = false,
) {
  const column = moving
    ? [1, 2, 1, 0][Math.floor(elapsed / (running ? 85 : 140)) % 4]
    : 1;
  return AVATAR_ROWS[direction] * 3 + column;
}
