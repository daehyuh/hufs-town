import { describe, expect, it } from "vitest";
import { completeModeratedSources } from "../../src/media/moderatedSources";

describe("moderated media sources", () => {
  it("treats screen video and its shared audio as one restricted source", () => {
    expect(completeModeratedSources(["SCREEN"])).toEqual([
      "SCREEN",
      "SCREEN_AUDIO",
    ]);
    expect(completeModeratedSources(["SCREEN_AUDIO"])).toEqual([
      "SCREEN",
      "SCREEN_AUDIO",
    ]);
  });

  it("keeps unrelated microphone and camera restrictions independent", () => {
    expect(completeModeratedSources(["CAMERA", "MICROPHONE"])).toEqual([
      "CAMERA",
      "MICROPHONE",
    ]);
  });
});
