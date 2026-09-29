import { describe, expect, it } from "vitest";
import { proximityAudioVolume } from "../../src/media/proximityAudio";

describe("proximity audio volume", () => {
  const enter = 4;
  const exit = 8;
  const near = enter * 0.15;

  it("keeps nearby audio full and smoothly attenuates toward the exit radius", () => {
    expect(proximityAudioVolume(near, enter, exit)).toBe(1);
    expect(proximityAudioVolume((near + exit) / 2, enter, exit)).toBeCloseTo(
      0.56,
      8,
    );
    expect(proximityAudioVolume(exit, enter, exit)).toBeCloseTo(0.12, 8);
    expect(proximityAudioVolume(exit + 10, enter, exit)).toBeCloseTo(0.12, 8);
  });

  it("keeps private-room audio at a constant level", () => {
    expect(proximityAudioVolume(1000, enter, exit, true)).toBe(1);
  });

  it("uses full volume when distance policy values are invalid", () => {
    expect(proximityAudioVolume(Number.NaN, enter, exit)).toBe(1);
    expect(proximityAudioVolume(3, Number.NaN, exit)).toBe(1);
    expect(proximityAudioVolume(3, enter, Number.NaN)).toBe(1);
    expect(proximityAudioVolume(3, enter, near)).toBe(1);
  });
});
