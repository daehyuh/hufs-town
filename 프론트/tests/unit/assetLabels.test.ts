import { describe, expect, it } from "vitest";
import { OFFICE_ASSETS } from "../../src/game/officeAssets";
import { translate } from "../../src/i18n/language";
import {
  builtInAssetNameKeys,
  localizedAssetName,
} from "../../src/editor/assetLabels";

describe("built-in map asset labels", () => {
  it("provides Korean and English labels for every catalog asset", () => {
    expect(OFFICE_ASSETS).toHaveLength(32);

    for (const asset of OFFICE_ASSETS) {
      const key = builtInAssetNameKeys[asset.id];
      expect(key, `Missing translation key for ${asset.id}`).toBeDefined();
      expect(
        localizedAssetName(asset.id, asset.name, (entry) =>
          translate("ko", entry),
        ),
      ).toBe(asset.name);
      expect(
        localizedAssetName(asset.id, asset.name, (entry) =>
          translate("en", entry),
        ),
      ).not.toBe(asset.name);
    }
  });

  it("keeps uploader-provided names unchanged", () => {
    expect(
      localizedAssetName("custom_uploaded_asset", "사용자 소파", (key) =>
        translate("en", key),
      ),
    ).toBe("사용자 소파");
  });
});
