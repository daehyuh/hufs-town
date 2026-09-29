import { describe, expect, it } from "vitest";
import {
  keepEditedDraft,
  localizeUneditedChoices,
} from "../../src/events/draftDefaults";

describe("localized event draft defaults", () => {
  it("changes a default title with the locale but keeps an edited title", () => {
    expect(
      keepEditedDraft("전체 발표", "전체 발표", "Campus-wide presentation"),
    ).toBe("Campus-wide presentation");
    expect(
      keepEditedDraft("Team kickoff", "전체 발표", "Campus-wide presentation"),
    ).toBe("Team kickoff");
  });

  it("localizes untouched poll choices and preserves edited or added choices", () => {
    expect(
      localizeUneditedChoices(
        ["찬성", "반대", "More options"],
        ["찬성", "반대"],
        ["Agree", "Disagree"],
      ),
    ).toEqual(["Agree", "Disagree", "More options"]);
    expect(
      localizeUneditedChoices(
        ["Yes, absolutely", "반대"],
        ["찬성", "반대"],
        ["Agree", "Disagree"],
      ),
    ).toEqual(["Yes, absolutely", "Disagree"]);
  });
});
