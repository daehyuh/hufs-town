import { describe, expect, it } from "vitest";
import {
  readRecentSpaceVisits,
  recordRecentSpaceVisit,
  writeRecentSpaceVisits,
} from "../../src/spaces/recentVisits";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

describe("account-scoped recent space visits", () => {
  it("moves a revisited space to the front and keeps account histories separate", () => {
    const storage = memoryStorage();
    recordRecentSpaceVisit("account-a", "space-one", 100, storage);
    recordRecentSpaceVisit("account-a", "space-two", 200, storage);
    recordRecentSpaceVisit("account-a", "space-one", 300, storage);
    recordRecentSpaceVisit("account-b", "space-three", 400, storage);

    expect(readRecentSpaceVisits("account-a", storage)).toEqual([
      { spaceId: "space-one", visitedAt: 300 },
      { spaceId: "space-two", visitedAt: 200 },
    ]);
    expect(readRecentSpaceVisits("account-b", storage)).toEqual([
      { spaceId: "space-three", visitedAt: 400 },
    ]);
  });

  it("drops malformed, duplicate, and excess history entries", () => {
    const storage = memoryStorage();
    writeRecentSpaceVisits(
      "account-a",
      [
        ...Array.from({ length: 10 }, (_, index) => ({
          spaceId: `space-${index}`,
          visitedAt: index + 1,
        })),
        { spaceId: "space-9", visitedAt: 99 },
        { spaceId: "<script>", visitedAt: 100 },
        { spaceId: "space-bad-time", visitedAt: Number.NaN },
      ],
      storage,
    );

    expect(readRecentSpaceVisits("account-a", storage)).toHaveLength(8);
    expect(readRecentSpaceVisits("account-a", storage)[0]).toEqual({
      spaceId: "space-9",
      visitedAt: 99,
    });
    expect(
      readRecentSpaceVisits("account-a", storage).some((visit) =>
        visit.spaceId.includes("<script>"),
      ),
    ).toBe(false);
  });
});
