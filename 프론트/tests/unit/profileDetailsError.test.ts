import { describe, expect, it } from "vitest";
import { profileDetailsErrorKey } from "../../src/social/profileDetailsError";

describe("profile details errors", () => {
  it("maps server profile codes to stable translation keys", () => {
    expect(profileDetailsErrorKey("PROFILE_STALE")).toBe(
      "people.profile.error.stale",
    );
    expect(profileDetailsErrorKey("PROFILE_COOLDOWN")).toBe(
      "people.profile.error.cooldown",
    );
    expect(profileDetailsErrorKey("PROFILE_UNAVAILABLE")).toBe(
      "people.profile.error.unavailable",
    );
    expect(profileDetailsErrorKey("PROFILE_BLOCKS_LOADING")).toBe(
      "people.profile.error.blocksLoading",
    );
    expect(profileDetailsErrorKey("PROFILE_BLOCKED")).toBe(
      "people.profile.error.blocked",
    );
  });

  it("uses a safe generic fallback for an unknown server code", () => {
    expect(profileDetailsErrorKey("FUTURE_PROFILE_CODE")).toBe(
      "people.profile.error",
    );
  });
});
