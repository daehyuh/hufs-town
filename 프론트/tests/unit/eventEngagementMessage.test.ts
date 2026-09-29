import { expect, it } from "vitest";
import { eventEngagementMessageKey } from "../../src/events/eventEngagementMessage";

it("maps event engagement acknowledgements to safe localized keys", () => {
  expect(
    eventEngagementMessageKey({
      accepted: false,
      action: "COLLECT_SCAVENGER_ITEM",
      code: "SCAVENGER_TOO_FAR",
    }),
  ).toBe("events.engagement.error.tooFar");
  expect(
    eventEngagementMessageKey({
      accepted: true,
      action: "ASK_QUESTION",
      code: "",
    }),
  ).toBe("events.engagement.success.questionAsked");
  expect(
    eventEngagementMessageKey({ accepted: false, action: "UNKNOWN", code: "" }),
  ).toBe("events.engagement.error.generic");
});
