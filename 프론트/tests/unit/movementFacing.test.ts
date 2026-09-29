import { describe, expect, it } from "vitest";
import { movementFacingDirection } from "../../src/game/movement";

describe("four-way avatar facing", () => {
  it("faces the dominant axis when a diagonal vector is clearly off-center", () => {
    expect(movementFacingDirection(1, 0.45, "down")).toBe("right");
    expect(movementFacingDirection(-0.4, -1, "right")).toBe("up");
  });

  it("holds its facing through small changes around a diagonal", () => {
    expect(movementFacingDirection(0.95, 0.8, "down")).toBe("down");
    expect(movementFacingDirection(0.95, 0.8, "right")).toBe("right");
    expect(movementFacingDirection(0.99, 0.8, "down")).toBe("right");
  });

  it("turns immediately when movement reverses or stops", () => {
    expect(movementFacingDirection(-1, 0, "right")).toBe("left");
    expect(movementFacingDirection(0, 0, "up")).toBe("up");
  });
});
