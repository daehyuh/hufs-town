import { describe, expect, it } from "vitest";
import { AvatarTextureReferences } from "../../src/game/avatarTextureReferences";

describe("avatar texture references", () => {
  it("keeps shared parts until the last avatar releases them", () => {
    const references = new AvatarTextureReferences();
    expect(references.sync("a", ["body", "coat-a", "hair"]).acquired).toEqual([
      "body",
      "coat-a",
      "hair",
    ]);
    expect(references.sync("b", ["body", "coat-b", "hair"]).acquired).toEqual([
      "body",
      "coat-b",
      "hair",
    ]);

    const changed = references.sync("a", ["body", "coat-c", "hair"]);
    expect(changed).toEqual({ acquired: ["coat-c"], released: ["coat-a"] });
    expect(references.removePlayer("a").released).toEqual(["coat-c"]);
    expect(references.hasUsers("body")).toBe(true);
    expect(references.hasUsers("hair")).toBe(true);
    expect(references.removePlayer("b").released.sort()).toEqual(
      ["body", "coat-b", "hair"].sort(),
    );
    expect(references.activeTextureCount).toBe(0);
  });

  it("bounds retained cache keys to current players, even across long churn", () => {
    const references = new AvatarTextureReferences();
    const playerIds = Array.from(
      { length: 500 },
      (_, index) => `player-${index}`,
    );
    for (const [index, id] of playerIds.entries())
      references.sync(id, [
        "body-average-light",
        `clothing-${index}`,
        "hair-short",
      ]);

    expect(references.activeTextureCount).toBe(502);
    const released = new Set<string>();
    for (const id of playerIds)
      references.removePlayer(id).released.forEach((key) => released.add(key));

    expect(references.activeTextureCount).toBe(0);
    expect(released.size).toBe(502);
    expect(references.hasUsers("body-average-light")).toBe(false);
  });

  it("releases every active key during scene teardown", () => {
    const references = new AvatarTextureReferences();
    references.sync("a", ["body", "coat"]);
    references.sync("b", ["body", "hair"]);

    expect(references.releaseAll().sort()).toEqual(
      ["body", "coat", "hair"].sort(),
    );
    expect(references.activeTextureCount).toBe(0);
  });
});
