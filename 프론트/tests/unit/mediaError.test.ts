import { describe, expect, it } from "vitest";
import { MediaError } from "../../src/game/WorldConnection";
import { translate } from "../../src/i18n/language";
import {
  mediaErrorMessage,
  mediaErrorTranslationKey,
} from "../../src/media/mediaError";

describe("media error translations", () => {
  it("maps server media and moderation codes to stable localized resources", () => {
    const cases = [
      ["MEDIA_BLOCKED", "media.error.blocked"],
      ["MEDIA_BUSY", "media.error.busy"],
      ["MEDIA_DENIED", "media.error.denied"],
      ["MEDIA_DISABLED", "media.error.disabled"],
      ["MEDIA_INVALID", "media.error.generic"],
      ["MEDIA_MODERATION_LOADING", "media.error.moderationLoading"],
      ["MEDIA_PRESENCE", "media.error.presence"],
      ["MEDIA_STALE", "media.error.stale"],
      ["MEDIA_TIMEOUT", "media.error.timeout"],
      ["MEDIA_UNAVAILABLE", "media.error.unavailable"],
    ] as const;

    for (const [code, expectedKey] of cases) {
      const key = mediaErrorTranslationKey(
        new MediaError(code, "한국어 서버 문구"),
      );
      expect(key).toBe(expectedKey);
      expect(translate("en", key)).not.toContain("한국어");
    }
    expect(
      translate(
        "en",
        mediaErrorTranslationKey(
          new MediaError("MEDIA_PRESENCE", "한국어 서버 문구"),
        ),
      ),
    ).toBe("Set your status to Available to use nearby calls.");
  });

  it("uses a localized generic message for unknown errors", () => {
    const key = mediaErrorTranslationKey(new Error("raw server detail"));

    expect(translate("en", key)).toBe(
      "Could not complete the call request. Please try again.",
    );
  });

  it("maps browser permission errors without exposing browser text", () => {
    const key = mediaErrorTranslationKey(
      new DOMException("Not allowed", "NotAllowedError"),
    );

    expect(translate("en", key)).toContain("Permission was denied");
  });

  it("uses the localized controller key instead of stale Korean detail", () => {
    const message = mediaErrorMessage(
      "장치 권한이 허용되지 않았어요.",
      "media.error.denied",
      (key) => translate("en", key),
    );

    expect(message).toBe(translate("en", "media.error.denied"));
    expect(message).not.toContain("장치 권한");
    expect(
      mediaErrorMessage("A low-level detail", undefined, (key) =>
        translate("en", key),
      ),
    ).toBe("A low-level detail");
  });

  it("uses a screen-specific message for denied screen sharing", () => {
    const key = mediaErrorTranslationKey(
      new DOMException("Not allowed", "NotAllowedError"),
      "screen",
    );

    expect(translate("en", key)).toContain("Screen sharing permission");
  });
});
