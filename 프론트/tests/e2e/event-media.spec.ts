import { expect, test, type Page } from "@playwright/test";
import type {
  EventState,
  MediaState,
  Snapshot,
  Welcome,
} from "../../src/generated/protocol";

test.skip(
  process.env.TOWN_E2E_MEDIA !== "true",
  "Run backend scripts/e2e.ps1 -Media with the local SFU running.",
);

type Seen = {
  event?: EventState;
  media?: MediaState;
  snapshot?: Snapshot;
  welcome?: Welcome;
  errors: string[];
};

async function instrumentMovement(page: Page, mapId = "") {
  // The media E2E browser uses fake microphone devices; this only instruments
  // its own WebRTC connections and the real test world socket.
  await page.addInitScript((testMapId) => {
    const peers: RTCPeerConnection[] = [];
    const OriginalPeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends OriginalPeerConnection {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        peers.push(this);
      }
    };
    Object.assign(window, { __townRtc: peers });

    const OriginalSocket = window.WebSocket;
    window.WebSocket = class extends OriginalSocket {
      manual = false;
      sequence = 0;
      epoch = 0;
      playerId = "";
      position = { x: 0, y: 0 };

      constructor(url: string | URL, protocols?: string | string[]) {
        if (testMapId && String(url).includes("/world/socket")) {
          const target = new URL(String(url), window.location.href);
          target.searchParams.set("townMapId", testMapId);
          url = target;
        }
        super(url, protocols);
        if (String(url).includes("/world/socket"))
          Object.assign(window, { __townSocket: this });
        this.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "welcome") {
            this.playerId = message.playerId;
            this.epoch = message.epoch;
            this.sequence = 0;
          }
          if (message.type === "snapshot") {
            const self = message.players.find(
              (player: { id: string }) => player.id === this.playerId,
            );
            if (self) this.position = self;
          }
        });
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") {
          const message = JSON.parse(data);
          if (message.type === "move") {
            if (this.manual) return;
            message.seq = ++this.sequence;
            data = JSON.stringify(message);
          }
        }
        super.send(data);
      }

      async walk(axis: "x" | "y", target: number) {
        const delay = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms));
        const move = (direction: number) =>
          super.send(
            JSON.stringify({
              type: "move",
              epoch: this.epoch,
              seq: ++this.sequence,
              dx: axis === "x" ? direction : 0,
              dy: axis === "y" ? direction : 0,
              running: false,
            }),
          );
        const deadline = Date.now() + 25_000;
        this.manual = true;
        try {
          while (
            Math.abs(target - this.position[axis]) > 0.16 &&
            Date.now() < deadline
          ) {
            const difference = target - this.position[axis];
            move(Math.sign(difference));
            await delay(Math.abs(difference) > 0.9 ? 100 : 50);
            if (Math.abs(difference) <= 0.9) {
              move(0);
              await delay(200);
            }
          }
          move(0);
          await delay(200);
          return this.position[axis];
        } finally {
          move(0);
          this.manual = false;
        }
      }
    };
  }, mapId);
}

async function join(page: Page, name: string, mapId = ""): Promise<Seen> {
  const seen: Seen = { errors: [] };
  page.on("pageerror", (error) => seen.errors.push(error.message));
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      const value = JSON.parse(String(frame.payload));
      if (value.type === "eventState") seen.event = value;
      if (value.type === "mediaState") seen.media = value;
      if (value.type === "snapshot") seen.snapshot = value;
      if (value.type === "welcome") seen.welcome = value;
    }),
  );
  await instrumentMovement(page, mapId);
  await page.addInitScript(() =>
    localStorage.setItem("hufs-town.event-tools.v11", "true"),
  );
  await page.goto("/");
  await page.getByPlaceholder("이름이나 닉네임을 알려주세요").fill(name);
  await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect(page.getByTestId("call-status")).toHaveAttribute(
    "data-status",
    "ready",
    { timeout: 20_000 },
  );
  return seen;
}

async function inboundAudioBytes(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const host = window as typeof window & {
      __townRtc: RTCPeerConnection[];
    };
    let bytes = 0;
    for (const peer of host.__townRtc) {
      if (peer.connectionState === "closed") continue;
      (await peer.getStats()).forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio")
          bytes += report.bytesReceived ?? 0;
      });
    }
    return bytes;
  });
}

async function inboundVideoFrames(page: Page): Promise<number> {
  return page.evaluate(async () => {
    let frames = 0;
    for (const peer of (
      window as typeof window & { __townRtc: RTCPeerConnection[] }
    ).__townRtc) {
      if (peer.connectionState === "closed") continue;
      (await peer.getStats()).forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "video")
          frames += report.framesDecoded ?? 0;
      });
    }
    return frames;
  });
}

async function serverStats(page: Page, epoch: number) {
  return page.evaluate(
    (policyEpoch) =>
      new Promise<{
        consumers: Array<{
          playerId?: string;
          source?: string;
          kind?: string;
          currentLayers?: {
            spatialLayer: number;
            temporalLayer: number;
          } | null;
        }>;
        producers: number;
        transports: number;
      }>((resolve, reject) => {
        const socket = (window as typeof window & { __townSocket: WebSocket })
            .__townSocket,
          requestId = crypto.randomUUID();
        const timeout = setTimeout(() => {
          socket.removeEventListener("message", listener);
          reject(new Error("media stats request timed out"));
        }, 5_000);
        const listener = (event: MessageEvent) => {
          const reply = JSON.parse(event.data);
          if (reply.type !== "mediaReply" || reply.requestId !== requestId)
            return;
          clearTimeout(timeout);
          socket.removeEventListener("message", listener);
          if (reply.ok) resolve(JSON.parse(reply.dataJson));
          else reject(new Error(reply.code));
        };
        socket.addEventListener("message", listener);
        socket.send(
          JSON.stringify({
            type: "mediaRequest",
            requestId,
            policyEpoch,
            method: "stats",
            dataJson: "{}",
          }),
        );
      }),
    epoch,
  );
}

async function walk(page: Page, axis: "x" | "y", target: number) {
  const position = await page.evaluate(
    ({ axis, target }) =>
      (
        window as typeof window & {
          __townSocket: {
            walk(axis: "x" | "y", target: number): Promise<number>;
          };
        }
      ).__townSocket.walk(axis, target),
    { axis, target },
  );
  expect(
    Math.abs(position - target),
    `Reach ${axis}=${target}, actual=${position}`,
  ).toBeLessThanOrEqual(0.2);
}

test("event microphone reaches public attendees, excludes private rooms and tears consumers down", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({
        permissions: ["microphone", "camera"],
        viewport: { width: 960, height: 720 },
      }),
    ),
  );

  try {
    const [speakerPage, attendeePage] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const [speaker, attendee] = await Promise.all([
      join(speakerPage, "발표 진행자"),
      join(attendeePage, "발표 참석자"),
    ]);

    const controls = speakerPage.getByLabel("행사 도구");
    await controls.getByRole("button", { name: "도구 열기" }).click();
    await expect(controls).toBeVisible();
    await controls.getByLabel("발표 제목").fill("실시간 발표 미디어 검증");
    await controls.getByRole("button", { name: "시작", exact: true }).click();
    await expect.poll(() => speaker.event?.active).toBe(true);
    await expect.poll(() => attendee.event?.active).toBe(true);
    await expect.poll(() => speaker.media?.eventSpeaker).toBe(true);
    await expect.poll(() => attendee.media?.eventMode).toBe(true);
    expect(attendee.media?.eventSpeaker).toBe(false);

    await speakerPage
      .getByRole("button", { name: "마이크 켜기", exact: true })
      .click();
    await expect(
      speakerPage.getByRole("button", { name: "마이크 끄기", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const speakerId = speaker.welcome!.playerId;
    try {
      await expect
        .poll(
          () =>
            attendee.media?.offers
              .filter((offer) => offer.playerId === speakerId)
              .map((offer) => offer.source),
          { timeout: 20_000 },
        )
        .toEqual(["MICROPHONE"]);
    } catch (error) {
      throw new Error(
        `Attendee did not receive the event microphone offer: ${JSON.stringify({
          speaker: speaker.media,
          attendee: attendee.media,
          speakerStats: speaker.media
            ? await serverStats(speakerPage, speaker.media.policyEpoch)
            : undefined,
          attendeeStats: attendee.media
            ? await serverStats(attendeePage, attendee.media.policyEpoch)
            : undefined,
          originalError: String(error),
        })}`,
      );
    }
    await expect
      .poll(() => inboundAudioBytes(attendeePage), { timeout: 20_000 })
      .toBeGreaterThan(1_000);
    await expect
      .poll(async () =>
        (
          await serverStats(attendeePage, attendee.media!.policyEpoch)
        ).consumers.some(
          (consumer) =>
            consumer.source === "MICROPHONE" && consumer.playerId === speakerId,
        ),
      )
      .toBe(true);

    // Move the listener into the map's PRIVATE meeting room while the event remains live.
    await walk(attendeePage, "x", 26.95);
    await walk(attendeePage, "y", 13.45);
    await walk(attendeePage, "x", 7.6);
    await walk(attendeePage, "y", 11.7);
    await expect.poll(() => attendee.media?.kind).toBe("PRIVATE");
    await expect.poll(() => attendee.media?.eventMode).toBe(false);
    await expect
      .poll(() =>
        attendee.media?.offers.some((offer) => offer.playerId === speakerId),
      )
      .toBe(false);
    await expect(
      attendeePage.locator('audio[data-source="MICROPHONE"]'),
    ).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await serverStats(attendeePage, attendee.media!.policyEpoch))
            .consumers,
      )
      .toEqual([]);

    // Return to a public area and confirm the active presentation resumes delivery.
    await walk(attendeePage, "y", 13.45);
    await walk(attendeePage, "x", 26.95);
    await expect.poll(() => attendee.media?.kind).toBe("EVENT");
    await expect
      .poll(() =>
        attendee.media?.offers.some(
          (offer) =>
            offer.playerId === speakerId && offer.source === "MICROPHONE",
        ),
      )
      .toBe(true);
    const beforeEventStop = await inboundAudioBytes(attendeePage);
    await expect
      .poll(() => inboundAudioBytes(attendeePage), { timeout: 20_000 })
      .toBeGreaterThan(beforeEventStop);

    await controls.getByRole("button", { name: "발표 종료" }).click();
    await expect.poll(() => speaker.event?.active).toBe(false);
    await expect.poll(() => attendee.event?.active).toBe(false);
    await expect.poll(() => attendee.media?.eventMode).toBe(false);
    await expect
      .poll(() =>
        attendee.media?.offers.some((offer) => offer.playerId === speakerId),
      )
      .toBe(false);
    await expect
      .poll(
        async () =>
          (await serverStats(attendeePage, attendee.media!.policyEpoch))
            .consumers,
      )
      .toEqual([]);
    await expect(
      attendeePage.locator('audio[data-source="MICROPHONE"]'),
    ).toHaveCount(0);

    expect(speaker.errors).toEqual([]);
    expect(attendee.errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("event audio and low simulcast video reach a participant on another map", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({
        permissions: ["microphone", "camera"],
        viewport: { width: 960, height: 720 },
      }),
    ),
  );

  try {
    const [speakerPage, attendeePage] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const [speaker, attendee] = await Promise.all([
      join(speakerPage, "교차 맵 발표자", "main-map"),
      join(attendeePage, "교차 맵 참석자", "workshop-map"),
    ]);

    const controls = speakerPage.getByLabel("행사 도구");
    await controls.getByRole("button", { name: "도구 열기" }).click();
    await controls.getByLabel("발표 제목").fill("교차 맵 RTP 검증");
    await controls.getByRole("button", { name: "시작", exact: true }).click();
    await expect.poll(() => speaker.event?.active).toBe(true);
    await expect.poll(() => attendee.event?.active).toBe(true);
    await expect.poll(() => attendee.media?.eventMode).toBe(true);
    await expect
      .poll(() =>
        attendee.event?.participants
          .map((participant) => participant.mapId)
          .sort(),
      )
      .toEqual(["main-map", "workshop-map"]);

    await speakerPage
      .getByRole("button", { name: "마이크 켜기", exact: true })
      .click();
    await speakerPage
      .getByRole("button", { name: "카메라 켜기", exact: true })
      .click();
    await expect.poll(() => speaker.media?.eventSpeaker).toBe(true);
    const speakerId = speaker.welcome!.playerId;
    await expect
      .poll(
        () =>
          attendee.media?.offers
            .filter((offer) => offer.playerId === speakerId)
            .map((offer) => offer.source)
            .sort(),
        { timeout: 20_000 },
      )
      .toEqual(["CAMERA", "MICROPHONE"]);
    await expect
      .poll(() => inboundAudioBytes(attendeePage), { timeout: 20_000 })
      .toBeGreaterThan(1_000);
    await expect
      .poll(() => inboundVideoFrames(attendeePage), { timeout: 20_000 })
      .toBeGreaterThan(0);

    await expect
      .poll(
        async () =>
          (
            await serverStats(attendeePage, attendee.media!.policyEpoch)
          ).consumers.find(
            (consumer) =>
              consumer.playerId === speakerId && consumer.source === "CAMERA",
          )?.currentLayers?.spatialLayer,
      )
      .toBe(0);

    await attendeePage
      .getByRole("button", { name: "교차 맵 발표자 화면 고정" })
      .click();
    await expect
      .poll(
        async () =>
          (
            await serverStats(attendeePage, attendee.media!.policyEpoch)
          ).consumers.find(
            (consumer) =>
              consumer.playerId === speakerId && consumer.source === "CAMERA",
          )?.currentLayers?.spatialLayer,
      )
      .toBe(1);
    await attendeePage
      .getByRole("button", { name: "교차 맵 발표자 화면 고정 해제" })
      .click();
    await expect
      .poll(
        async () =>
          (
            await serverStats(attendeePage, attendee.media!.policyEpoch)
          ).consumers.find(
            (consumer) =>
              consumer.playerId === speakerId && consumer.source === "CAMERA",
          )?.currentLayers?.spatialLayer,
      )
      .toBe(0);

    await controls.getByRole("button", { name: "발표 종료" }).click();
    await expect.poll(() => attendee.event?.active).toBe(false);
    await expect.poll(() => attendee.media?.eventMode).toBe(false);
    await expect
      .poll(() =>
        attendee.media?.offers.some((offer) => offer.playerId === speakerId),
      )
      .toBe(false);
    await expect
      .poll(
        async () =>
          (await serverStats(attendeePage, attendee.media!.policyEpoch))
            .consumers,
      )
      .toEqual([]);
    expect(speaker.errors).toEqual([]);
    expect(attendee.errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
