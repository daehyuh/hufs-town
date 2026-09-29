import { expect, it } from "vitest";
import { avatarFrame } from "../../src/game/avatarFrames";
it("uses the source artwork's front / left / right / back rows", () => {
  expect(["down", "left", "right", "up"].map(d => avatarFrame(d as "down", 0, false))).toEqual([1, 4, 7, 10]);
});
it("returns to a neutral pose and preserves both alternating footsteps in each direction", () => {
  for (const direction of ["down", "left", "right", "up"] as const) {
    const idle = avatarFrame(direction, 0, false);
    expect([0, 140, 280, 420].map(t => avatarFrame(direction, t, true))).toEqual([idle, idle + 1, idle, idle - 1]);
    expect(avatarFrame(direction, 1234, false)).toBe(idle);
  }
});
