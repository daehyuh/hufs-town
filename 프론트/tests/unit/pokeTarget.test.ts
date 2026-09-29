import { describe, expect, it } from "vitest";
import { findPokeTarget } from "../../src/game/pokeTarget";

const player = (
  id: string,
  x: number,
  y: number,
  direction: "up" | "down" | "left" | "right" = "down",
  zoneId = "lounge",
) => ({ id, x, y, direction, zoneId });

describe("findPokeTarget", () => {
  it("chooses the nearest person in front within the same zone", () => {
    const self = player("self", 5, 5);
    const target = findPokeTarget(self, [
      self,
      player("behind", 5, 4),
      player("nearby", 5.3, 6.2),
      player("farther", 5, 7.5),
      player("other-zone", 5, 5.5, "down", "meeting-room"),
    ]);

    expect(target?.id).toBe("nearby");
  });

  it("uses the facing direction and ignores people outside the forward cone", () => {
    const self = player("self", 5, 5, "left");
    const target = findPokeTarget(self, [
      self,
      player("ahead", 3, 5),
      player("right", 6, 5),
      player("too-wide", 4, 2),
    ]);

    expect(target?.id).toBe("ahead");
  });

  it("does not select a target outside the server poke range", () => {
    const self = player("self", 5, 5);

    expect(findPokeTarget(self, [self, player("far", 5, 8.1)])).toBeUndefined();
  });
});
