import type { PlayerView } from "../generated/protocol";

type PokePosition = Pick<PlayerView, "id" | "x" | "y" | "zoneId" | "direction">;

const facingVector: Record<
  PokePosition["direction"],
  { x: number; y: number }
> = {
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
};

export function findPokeTarget(
  self: PokePosition,
  players: readonly PokePosition[],
  maxDistance = 3,
) {
  const facing = facingVector[self.direction];
  return players
    .filter((player) => player.id !== self.id && player.zoneId === self.zoneId)
    .map((player) => {
      const dx = player.x - self.x;
      const dy = player.y - self.y;
      const forwardDistance = dx * facing.x + dy * facing.y;
      const sideDistance = Math.abs(dx * facing.y - dy * facing.x);
      const distance = Math.hypot(dx, dy);
      return { player, forwardDistance, sideDistance, distance };
    })
    .filter(
      ({ forwardDistance, sideDistance, distance }) =>
        forwardDistance > 0 &&
        distance <= maxDistance &&
        sideDistance <= forwardDistance + 0.25,
    )
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        a.sideDistance - b.sideDistance ||
        a.player.id.localeCompare(b.player.id),
    )[0]?.player;
}
