import { createHmac } from "node:crypto";
import { test, expect, type Browser, type Page } from "@playwright/test";

test.skip(
  process.env.TOWN_E2E_LIVEKIT !== "true",
  "Run backend scripts/livekit-spike.ps1 to start the isolated candidate server.",
);

const roomName = "hufs-town-candidate-spike";
const apiKey = process.env.TOWN_LIVEKIT_SPIKE_KEY ?? "";
const apiSecret = process.env.TOWN_LIVEKIT_SPIKE_SECRET ?? "";
const livekitUrl = process.env.TOWN_LIVEKIT_SPIKE_URL ?? "";

function token(identity: string, sources: string[]) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: apiKey,
      sub: identity,
      iat: now,
      nbf: now - 5,
      exp: now + 300,
      video: {
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishSources: sources,
      },
    }),
  ).toString("base64url");
  const body = `${header}.${claims}`;
  const signature = createHmac("sha256", apiSecret)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

async function join(
  browser: Browser,
  identity: string,
  role: "full" | "microphone-only",
  share = false,
) {
  const context = await browser.newContext({
    permissions: ["camera", "microphone"],
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const nativePeerConnection = window.RTCPeerConnection;
    const peerConnections: RTCPeerConnection[] = [];
    (window as any).RTCPeerConnection = class extends nativePeerConnection {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        peerConnections.push(this);
      }
    };
    (window as any).__livekitPeerConnections = peerConnections;
  });
  await page.goto("/tests/fixtures/livekit-spike.html");
  await page.evaluate(
    ({ url, accessToken, identity, role, share }) => {
      (window as any).livekitSpikeConfig = {
        url,
        token: accessToken,
        identity,
        role,
        share,
      };
    },
    {
      url: livekitUrl,
      accessToken: token(
        identity,
        role === "full"
          ? ["microphone", "camera", "screen_share", "screen_share_audio"]
          : ["microphone"],
      ),
      identity,
      role,
      share,
    },
  );
  await page.getByRole("button", { name: "Join test room" }).click();
  await expect(page.locator("#status")).toHaveText("connected", {
    timeout: 15_000,
  });
  await page.waitForTimeout(1500);
  const diagnostic = await page.evaluate(() => {
    const state = (window as any).livekitSpikeState;
    return {
      ready: state.mediaReady,
      error: state.publishError,
      progress: state.progress,
    };
  });
  expect(diagnostic.ready, JSON.stringify(diagnostic)).toBe(true);
  return { context, page };
}

async function subscriptions(page: Page) {
  return page.evaluate(() => (window as any).livekitSpikeState.subscriptions);
}

async function sources(page: Page) {
  return page.evaluate(() => (window as any).livekitSpikeState.localSources);
}

async function hasInboundMedia(page: Page) {
  return page.evaluate(async () => {
    const peerConnections = (window as any)
      .__livekitPeerConnections as RTCPeerConnection[];
    const reports = await Promise.all(
      peerConnections.map(async (peerConnection) => [
        ...(await peerConnection.getStats()).values(),
      ]),
    );
    const inbound = reports
      .flat()
      .filter((entry) => entry.type === "inbound-rtp");
    const audioBytes = inbound
      .filter((entry) => entry.kind === "audio" || entry.mediaType === "audio")
      .reduce((total, entry) => total + (entry.bytesReceived ?? 0), 0);
    const videoFrames = inbound
      .filter((entry) => entry.kind === "video" || entry.mediaType === "video")
      .reduce((total, entry) => total + (entry.framesDecoded ?? 0), 0);
    return audioBytes > 0 && videoFrames > 0;
  });
}

test("three participants exchange camera/mic and screen media; source grants reject camera", async ({
  browser,
}) => {
  test.skip(
    !apiKey || !apiSecret || !livekitUrl,
    "The isolated candidate server settings are missing.",
  );
  const participants: Array<{
    context: Awaited<ReturnType<Browser["newContext"]>>;
    page: Page;
  }> = [];
  try {
    const alice = await join(browser, "spike-alice", "full", true);
    participants.push(alice);
    const bob = await join(browser, "spike-bob", "full");
    participants.push(bob);
    const carol = await join(browser, "spike-carol", "full");
    participants.push(carol);

    for (const page of [alice.page, bob.page, carol.page]) {
      const local = await page.evaluate(() => {
        const state = (window as any).livekitSpikeState;
        return { sources: state.localSources, error: state.publishError };
      });
      expect(local.sources, JSON.stringify(local)).toEqual(
        expect.arrayContaining(["microphone", "camera"]),
      );
    }

    await expect
      .poll(() => subscriptions(alice.page))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identity: "spike-bob",
            source: "microphone",
          }),
          expect.objectContaining({ identity: "spike-bob", source: "camera" }),
          expect.objectContaining({
            identity: "spike-carol",
            source: "microphone",
          }),
          expect.objectContaining({
            identity: "spike-carol",
            source: "camera",
          }),
        ]),
      );
    for (const page of [bob.page, carol.page]) {
      await expect
        .poll(() => subscriptions(page))
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              identity: "spike-alice",
              source: "microphone",
            }),
            expect.objectContaining({
              identity: "spike-alice",
              source: "camera",
            }),
            expect.objectContaining({
              identity: "spike-alice",
              source: "screen_share",
            }),
            expect.objectContaining({
              identity: "spike-alice",
              source: "screen_share_audio",
            }),
          ]),
        );
    }
    for (const page of [bob.page, carol.page]) {
      await expect
        .poll(() => hasInboundMedia(page), { timeout: 10_000 })
        .toBe(true);
    }
    await expect
      .poll(() => sources(alice.page))
      .toEqual(
        expect.arrayContaining([
          "microphone",
          "camera",
          "screen_share",
          "screen_share_audio",
        ]),
      );

    const restricted = await join(
      browser,
      "spike-restricted",
      "microphone-only",
    );
    participants.push(restricted);
    await expect
      .poll(() =>
        restricted.page.evaluate(
          () => (window as any).livekitSpikeState.publishError,
        ),
      )
      .toMatch(/permission|publish|source|camera/i);
    await expect.poll(() => sources(restricted.page)).toEqual(["microphone"]);
  } finally {
    await Promise.all(participants.map(({ context }) => context.close()));
  }
});
