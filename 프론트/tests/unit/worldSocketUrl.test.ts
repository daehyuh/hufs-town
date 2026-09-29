import { describe, expect, it } from "vitest";
import { resolveWorldSocketUrl } from "../../src/game/worldSocketUrl";

describe("resolveWorldSocketUrl", () => {
  it("routes loopback World endpoints through a remote page's same-origin proxy", () => {
    expect(
      resolveWorldSocketUrl(
        "ws://localhost:18091/world/socket",
        "/world/socket",
        "http://100.87.52.42:5173/",
      ),
    ).toBe("ws://100.87.52.42:5173/world/socket");
  });

  it("uses secure WebSocket when the remote page is HTTPS", () => {
    expect(
      resolveWorldSocketUrl(
        "ws://127.0.0.1:18091/world/socket?region=campus",
        "/world/socket",
        "https://jjoayong.tail55aac.ts.net/",
      ),
    ).toBe("wss://jjoayong.tail55aac.ts.net/world/socket?region=campus");
  });

  it("preserves configured non-loopback World endpoints", () => {
    expect(
      resolveWorldSocketUrl(
        "wss://world.example.test/world/socket",
        "/world/socket",
        "https://town.example.test/",
      ),
    ).toBe("wss://world.example.test/world/socket");
  });

  it("preserves local development endpoints and builds a same-origin fallback", () => {
    expect(
      resolveWorldSocketUrl(
        "ws://localhost:18091/world/socket",
        "/world/socket",
        "http://localhost:5173/",
      ),
    ).toBe("ws://localhost:18091/world/socket");
    expect(
      resolveWorldSocketUrl(
        undefined,
        "/world/socket",
        "http://localhost:5173/",
      ),
    ).toBe("ws://localhost:5173/world/socket");
  });
});
