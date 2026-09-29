import { expect, it } from "vitest";
import { eventActionMessageKey } from "../../src/events/eventActionMessage";

it("maps presentation actions and server errors to localized resource keys", () => {
  expect(
    eventActionMessageKey({ accepted: true, action: "RAISE_HAND", code: "" }),
  ).toBe("events.action.success.handRaised");
  expect(
    eventActionMessageKey({
      accepted: false,
      action: "GRANT_SPEAKER",
      code: "EVENT_SPEAKER_LIMIT",
    }),
  ).toBe("events.action.error.speakerLimit");
  expect(
    eventActionMessageKey({ accepted: false, action: "UNKNOWN", code: "" }),
  ).toBe("events.action.error.generic");
});
