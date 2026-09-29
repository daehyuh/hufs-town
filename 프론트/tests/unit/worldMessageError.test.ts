import { expect, it } from "vitest";
import { translate } from "../../src/i18n/language";
import { worldMessageErrorKey } from "../../src/social/worldMessageError";

it("maps World DM and group acknowledgement codes to localized resources", () => {
  expect(worldMessageErrorKey("DM_TARGET_UNAVAILABLE")).toBe(
    "chat.error.targetUnavailable",
  );
  expect(worldMessageErrorKey("GROUP_FULL")).toBe("group.error.full");
  expect(worldMessageErrorKey("DM_EDIT_EXPIRED")).toBe(
    "chat.message.editExpired",
  );
  expect(worldMessageErrorKey("UNKNOWN_DM_CODE")).toBe("chat.error.generic");
  expect(worldMessageErrorKey("GROUP_UNKNOWN_CODE")).toBe(
    "group.error.generic",
  );
  for (const code of [
    "DM_TARGET_UNAVAILABLE",
    "GROUP_FULL",
    "DM_EDIT_EXPIRED",
  ]) {
    expect(translate("en", worldMessageErrorKey(code))).not.toMatch(/[가-힣]/);
  }
});
