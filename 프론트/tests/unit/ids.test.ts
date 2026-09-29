import { expect, it } from "vitest";
import { createUuid } from "../../src/ids";

it("uses the native UUID generator when available", () => {
  expect(createUuid({ randomUUID: () => "native-uuid" })).toBe("native-uuid");
});

it("creates an RFC 4122 v4 ID from random bytes without randomUUID", () => {
  const id = createUuid({
    getRandomValues: (bytes) => {
      bytes.fill(0x0f);
      return bytes;
    },
  });

  expect(id).toBe("0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f");
});

it("still returns a valid v4 ID when Web Crypto is unavailable", () => {
  expect(createUuid({})).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
