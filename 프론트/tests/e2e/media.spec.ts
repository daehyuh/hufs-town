import { execFileSync } from "node:child_process";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type {
  MediaState,
  RoomRecordingState,
  Snapshot,
  Welcome,
} from "../../src/generated/protocol";

test.skip(
  process.env.TOWN_E2E_MEDIA !== "true",
  "Run backend scripts/e2e.ps1 -Media with the local SFU running.",
);

async function enableRtcCapacityRenderingMode(context: BrowserContext) {
  await context.addInitScript(() => {
    window.__hufsRtcCapacityHeadless = true;
    localStorage.setItem("hufs-town.render-mode", "low-spec");
  });
}

async function expectRtcCapacityRenderingMode(pages: Page[]) {
  await Promise.all(
    pages.map(async (page) => {
      await expect
        .poll(() =>
          page.evaluate(() => window.__hufsRtcCapacityHeadlessApplied),
        )
        .toBe(true);
      await expect(
        page.locator('[data-testid="world-canvas"] canvas'),
      ).toHaveCount(0);
    }),
  );
}

test("mobile explains when the browser cannot share its screen", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await join(page, `mobile-screen-share-${Date.now()}`);
    await page.evaluate(() => {
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
        configurable: true,
        value: undefined,
      });
    });

    await page.getByRole("button", { name: "화면 공유 시작" }).click();
    await expect(page.locator(".call-error")).toContainText(
      "이 브라우저에서는 화면 공유를 지원하지 않아요.",
    );
    await expect(page.locator(".call-error")).toContainText(
      "마이크와 카메라는 계속 사용할 수 있어요.",
    );
  } finally {
    await context.close();
  }
});

test("mobile receives desktop microphone, camera, and screen sharing in a compact layout", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const [mobileContext, desktopContext] = await Promise.all([
    browser.newContext({
      permissions: ["microphone", "camera"],
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    }),
    browser.newContext({
      permissions: ["microphone", "camera"],
      viewport: { width: 960, height: 720 },
    }),
  ]);
  try {
    const [mobile, desktop] = await Promise.all([
      mobileContext.newPage(),
      desktopContext.newPage(),
    ]);
    const [mobileState, desktopState] = await Promise.all([
      join(mobile, "모바일 참가자"),
      join(desktop, "데스크톱 참가자"),
    ]);
    await expect.poll(() => mobileState.media?.peers.length).toBe(1);
    await expect.poll(() => desktopState.media?.peers.length).toBe(1);
    await expect(mobile.locator(".event-controls")).toHaveCount(0);
    await expect(desktop.locator(".event-controls")).toHaveCount(0);
    const mobileStatusFontSize = await mobile
      .locator(".call-status")
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    expect(mobileStatusFontSize).toBeGreaterThanOrEqual(13);
    const mobileControlLabelFontSize = await mobile
      .locator(".media-controls .control span")
      .first()
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    expect(mobileControlLabelFontSize).toBeGreaterThanOrEqual(11);

    await mobile
      .getByRole("button", { name: "마이크 켜기", exact: true })
      .click();
    await mobile
      .getByRole("button", { name: "카메라 켜기", exact: true })
      .click();
    await desktop
      .getByRole("button", { name: "마이크 켜기", exact: true })
      .click();
    await desktop
      .getByRole("button", { name: "카메라 켜기", exact: true })
      .click();
    await desktop
      .getByRole("button", { name: "화면 공유 시작", exact: true })
      .click();

    await expect(
      mobile.getByLabel("데스크톱 참가자 카메라", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        mobileState.media?.offers.some((offer) => offer.source === "SCREEN"),
      )
      .toBe(true);
    await expect(mobile.locator(".shared-screen video")).toBeVisible();
    const mobileFloatingMediaA11y = await new AxeBuilder({ page: mobile })
      .include(".shared-screen")
      .include(".camera-stage")
      .analyze();
    expect(
      mobileFloatingMediaA11y.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map(({ target }) => target),
      })),
      "모바일 카메라·화면공유 창 접근성 위반",
    ).toEqual([]);
    const mobileCameraNameFontSize = await mobile
      .locator(".camera-stage .camera-tile figcaption")
      .first()
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    expect(mobileCameraNameFontSize).toBeGreaterThanOrEqual(12);
    const mobileMediaFrames = await mobile.evaluate(() => {
      const stage = document
        .querySelector(".world-stage")!
        .getBoundingClientRect();
      const camera = document
        .querySelector(".camera-stage")!
        .getBoundingClientRect();
      const screen = document
        .querySelector(".shared-screen")!
        .getBoundingClientRect();
      const video = document.querySelector(".shared-screen video")!;
      return {
        stage: { width: stage.width, height: stage.height },
        camera: {
          x: camera.left - stage.left,
          y: camera.top - stage.top,
          width: camera.width,
          height: camera.height,
        },
        screen: {
          x: screen.left - stage.left,
          y: screen.top - stage.top,
          width: screen.width,
          height: screen.height,
          videoWidth: video.getBoundingClientRect().width,
        },
        horizontalOverflow:
          document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    expect(mobileMediaFrames.camera.width).toBeLessThanOrEqual(128);
    expect(mobileMediaFrames.camera.height).toBeLessThanOrEqual(220);
    expect(mobileMediaFrames.camera.x).toBeGreaterThanOrEqual(8);
    expect(
      mobileMediaFrames.camera.x + mobileMediaFrames.camera.width,
    ).toBeLessThanOrEqual(mobileMediaFrames.stage.width - 8);
    expect(
      mobileMediaFrames.camera.y + mobileMediaFrames.camera.height,
    ).toBeLessThanOrEqual(mobileMediaFrames.stage.height - 8);
    expect(mobileMediaFrames.screen.videoWidth).toBeGreaterThan(200);
    expect(mobileMediaFrames.horizontalOverflow).toBe(false);

    const touch = await mobileContext.newCDPSession(mobile);
    const touchDrag = async (
      selector: string,
      deltaX: number,
      deltaY: number,
    ) => {
      const bounds = await mobile.locator(selector).boundingBox();
      expect(bounds).not.toBeNull();
      const x = bounds!.x + bounds!.width / 2;
      const y = bounds!.y + bounds!.height / 2;
      const touchTargetReachable = await mobile.locator(selector).evaluate(
        (target, point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return hit === target || Boolean(hit && target.contains(hit));
        },
        { x, y },
      );
      expect(touchTargetReachable, `${selector} should receive touch`).toBe(
        true,
      );
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ id: 1, x, y }],
      });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ id: 1, x: x + deltaX, y: y + deltaY }],
      });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await mobile.waitForTimeout(80);
    };

    const screenBeforeTouch = await mobile
      .locator(".shared-screen")
      .boundingBox();
    await touchDrag(".shared-screen > header > span:first-child", 0, 0);
    const screenZIndex = await mobile
      .locator(".shared-screen")
      .evaluate((node) => Number(getComputedStyle(node).zIndex));
    const cameraZIndex = await mobile
      .locator(".camera-stage")
      .evaluate((node) => Number(getComputedStyle(node).zIndex));
    expect(screenZIndex).toBeGreaterThan(cameraZIndex);
    await touchDrag(".shared-screen .floating-panel-resize", -48, 0);
    const screenAfterInitialResize = await mobile
      .locator(".shared-screen")
      .boundingBox();
    expect(screenAfterInitialResize!.width).toBeLessThan(
      screenBeforeTouch!.width - 32,
    );
    await touchDrag(".shared-screen > header > span:first-child", 20, 20);
    const screenAfterDrag = await mobile
      .locator(".shared-screen")
      .boundingBox();
    expect(screenAfterDrag!.x).toBeGreaterThan(screenBeforeTouch!.x + 12);
    expect(screenAfterDrag!.y).toBeGreaterThan(screenBeforeTouch!.y + 12);
    await touchDrag(".shared-screen .floating-panel-resize", -24, 20);

    const cameraBeforeTouch = await mobile
      .locator(".camera-stage")
      .boundingBox();
    await touchDrag(".camera-stage-heading", -18, 18);
    const cameraAfterDrag = await mobile.locator(".camera-stage").boundingBox();
    expect(cameraAfterDrag!.x).toBeLessThan(cameraBeforeTouch!.x - 12);
    expect(cameraAfterDrag!.y).toBeGreaterThan(cameraBeforeTouch!.y + 12);
    const cameraFrontZIndex = await mobile
      .locator(".camera-stage")
      .evaluate((node) => Number(getComputedStyle(node).zIndex));
    const screenBackZIndex = await mobile
      .locator(".shared-screen")
      .evaluate((node) => Number(getComputedStyle(node).zIndex));
    expect(cameraFrontZIndex).toBeGreaterThan(screenBackZIndex);
    await touchDrag(".camera-stage .floating-panel-resize", 16, 16);
    const cameraAfterResize = await mobile
      .locator(".camera-stage")
      .boundingBox();
    expect(cameraAfterResize!.width).toBeGreaterThan(
      cameraAfterDrag!.width + 8,
    );
    expect(cameraAfterResize!.height).toBeGreaterThan(
      cameraAfterDrag!.height + 8,
    );

    const mobileFramesAfterTouch = await mobile.evaluate(() => {
      const stage = document
        .querySelector(".world-stage")!
        .getBoundingClientRect();
      const camera = document
        .querySelector(".camera-stage")!
        .getBoundingClientRect();
      const screen = document
        .querySelector(".shared-screen")!
        .getBoundingClientRect();
      return {
        stage: { width: stage.width, height: stage.height },
        camera: {
          x: camera.left - stage.left,
          y: camera.top - stage.top,
          width: camera.width,
          height: camera.height,
        },
        screen: {
          x: screen.left - stage.left,
          y: screen.top - stage.top,
          width: screen.width,
          height: screen.height,
          videoWidth: document
            .querySelector(".shared-screen video")!
            .getBoundingClientRect().width,
        },
        horizontalOverflow:
          document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    expect(mobileFramesAfterTouch.camera.x).toBeGreaterThanOrEqual(8);
    expect(mobileFramesAfterTouch.camera.y).toBeGreaterThanOrEqual(8);
    expect(
      mobileFramesAfterTouch.camera.x + mobileFramesAfterTouch.camera.width,
    ).toBeLessThanOrEqual(mobileFramesAfterTouch.stage.width - 8);
    expect(
      mobileFramesAfterTouch.camera.y + mobileFramesAfterTouch.camera.height,
    ).toBeLessThanOrEqual(mobileFramesAfterTouch.stage.height - 8);
    expect(mobileFramesAfterTouch.screen.width).toBeLessThan(
      mobileMediaFrames.screen.width,
    );
    expect(mobileFramesAfterTouch.screen.height).toBeGreaterThan(
      mobileMediaFrames.screen.height,
    );
    expect(mobileFramesAfterTouch.screen.videoWidth).toBeGreaterThan(200);
    expect(mobileFramesAfterTouch.screen.x).toBeGreaterThanOrEqual(8);
    expect(
      mobileFramesAfterTouch.screen.x + mobileFramesAfterTouch.screen.width,
    ).toBeLessThanOrEqual(mobileFramesAfterTouch.stage.width - 8);
    expect(
      mobileFramesAfterTouch.screen.y + mobileFramesAfterTouch.screen.height,
    ).toBeLessThanOrEqual(mobileFramesAfterTouch.stage.height - 8);
    expect(mobileFramesAfterTouch.horizontalOverflow).toBe(false);
    await touch.detach();

    await expect(
      desktop.getByLabel("모바일 참가자 카메라", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => (await inbound(mobile)).audio, { timeout: 20_000 })
      .toBeGreaterThan(1000);
    await expect
      .poll(async () => (await inbound(mobile)).video, { timeout: 20_000 })
      .toBeGreaterThan(5000);
    await expect
      .poll(async () => (await inbound(desktop)).audio, { timeout: 20_000 })
      .toBeGreaterThan(1000);
    await expect
      .poll(async () => (await inbound(desktop)).video, { timeout: 20_000 })
      .toBeGreaterThan(5000);
    await expect
      .poll(() =>
        mobile.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
  } finally {
    await Promise.all([mobileContext.close(), desktopContext.close()]);
  }
});

async function instrument(page: Page, previewIdentity = "") {
  // Test-only synthetic devices; never captures the user's desktop or microphone.
  await page.addInitScript((previewIdentity) => {
    const captureRequests: Array<{
      audio: boolean;
      video: boolean;
      startedAt: number;
      finishedAt?: number;
      outcome?: "resolved" | "rejected";
      errorName?: string;
    }> = [];
    const capturedTracks: MediaStreamTrack[] = [];
    const trackStops: Array<{ kind: string; stack: string }> = [];
    const originalTrackStop = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () {
      trackStops.push({
        kind: this.kind,
        stack: new Error().stack?.split("\n").slice(0, 6).join("\n") ?? "",
      });
      return originalTrackStop.call(this);
    };
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        const request: (typeof captureRequests)[number] = {
          audio: Boolean(constraints.audio),
          video: Boolean(constraints.video),
          startedAt: performance.now(),
        };
        captureRequests.push(request);
        try {
          const stream = await originalGetUserMedia(constraints);
          request.outcome = "resolved";
          capturedTracks.push(...stream.getTracks());
          return stream;
        } catch (error) {
          request.outcome = "rejected";
          request.errorName =
            error instanceof DOMException ? error.name : "UnknownError";
          throw error;
        } finally {
          request.finishedAt = performance.now();
        }
      },
    });
    Object.defineProperty(window, "__townMediaCaptureDebug", {
      configurable: true,
      value: { captureRequests, capturedTracks, trackStops },
    });
    const peers: RTCPeerConnection[] = [];
    const screenTracks: MediaStreamTrack[] = [];
    const screenAudioTracks: MediaStreamTrack[] = [];
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original {
      constructor(config?: RTCConfiguration) {
        super(config);
        peers.push(this);
      }
    };
    Object.assign(window, {
      __townRtc: peers,
      __townSyntheticScreenTracks: screenTracks,
      __townSyntheticScreenAudioTracks: screenAudioTracks,
    });
    const OriginalSocket = window.WebSocket;
    window.WebSocket = class extends OriginalSocket {
      manual = false;
      sequence = 0;
      epoch = 0;
      playerId = "";
      position = { x: 0, y: 0 };
      constructor(url: string | URL, protocols?: string | string[]) {
        let socketUrl = url;
        if (previewIdentity && String(url).includes("/world/socket")) {
          const parsed = new URL(String(url), location.href);
          parsed.searchParams.set("townPreviewUser", previewIdentity);
          socketUrl = parsed.toString();
        }
        super(socketUrl, protocols);
        if (String(socketUrl).includes("/world/socket"))
          Object.assign(window, { __townSocket: this });
        this.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "welcome") {
            this.playerId = message.playerId;
            this.epoch = message.epoch;
            this.sequence = 0;
          }
          if (message.type === "mediaState")
            Object.assign(window, { __townLastMediaState: message });
          if (message.type === "snapshot") {
            const self = message.players.find(
              (p: { id: string }) => p.id === this.playerId,
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
        // Ordinary directional inputs through the real world handler. No position overrides.
        // Isolate navigation from Phaser's RAF timing while exercising actual collision/zone logic.
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
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const draw = canvas.getContext("2d")!;
      let frame = 0;
      const timer = setInterval(() => {
        draw.fillStyle = "#185d44";
        draw.fillRect(0, 0, 640, 360);
        draw.fillStyle = "white";
        draw.font = "30px sans-serif";
        draw.fillText(`HUFS synthetic screen ${frame++}`, 40, 160);
      }, 50);
      const stream = canvas.captureStream(15),
        audio = new AudioContext(),
        tone = audio.createOscillator(),
        destination = audio.createMediaStreamDestination();
      tone.connect(destination);
      tone.start();
      await audio.resume();
      stream.addTrack(destination.stream.getAudioTracks()[0]);
      const video = stream.getVideoTracks()[0],
        sharedAudio = stream.getAudioTracks()[0],
        originalStop = video.stop.bind(video);
      screenTracks.push(video);
      screenAudioTracks.push(sharedAudio);
      video.stop = () => {
        originalStop();
        clearInterval(timer);
        tone.stop();
        void audio.close();
      };
      return stream;
    };
  }, previewIdentity);
}
async function inbound(page: Page) {
  return page.evaluate(async () => {
    const result = {
      audio: 0,
      video: 0,
      packets: 0,
      frames: 0,
      samples: 0,
      open: 0,
    };
    for (const pc of (window as unknown as { __townRtc: RTCPeerConnection[] })
      .__townRtc) {
      if (pc.connectionState === "closed") continue;
      result.open++;
      (await pc.getStats()).forEach((r) => {
        if (r.type === "inbound-rtp") {
          if (r.kind === "audio") result.audio += r.bytesReceived ?? 0;
          if (r.kind === "video") result.video += r.bytesReceived ?? 0;
          result.packets += r.packetsReceived ?? 0;
          result.frames += r.framesReceived ?? r.framesDecoded ?? 0;
          result.samples +=
            (r.totalSamplesReceived ?? 0) - (r.concealedSamples ?? 0);
        }
      });
    }
    return result;
  });
}
async function serverStats(page: Page, epoch: number) {
  return page.evaluate(
    (epoch) =>
      new Promise<{
        consumers: unknown[];
        producers: number;
        transports: number;
      }>((resolve, reject) => {
        const ws = (window as unknown as { __townSocket: WebSocket })
            .__townSocket,
          requestId = crypto.randomUUID();
        const timeout = setTimeout(() => {
          ws.removeEventListener("message", listener);
          reject(new Error("stats timed out"));
        }, 5000);
        const listener = (event: MessageEvent) => {
          const reply = JSON.parse(event.data);
          if (reply.type === "mediaReply" && reply.requestId === requestId) {
            clearTimeout(timeout);
            ws.removeEventListener("message", listener);
            if (reply.ok) resolve(JSON.parse(reply.dataJson));
            else reject(new Error(reply.code));
          }
        };
        ws.addEventListener("message", listener);
        ws.send(
          JSON.stringify({
            type: "mediaRequest",
            requestId,
            policyEpoch: epoch,
            method: "stats",
            dataJson: "{}",
          }),
        );
      }),
    epoch,
  );
}

function recordingContainer() {
  const container = process.env.TOWN_E2E_MEDIA_CONTAINER ?? "";
  if (!/^[a-f0-9]{12,64}$/i.test(container))
    throw new Error("The media test container is not configured.");
  return container;
}

function readRecordingArtifact(recordingId: string) {
  if (!/^[a-f0-9-]{36}$/i.test(recordingId))
    throw new Error("Invalid recording ID from the World server.");
  const script = [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const id=process.argv[1];",
    "const directory=path.join('/data/recordings',id);",
    "if(!fs.existsSync(directory)){process.stdout.write('null');process.exit(0)}",
    "const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));",
    "const tracks=(manifest.tracks||[]).map(track=>{",
    "if(!/^tracks\\/[a-f0-9-]+\\.webm$/i.test(track.fileKey))throw new Error('Unexpected recording file key');",
    "const file=path.join(directory,track.fileKey);",
    "const partial=file+'.part';",
    "return {...track,fileBytes:fs.existsSync(file)?fs.statSync(file).size:0,partialBytes:fs.existsSync(partial)?fs.statSync(partial).size:0};",
    "});",
    "process.stdout.write(JSON.stringify({manifest,tracks}));",
  ].join("");
  const output = execFileSync(
    "docker",
    ["exec", recordingContainer(), "node", "-e", script, recordingId],
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(output) as null | {
    manifest: {
      status: string;
      sources: string[];
      retentionDays: number;
      retentionExpiresAt: number;
    };
    tracks: Array<{
      source: string;
      fileKey: string;
      bytes: number;
      sha256: string;
      rtpPackets: number;
      rtpBytes: number;
      status: string;
      fileBytes: number;
      partialBytes: number;
    }>;
  };
}

function probeRecordingTrack(recordingId: string, fileKey: string) {
  if (!/^tracks\/[a-f0-9-]+\.webm$/i.test(fileKey))
    throw new Error("Unexpected recording track path.");
  const output = execFileSync(
    "docker",
    [
      "exec",
      recordingContainer(),
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration",
      "-of",
      "json",
      `/data/recordings/${recordingId}/${fileKey}`,
    ],
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(output) as {
    format: { format_name: string; duration: string };
  };
}

async function join(
  page: Page,
  name: string,
  previewIdentity = "",
  waitForMediaReady = true,
) {
  const seen: {
    media?: MediaState;
    recording?: RoomRecordingState;
    snapshot?: Snapshot;
    welcome?: Welcome;
    errors: string[];
    replies: unknown[];
    recordingAcks: unknown[];
    wireErrors: unknown[];
    sentMessages: unknown[];
  } = {
    errors: [],
    replies: [],
    recordingAcks: [],
    wireErrors: [],
    sentMessages: [],
  };
  page.on("pageerror", (e) => seen.errors.push(e.message));
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      try {
        seen.sentMessages.push(JSON.parse(String(frame.payload)));
      } catch {
        /* Ignore non-JSON frames. */
      }
    });
    ws.on("framereceived", (frame) => {
      const value = JSON.parse(String(frame.payload));
      if (value.type === "mediaState") seen.media = value;
      if (value.type === "roomRecordingState") seen.recording = value;
      if (value.type === "snapshot") seen.snapshot = value;
      if (value.type === "welcome") seen.welcome = value;
      if (value.type === "mediaReply" && !value.ok) seen.replies.push(value);
      if (value.type === "roomRecordingAck") seen.recordingAcks.push(value);
      if (value.type === "error") seen.wireErrors.push(value);
    });
  });
  if (process.env.TOWN_E2E_TURN === "true") {
    await page.addInitScript(() => {
      const instances: RTCPeerConnection[] = [];
      const stateEvents: Array<{
        connectionState: RTCPeerConnectionState;
        iceConnectionState: RTCIceConnectionState;
      }> = [];
      const Original = window.RTCPeerConnection;
      window.RTCPeerConnection = new Proxy(Original, {
        construct(target, args) {
          const [configuration, ...rest] = args as [
            RTCConfiguration?,
            ...unknown[],
          ];
          const peer = Reflect.construct(target, [
            { ...configuration, iceTransportPolicy: "relay" },
            ...rest,
          ]) as RTCPeerConnection;
          const recordState = () =>
            stateEvents.push({
              connectionState: peer.connectionState,
              iceConnectionState: peer.iceConnectionState,
            });
          peer.addEventListener("connectionstatechange", recordState);
          peer.addEventListener("iceconnectionstatechange", recordState);
          instances.push(peer);
          return peer;
        },
      });
      Object.defineProperty(window, "__townTurnPeerConnections", {
        configurable: true,
        value: instances,
      });
      Object.defineProperty(window, "__townTurnStateEvents", {
        configurable: true,
        value: stateEvents,
      });
    });
  }
  await instrument(page, previewIdentity);
  await page.goto("/");
  await page.getByPlaceholder("이름이나 닉네임을 알려주세요").fill(name);
  await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
  await expect
    .poll(() => seen.welcome?.playerId, { timeout: 20_000 })
    .toBeTruthy();
  if (waitForMediaReady) {
    await expect(page.getByTestId("call-status")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 20_000 },
    );
  }
  return seen;
}
async function hasConnectedRelayPeer(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const peerWindow = window as typeof window & {
      __townTurnPeerConnections?: RTCPeerConnection[];
    };
    const peers = (peerWindow.__townTurnPeerConnections ?? []).filter(
      (peer) =>
        peer.connectionState === "connected" &&
        peer.getConfiguration().iceTransportPolicy === "relay",
    );
    const results = await Promise.all(
      peers.map(async (peer) => {
        const report = await peer.getStats();
        return [...report.values()].some(
          (entry) =>
            entry.type === "local-candidate" &&
            "candidateType" in entry &&
            entry.candidateType === "relay",
        );
      }),
    );
    return results.some(Boolean);
  });
}
function controlTurnRelay(paused: boolean) {
  const composeFile = process.env.TOWN_E2E_TURN_COMPOSE_FILE;
  const project = process.env.TOWN_E2E_TURN_PROJECT;
  if (!composeFile || !project)
    throw new Error("TURN test control is not configured.");
  execFileSync(
    "docker",
    [
      "compose",
      "--project-name",
      project,
      "--file",
      composeFile,
      paused ? "pause" : "unpause",
      "turn",
    ],
    { windowsHide: true, stdio: "pipe" },
  );
}
async function turnStateEventCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host = window as typeof window & {
      __townTurnStateEvents?: unknown[];
    };
    return host.__townTurnStateEvents?.length ?? 0;
  });
}
async function turnInterruptedAfter(
  page: Page,
  cursor: number,
): Promise<boolean> {
  return page.evaluate((cursor) => {
    const host = window as typeof window & {
      __townTurnStateEvents?: Array<{
        connectionState: RTCPeerConnectionState;
        iceConnectionState: RTCIceConnectionState;
      }>;
    };
    return (host.__townTurnStateEvents ?? [])
      .slice(cursor)
      .some(
        (event) =>
          ["disconnected", "failed"].includes(event.connectionState) ||
          ["disconnected", "failed"].includes(event.iceConnectionState),
      );
  }, cursor);
}
async function turnConnectedAfter(
  page: Page,
  cursor: number,
): Promise<boolean> {
  return page.evaluate((cursor) => {
    const host = window as typeof window & {
      __townTurnStateEvents?: Array<{
        connectionState: RTCPeerConnectionState;
        iceConnectionState: RTCIceConnectionState;
      }>;
    };
    return (host.__townTurnStateEvents ?? [])
      .slice(cursor)
      .some(
        (event) =>
          event.connectionState === "connected" ||
          event.iceConnectionState === "connected",
      );
  }, cursor);
}
async function turnDiagnostics(page: Page) {
  return page.evaluate(async () => {
    const peerWindow = window as typeof window & {
      __townTurnPeerConnections?: RTCPeerConnection[];
    };
    return Promise.all(
      (peerWindow.__townTurnPeerConnections ?? []).map(async (peer) => {
        const report = await peer.getStats();
        const candidateType = (id: string | undefined) => {
          const candidate = id ? report.get(id) : undefined;
          return candidate && "candidateType" in candidate
            ? candidate.candidateType
            : "";
        };
        return {
          state: peer.connectionState,
          iceState: peer.iceConnectionState,
          gathering: peer.iceGatheringState,
          policy: peer.getConfiguration().iceTransportPolicy,
          serverCount: peer.getConfiguration().iceServers?.length ?? 0,
          serverSchemes: peer
            .getConfiguration()
            .iceServers?.flatMap((server) =>
              (Array.isArray(server.urls) ? server.urls : [server.urls]).map(
                (url) => url.split(":", 1)[0],
              ),
            ),
          localCandidates: [...report.values()]
            .filter(
              (entry) =>
                entry.type === "local-candidate" && "candidateType" in entry,
            )
            .map((entry) =>
              "candidateType" in entry
                ? {
                    type: entry.candidateType,
                    protocol: "protocol" in entry ? entry.protocol : "",
                  }
                : null,
            ),
          pairs: [...report.values()]
            .filter((entry) => entry.type === "candidate-pair")
            .map((entry) =>
              "state" in entry
                ? {
                    state: entry.state,
                    nominated: "nominated" in entry && entry.nominated,
                    selected: "selected" in entry && entry.selected,
                    bytesSent: "bytesSent" in entry ? entry.bytesSent : 0,
                    bytesReceived:
                      "bytesReceived" in entry ? entry.bytesReceived : 0,
                    localType:
                      "localCandidateId" in entry
                        ? candidateType(entry.localCandidateId)
                        : "",
                    remoteType:
                      "remoteCandidateId" in entry
                        ? candidateType(entry.remoteCandidateId)
                        : "",
                  }
                : null,
            ),
        };
      }),
    );
  });
}

test("preflight checks microphone, camera and speakers locally, then releases its streams before entry", async ({
  browser,
}) => {
  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const streams: MediaStream[] = [];
      const devices = navigator.mediaDevices;
      const originalGetUserMedia = devices.getUserMedia.bind(devices);
      devices.getUserMedia = async (constraints = {}) => {
        if (constraints.audio && constraints.video === false) {
          const audioContext = new AudioContext();
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          const destination = audioContext.createMediaStreamDestination();
          gain.gain.value = 0.2;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          await audioContext.resume();
          const stream = destination.stream;
          const track = stream.getAudioTracks()[0];
          const stop = track.stop.bind(track);
          let stopped = false;
          track.stop = () => {
            if (stopped) return;
            stopped = true;
            stop();
            oscillator.stop();
            void audioContext.close();
          };
          streams.push(stream);
          return stream;
        }
        const stream = await originalGetUserMedia(constraints);
        streams.push(stream);
        return stream;
      };
      Object.assign(window, { __townPreflightStreams: streams });
    });
    await instrument(page);
    await page.goto("/");
    await page
      .getByPlaceholder("이름이나 닉네임을 알려주세요")
      .fill("장치 사전 점검");
    await page
      .getByRole("button", { name: "입장 전 마이크·카메라 확인" })
      .click();
    const dialog = page.getByRole("dialog", { name: "입장 전 장치 확인" });
    await expect(dialog.getByLabel("입장 전 마이크 장치")).toBeVisible();
    await expect(dialog.getByLabel("입장 전 카메라 장치")).toBeVisible();
    await expect(dialog.getByLabel("입장 전 스피커 장치")).toBeVisible();

    await dialog.getByRole("button", { name: "마이크 테스트" }).click();
    const meter = dialog.getByRole("meter", { name: "마이크 입력 수준" });
    await expect(meter).toBeVisible();
    await expect
      .poll(() =>
        meter.evaluate((element) =>
          Number((element as HTMLMeterElement).value),
        ),
      )
      .toBeGreaterThan(0);
    await dialog.getByRole("button", { name: "테스트 끄기" }).click();
    await dialog.getByRole("button", { name: "마이크 테스트" }).click();
    await page.evaluate(() => {
      const host = window as typeof window & {
        __townPreflightStreams?: MediaStream[];
      };
      const track = host.__townPreflightStreams?.at(-1)?.getAudioTracks()[0];
      if (!track) throw new Error("Preflight microphone track is missing.");
      track.stop();
      track.dispatchEvent(new Event("ended"));
    });
    await expect(
      dialog.getByRole("button", { name: "마이크 테스트" }),
    ).toBeVisible();
    await expect(
      dialog.getByText("마이크 테스트를 시작하면 입력을 확인할 수 있어요."),
    ).toBeVisible();

    await dialog.getByRole("button", { name: "미리보기", exact: true }).click();
    const camera = dialog.getByLabel("내 카메라 미리보기");
    await expect(camera).toBeVisible();
    await expect
      .poll(() =>
        camera.evaluate((element) => (element as HTMLVideoElement).readyState),
      )
      .toBeGreaterThan(0);

    await dialog.getByRole("button", { name: "스피커 테스트" }).click();
    await expect(
      dialog.getByText("소리가 들렸다면 스피커가 준비됐어요."),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "확인하고 입장" }).click();
    await expect(page.locator(".connection-status")).toHaveText("연결됨");
    await expect(page.getByTestId("call-status")).toHaveAttribute(
      "data-status",
      "ready",
    );

    const trackStates = await page.evaluate(() => {
      const host = window as typeof window & {
        __townPreflightStreams?: MediaStream[];
      };
      return (host.__townPreflightStreams ?? []).flatMap((stream) =>
        stream.getTracks().map((track) => track.readyState),
      );
    });
    expect(trackStates).toHaveLength(3);
    expect(trackStates.every((state) => state === "ended")).toBe(true);
    const epoch = await page.evaluate(() => {
      const host = window as typeof window & {
        __townSocket?: { epoch: number };
      };
      return host.__townSocket!.epoch;
    });
    expect((await serverStats(page, epoch)).producers).toBe(0);
  } finally {
    await context.close();
  }
});

test("preflight explains denied or missing devices and still allows entry without media", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      let failure = "NotAllowedError";
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("blocked by test", failure);
      };
      Object.assign(window, {
        __setPreflightFailure: (name: string) => {
          failure = name;
        },
      });
    });
    await instrument(page);
    await page.goto("/");
    await page
      .getByPlaceholder("이름이나 닉네임을 알려주세요")
      .fill("미디어 없이 입장");
    await page
      .getByRole("button", { name: "입장 전 마이크·카메라 확인" })
      .click();
    const dialog = page.getByRole("dialog", { name: "입장 전 장치 확인" });

    await dialog.getByRole("button", { name: "마이크 테스트" }).click();
    await expect(dialog.getByRole("alert")).toContainText("권한이 거부됐어요");
    await page.evaluate(() => {
      const host = window as typeof window & {
        __setPreflightFailure?: (name: string) => void;
      };
      host.__setPreflightFailure!("NotFoundError");
    });
    await dialog.getByRole("button", { name: "미리보기", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "사용할 수 있는 장치를 찾지 못했어요",
    );

    await dialog.getByRole("button", { name: "확인하고 입장" }).click();
    await expect(page.locator(".connection-status")).toHaveText("연결됨");
    await expect(page.getByTestId("call-status")).toHaveAttribute(
      "data-status",
      "ready",
    );
    const epoch = await page.evaluate(() => {
      const host = window as typeof window & {
        __townSocket?: { epoch: number };
      };
      return host.__townSocket!.epoch;
    });
    expect((await serverStats(page, epoch)).producers).toBe(0);
  } finally {
    await context.close();
  }
});

test("push to talk and device switching recover without dropping active media", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const tracks: MediaStreamTrack[] = [];
      const cameraTracks: MediaStreamTrack[] = [];
      const requests: MediaStreamConstraints[] = [];
      const devices = navigator.mediaDevices;
      const originalGetUserMedia = devices.getUserMedia.bind(devices);
      const originalEnumerateDevices = devices.enumerateDevices.bind(devices);
      const host = window as typeof window & {
        __townRejectInputDevice?: string;
      };
      devices.enumerateDevices = async () => [
        ...(await originalEnumerateDevices()),
        {
          deviceId: "ptt-mic-two",
          groupId: "ptt-mic-group",
          kind: "audioinput",
          label: "눌러 말하기 장치 2",
          toJSON: () => ({
            deviceId: "ptt-mic-two",
            groupId: "ptt-mic-group",
            kind: "audioinput",
            label: "눌러 말하기 장치 2",
          }),
        } as MediaDeviceInfo,
        {
          deviceId: "ptt-camera-two",
          groupId: "ptt-camera-group",
          kind: "videoinput",
          label: "눌러 말하기 카메라 2",
          toJSON: () => ({
            deviceId: "ptt-camera-two",
            groupId: "ptt-camera-group",
            kind: "videoinput",
            label: "눌러 말하기 카메라 2",
          }),
        } as MediaDeviceInfo,
      ];
      devices.getUserMedia = async (constraints = {}) => {
        requests.push(constraints);
        const mediaConstraints = constraints.audio
          ? constraints.audio
          : constraints.video;
        const requestedDevice =
          mediaConstraints && typeof mediaConstraints === "object"
            ? mediaConstraints.deviceId
            : undefined;
        const exactDeviceId =
          requestedDevice &&
          typeof requestedDevice === "object" &&
          !Array.isArray(requestedDevice)
            ? requestedDevice.exact
            : requestedDevice;
        if (
          host.__townRejectInputDevice &&
          host.__townRejectInputDevice === exactDeviceId
        )
          throw new DOMException(
            "Input device is unavailable",
            "NotFoundError",
          );
        const localOnlyConstraints = constraints.audio
          ? { audio: true, video: false }
          : constraints.video
            ? { audio: false, video: true }
            : constraints;
        const stream = await originalGetUserMedia(localOnlyConstraints);
        if (constraints.audio) {
          tracks.push(...stream.getAudioTracks());
          Object.assign(window, {
            __townPttTracks: tracks,
            __townPttRequests: requests,
          });
        }
        if (constraints.video) {
          cameraTracks.push(...stream.getVideoTracks());
          Object.assign(window, { __townPttCameraTracks: cameraTracks });
        }
        return stream;
      };
    });
    await instrument(page);
    const seen = await join(page, "눌러 말하기 테스트");
    await page
      .getByRole("button", { name: "눌러 말하기 켜기", exact: true })
      .click();
    const idleButton = page.getByRole("button", {
      name: "눌러 말하기. 버튼을 누르거나 V, Space 또는 Enter 키를 누르고 있으세요",
      exact: true,
    });
    const talkingButton = page.getByRole("button", {
      name: "눌러 말하기 전송 중. 놓으면 음소거",
      exact: true,
    });
    const microphoneEnabled = () =>
      page.evaluate(() => {
        const host = window as typeof window & {
          __townPttTracks?: MediaStreamTrack[];
        };
        return host.__townPttTracks?.at(-1)?.enabled ?? false;
      });
    await expect(idleButton).toHaveAttribute("aria-pressed", "false");
    await expect(idleButton).toHaveAttribute(
      "aria-keyshortcuts",
      "V Space Enter",
    );
    await expect.poll(microphoneEnabled).toBe(false);
    const toolbarA11y = await new AxeBuilder({ page })
      .include(".media-controls")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      toolbarA11y.violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      })),
      "미디어 조작 접근성 위반",
    ).toEqual([]);

    await page.getByRole("button", { name: "채팅 보기" }).click();
    const chatInput = page.getByRole("textbox", { name: "채팅 메시지" });
    await chatInput.click();
    await page.keyboard.down("KeyV");
    await expect(chatInput).toHaveValue("v");
    await expect(idleButton).toHaveAttribute("aria-pressed", "false");
    await expect.poll(microphoneEnabled).toBe(false);
    await page.keyboard.up("KeyV");
    await chatInput.fill("");

    await idleButton.focus();
    await page.keyboard.down("KeyV");
    await expect(talkingButton).toHaveAttribute("aria-pressed", "true");
    await expect.poll(microphoneEnabled).toBe(true);
    await page.keyboard.up("KeyV");
    await expect(idleButton).toHaveAttribute("aria-pressed", "false");
    await expect.poll(microphoneEnabled).toBe(false);

    await idleButton.focus();
    await page.keyboard.down("Space");
    await expect(talkingButton).toHaveAttribute("aria-pressed", "true");
    await expect.poll(microphoneEnabled).toBe(true);
    await page.keyboard.up("Space");
    await expect(idleButton).toHaveAttribute("aria-pressed", "false");
    await expect.poll(microphoneEnabled).toBe(false);

    await idleButton.focus();
    await page.keyboard.down("Enter");
    await expect(talkingButton).toHaveAttribute("aria-pressed", "true");
    await expect.poll(microphoneEnabled).toBe(true);
    await page.keyboard.up("Enter");
    await expect(idleButton).toHaveAttribute("aria-pressed", "false");
    await expect.poll(microphoneEnabled).toBe(false);

    await page.keyboard.down("KeyV");
    await expect(talkingButton).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(idleButton).toHaveAttribute("aria-pressed", "false");
    await expect.poll(microphoneEnabled).toBe(false);
    await page.keyboard.up("KeyV");

    await page.keyboard.down("KeyV");
    await expect(talkingButton).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(idleButton).toHaveAttribute("aria-pressed", "false");
    await expect.poll(microphoneEnabled).toBe(false);
    await page.keyboard.up("KeyV");

    await page.getByRole("button", { name: "장치 설정", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "마이크·카메라 설정" });
    const microphoneSelect = settings.getByLabel("마이크 장치");
    await expect(settings.getByRole("button", { name: "닫기" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(microphoneSelect).toBeFocused();
    const settingsA11y = await new AxeBuilder({ page })
      .include("dialog[open]")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      settingsA11y.violations.map((violation) => violation.id),
      "미디어 설정 접근성 위반",
    ).toEqual([]);
    await expect(
      microphoneSelect.locator('option[value="ptt-mic-two"]'),
    ).toHaveText("눌러 말하기 장치 2");
    const previousTrackState = () =>
      page.evaluate(() => {
        const host = window as typeof window & {
          __townPttTracks?: MediaStreamTrack[];
        };
        return host.__townPttTracks?.[0]?.readyState;
      });
    await page.evaluate(() => {
      (
        window as typeof window & { __townRejectInputDevice?: string }
      ).__townRejectInputDevice = "ptt-mic-two";
    });
    await microphoneSelect.selectOption("ptt-mic-two");
    await expect(microphoneSelect).toHaveValue("");
    await expect.poll(previousTrackState).toBe("live");
    await expect(settings.locator("[role=alert]")).toBeVisible();
    await page.evaluate(() => {
      (
        window as typeof window & { __townRejectInputDevice?: string }
      ).__townRejectInputDevice = undefined;
    });
    await microphoneSelect.selectOption("ptt-mic-two");
    await expect.poll(previousTrackState).toBe("ended");
    const replacement = await page.evaluate(() => {
      const host = window as typeof window & {
        __townPttTracks?: MediaStreamTrack[];
        __townPttRequests?: MediaStreamConstraints[];
      };
      const request = host.__townPttRequests?.at(-1);
      const audio = request?.audio;
      const deviceId =
        audio && typeof audio === "object" ? audio.deviceId : undefined;
      return {
        trackCount: host.__townPttTracks?.length ?? 0,
        enabled: host.__townPttTracks?.at(-1)?.enabled,
        deviceId:
          deviceId && typeof deviceId === "object" && !Array.isArray(deviceId)
            ? deviceId.exact
            : deviceId,
      };
    });
    expect(replacement).toEqual({
      trackCount: 2,
      enabled: false,
      deviceId: "ptt-mic-two",
    });

    await page.keyboard.press("Escape");
    await expect(settings).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "장치 설정", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "카메라 켜기", exact: true })
      .click();
    const previousCameraTrackState = () =>
      page.evaluate(() => {
        const host = window as typeof window & {
          __townPttCameraTracks?: MediaStreamTrack[];
        };
        return host.__townPttCameraTracks?.[0]?.readyState;
      });
    await expect.poll(previousCameraTrackState).toBe("live");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "장치 설정", exact: true }).click();
    const cameraSelect = settings.getByLabel("카메라 장치");
    await expect(
      cameraSelect.locator('option[value="ptt-camera-two"]'),
    ).toHaveText("눌러 말하기 카메라 2");
    await page.evaluate(() => {
      (
        window as typeof window & { __townRejectInputDevice?: string }
      ).__townRejectInputDevice = "ptt-camera-two";
    });
    await cameraSelect.selectOption("ptt-camera-two");
    await expect(cameraSelect).toHaveValue("");
    await expect.poll(previousCameraTrackState).toBe("live");
    await expect(settings.locator("[role=alert]")).toBeVisible();
    await page.evaluate(() => {
      (
        window as typeof window & { __townRejectInputDevice?: string }
      ).__townRejectInputDevice = undefined;
    });
    await cameraSelect.selectOption("ptt-camera-two");
    await expect.poll(previousCameraTrackState).toBe("ended");
    await expect(cameraSelect).toHaveValue("ptt-camera-two");
    await page.keyboard.press("Escape");
    await expect(settings).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "장치 설정", exact: true }),
    ).toBeFocused();

    await idleButton.hover();
    await page.mouse.down();
    await expect(talkingButton).toHaveAttribute("aria-pressed", "true");
    await expect.poll(microphoneEnabled).toBe(true);
    await page.mouse.up();
    await expect(idleButton).toHaveAttribute("aria-pressed", "false");
    await expect.poll(microphoneEnabled).toBe(false);
    await page
      .getByRole("button", { name: "눌러 말하기 끄기", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const host = window as typeof window & {
            __townPttTracks?: MediaStreamTrack[];
          };
          return host.__townPttTracks?.at(-1)?.readyState;
        }),
      )
      .toBe("ended");
    expect(seen.errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("real SFU carries microphone, camera and shared-screen RTP, then revokes distant receivers and cleans up on leave", async ({
  browser,
}, testInfo) => {
  test.setTimeout(210_000);
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({
        permissions: ["microphone", "camera"],
        viewport: { width: 960, height: 720 },
      }),
    ),
  );
  try {
    const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
    const [alice, bob] = await Promise.all([
      join(a, "미디어 테스트 A"),
      join(b, "미디어 테스트 B"),
    ]);
    await expect.poll(() => bob.media?.peers.length).toBe(1);
    await expect(b.locator(".event-controls")).toHaveCount(0);
    await b.getByRole("button", { name: "참가자 보기" }).click();
    const aliceParticipant = b
      .locator(".participant")
      .filter({ hasText: "미디어 테스트 A" });
    await expect(
      aliceParticipant.getByRole("button", {
        name: "미디어 테스트 A님 프로필 보기 · 마이크 꺼짐",
      }),
    ).toBeVisible();
    await expect(
      aliceParticipant.locator(".participant-microphone"),
    ).toHaveClass(/is-off/);
    const status = b.locator(".call-status");
    const statusFontSize = await status.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).fontSize),
    );
    expect(statusFontSize).toBeGreaterThanOrEqual(13);
    await status.getByRole("button", { name: "사람별 음량" }).click();
    const volumeDialog = b.getByRole("dialog", { name: "사람별 대화 음량" });
    await expect(
      volumeDialog.getByText("미디어 테스트 A", { exact: true }),
    ).toBeVisible();
    await volumeDialog.getByRole("button", { name: "닫기" }).click();
    await expect.poll(() => alice.media?.peers.length).toBe(1);
    await a.getByRole("button", { name: "마이크 켜기", exact: true }).click();
    await expect(
      a.getByRole("button", { name: "마이크 끄기", exact: true }),
    ).toBeEnabled();
    await expect(
      b.getByRole("button", {
        name: "미디어 테스트 A님 프로필 보기 · 마이크 켜짐",
      }),
    ).toBeVisible();
    await expect(
      aliceParticipant.locator(".participant-microphone"),
    ).toHaveClass(/is-on/);
    await a.getByRole("button", { name: "마이크 끄기", exact: true }).click();
    await expect(
      b.getByRole("button", {
        name: "미디어 테스트 A님 프로필 보기 · 마이크 꺼짐",
      }),
    ).toBeVisible();
    await expect(
      aliceParticipant.locator(".participant-microphone"),
    ).toHaveClass(/is-off/);
    await a.getByRole("button", { name: "마이크 켜기", exact: true }).click();
    await expect(
      b.getByRole("button", {
        name: "미디어 테스트 A님 프로필 보기 · 마이크 켜짐",
      }),
    ).toBeVisible();
    await b.getByRole("button", { name: "참가자 보기" }).click();
    await a.getByRole("button", { name: "카메라 켜기", exact: true }).click();
    await a
      .getByRole("button", { name: "화면 공유 시작", exact: true })
      .click();
    await expect
      .poll(() => bob.media?.offers.map((o) => o.source).sort(), {
        timeout: 20_000,
        message: JSON.stringify(alice.replies),
      })
      .toEqual(["CAMERA", "MICROPHONE", "SCREEN", "SCREEN_AUDIO"]);
    if (process.env.TOWN_E2E_TURN === "true") {
      try {
        await expect
          .poll(() => hasConnectedRelayPeer(a), { timeout: 20_000 })
          .toBe(true);
      } catch (error) {
        console.error(
          "TURN ICE diagnostics:",
          JSON.stringify(await turnDiagnostics(a)),
        );
        throw error;
      }
      await expect
        .poll(() => hasConnectedRelayPeer(b), { timeout: 20_000 })
        .toBe(true);
    }
    await expect(
      b.getByLabel("미디어 테스트 A 카메라", { exact: true }),
    ).toBeVisible();
    const sharedScreen = b.getByRole("region", { name: "공유 화면" });
    await expect(sharedScreen).toContainText("미디어 테스트 A님의 화면");
    const screenHeadingFontSize = await sharedScreen
      .locator(".floating-panel-heading")
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    expect(screenHeadingFontSize).toBeGreaterThanOrEqual(14);
    await expect(b.locator('audio[data-source="MICROPHONE"]')).toHaveCount(1);
    await expect(b.locator('audio[data-source="SCREEN_AUDIO"]')).toHaveCount(1);
    const screenVolume = sharedScreen.locator(
      ".screen-audio-volume input[type=range]",
    );
    await screenVolume.focus();
    await screenVolume.press("Home");
    await expect(
      sharedScreen.locator(".screen-audio-volume output"),
    ).toHaveText("0%");
    await expect
      .poll(() =>
        b
          .locator('audio[data-source="SCREEN_AUDIO"]')
          .evaluate((element: HTMLAudioElement) => element.volume),
      )
      .toBe(0);
    await screenVolume.press("End");
    await expect(
      sharedScreen.locator(".screen-audio-volume output"),
    ).toHaveText("100%");
    await expect
      .poll(() =>
        b
          .locator('audio[data-source="SCREEN_AUDIO"]')
          .evaluate((element: HTMLAudioElement) => element.volume),
      )
      .toBe(1);

    const screenFrameBeforeDrag = await sharedScreen.boundingBox();
    const screenHeading = sharedScreen.locator(".floating-panel-heading");
    const screenHeadingBox = await screenHeading.boundingBox();
    expect(screenFrameBeforeDrag).not.toBeNull();
    expect(screenHeadingBox).not.toBeNull();
    await b.mouse.move(screenHeadingBox!.x + 20, screenHeadingBox!.y + 20);
    await b.mouse.down();
    await b.mouse.move(screenHeadingBox!.x + 4, screenHeadingBox!.y + 52, {
      steps: 4,
    });
    await b.mouse.up();
    const screenFrameAfterDrag = await sharedScreen.boundingBox();
    expect(screenFrameAfterDrag!.x).toBeLessThan(screenFrameBeforeDrag!.x - 8);
    expect(screenFrameAfterDrag!.y).toBeGreaterThan(
      screenFrameBeforeDrag!.y + 20,
    );

    const screenFrameBeforeResize = await sharedScreen.boundingBox();
    const screenResizeHandle = sharedScreen.getByRole("button", {
      name: "공유 화면 창 크기 조절",
    });
    const screenResizeBox = await screenResizeHandle.boundingBox();
    expect(screenResizeBox).not.toBeNull();
    await b.mouse.move(
      screenResizeBox!.x + screenResizeBox!.width / 2,
      screenResizeBox!.y + screenResizeBox!.height / 2,
    );
    await b.mouse.down();
    await b.mouse.move(
      screenResizeBox!.x + screenResizeBox!.width / 2 + 40,
      screenResizeBox!.y + screenResizeBox!.height / 2 + 32,
      { steps: 4 },
    );
    await b.mouse.up();
    const screenFrameAfterResize = await sharedScreen.boundingBox();
    expect(screenFrameAfterResize!.width).toBeGreaterThan(
      screenFrameBeforeResize!.width + 24,
    );
    expect(screenFrameAfterResize!.height).toBeGreaterThan(
      screenFrameBeforeResize!.height + 16,
    );

    const screenFrameBeforeKeyboardMove = await sharedScreen.boundingBox();
    await screenHeading.focus();
    await screenHeading.press("ArrowRight");
    const screenFrameAfterKeyboardMove = await sharedScreen.boundingBox();
    expect(screenFrameAfterKeyboardMove!.x).toBeGreaterThan(
      screenFrameBeforeKeyboardMove!.x + 12,
    );
    const screenFrameBeforeKeyboardResize = await sharedScreen.boundingBox();
    await screenResizeHandle.focus();
    await screenResizeHandle.press("ArrowRight");
    const screenFrameAfterKeyboardResize = await sharedScreen.boundingBox();
    expect(screenFrameAfterKeyboardResize!.width).toBeGreaterThanOrEqual(
      screenFrameBeforeKeyboardResize!.width + 15,
    );

    await expect
      .poll(async () => (await inbound(b)).audio, { timeout: 20_000 })
      .toBeGreaterThan(1000);
    await expect
      .poll(async () => (await inbound(b)).video)
      .toBeGreaterThan(5000);
    await b.getByRole("button", { name: "카메라 켜기", exact: true }).click();
    await expect
      .poll(() =>
        alice.media?.offers.some((offer) => offer.source === "CAMERA"),
      )
      .toBe(true);
    const viewInvariant = {
      kind: bob.media!.kind,
      policyEpoch: bob.media!.policyEpoch,
      peers: [...bob.media!.peers].sort(),
      offers: bob
        .media!.offers.map((offer) => `${offer.playerId}:${offer.source}`)
        .sort(),
      position: await b.evaluate(() => {
        const position = (
          window as unknown as {
            __townSocket: { position: { x: number; y: number } };
          }
        ).__townSocket.position;
        return { x: position.x, y: position.y };
      }),
    };
    await b.getByRole("button", { name: "카메라 갤러리 보기" }).click();
    const cameraGallery = b.getByLabel("카메라 갤러리");
    await expect(cameraGallery).toBeVisible();
    const floatingMediaA11y = await new AxeBuilder({ page: b })
      .include(".shared-screen")
      .include(".camera-stage")
      .analyze();
    expect(
      floatingMediaA11y.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map(({ target }) => target),
      })),
      "카메라·화면공유 창 접근성 위반",
    ).toEqual([]);
    const cameraHeadingFontSize = await cameraGallery
      .locator(".camera-stage-heading")
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    expect(cameraHeadingFontSize).toBeGreaterThanOrEqual(13);
    const cameraPin = cameraGallery.getByRole("button", {
      name: "미디어 테스트 A 화면 고정",
    });
    const cameraPinBox = await cameraPin.boundingBox();
    expect(cameraPinBox?.width).toBeGreaterThanOrEqual(32);
    expect(cameraPinBox?.height).toBeGreaterThanOrEqual(32);
    await cameraPin.click();
    await expect(
      cameraGallery.getByRole("button", {
        name: "미디어 테스트 A 화면 고정 해제",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await sharedScreen.getByRole("button", { name: "공유 화면 고정" }).click();
    await expect(
      sharedScreen.getByRole("button", { name: "공유 화면 고정 해제" }),
    ).toHaveAttribute("aria-pressed", "true");
    await sharedScreen.getByRole("button", { name: "공유 화면 확대" }).click();
    await expect(sharedScreen).toHaveClass(/expanded/);
    await expect.poll(() => bob.media?.kind).toBe(viewInvariant.kind);
    expect(bob.media!.policyEpoch).toBe(viewInvariant.policyEpoch);
    expect([...bob.media!.peers].sort()).toEqual(viewInvariant.peers);
    expect(
      bob
        .media!.offers.map((offer) => `${offer.playerId}:${offer.source}`)
        .sort(),
    ).toEqual(viewInvariant.offers);
    expect(
      await b.evaluate(() => {
        const position = (
          window as unknown as {
            __townSocket: { position: { x: number; y: number } };
          }
        ).__townSocket.position;
        return { x: position.x, y: position.y };
      }),
    ).toEqual(viewInvariant.position);
    await b.getByRole("button", { name: "공유 화면 축소" }).click();
    await sharedScreen
      .getByRole("button", { name: "공유 화면 고정 해제" })
      .click();

    const cameraFrameBeforeDrag = await cameraGallery.boundingBox();
    const cameraHeading = cameraGallery.locator(".floating-panel-heading");
    const cameraHeadingBox = await cameraHeading.boundingBox();
    expect(cameraFrameBeforeDrag).not.toBeNull();
    expect(cameraHeadingBox).not.toBeNull();
    await b.mouse.move(cameraHeadingBox!.x + 20, cameraHeadingBox!.y + 15);
    await b.mouse.down();
    await b.mouse.move(cameraHeadingBox!.x - 20, cameraHeadingBox!.y + 43, {
      steps: 4,
    });
    await b.mouse.up();
    const cameraFrameAfterDrag = await cameraGallery.boundingBox();
    expect(cameraFrameAfterDrag!.x).toBeLessThan(cameraFrameBeforeDrag!.x - 24);
    expect(cameraFrameAfterDrag!.y).toBeGreaterThan(
      cameraFrameBeforeDrag!.y + 16,
    );
    const cameraFrameBeforeResize = await cameraGallery.boundingBox();
    const cameraResizeHandle = cameraGallery.getByRole("button", {
      name: "대화 카메라 창 크기 조절",
    });
    const cameraResizeBox = await cameraResizeHandle.boundingBox();
    expect(cameraResizeBox).not.toBeNull();
    await b.mouse.move(
      cameraResizeBox!.x + cameraResizeBox!.width / 2,
      cameraResizeBox!.y + cameraResizeBox!.height / 2,
    );
    await b.mouse.down();
    await b.mouse.move(
      cameraResizeBox!.x + cameraResizeBox!.width / 2 + 40,
      cameraResizeBox!.y + cameraResizeBox!.height / 2 + 32,
      { steps: 4 },
    );
    await b.mouse.up();
    const cameraFrameAfterResize = await cameraGallery.boundingBox();
    expect(cameraFrameAfterResize!.width).toBeGreaterThan(
      cameraFrameBeforeResize!.width + 24,
    );
    expect(cameraFrameAfterResize!.height).toBeGreaterThan(
      cameraFrameBeforeResize!.height + 16,
    );

    const cameraFrameBeforeKeyboardMove = await cameraGallery.boundingBox();
    await cameraHeading.focus();
    await cameraHeading.press("ArrowUp");
    const cameraFrameAfterKeyboardMove = await cameraGallery.boundingBox();
    expect(cameraFrameAfterKeyboardMove!.y).toBeLessThan(
      cameraFrameBeforeKeyboardMove!.y - 12,
    );
    const cameraFrameBeforeKeyboardResize = await cameraGallery.boundingBox();
    await cameraResizeHandle.focus();
    await cameraResizeHandle.press("ArrowDown");
    const cameraFrameAfterKeyboardResize = await cameraGallery.boundingBox();
    expect(cameraFrameAfterKeyboardResize!.height).toBeGreaterThanOrEqual(
      cameraFrameBeforeKeyboardResize!.height + 15,
    );
    await b.getByRole("button", { name: "카메라 목록 보기" }).click();
    if (process.env.TOWN_E2E_TURN === "true") {
      const aCursor = await turnStateEventCount(a);
      const bCursor = await turnStateEventCount(b);
      let aRecoveryCursor = 0;
      let bRecoveryCursor = 0;
      controlTurnRelay(true);
      try {
        await expect
          .poll(() => turnInterruptedAfter(a, aCursor), { timeout: 45_000 })
          .toBe(true);
        await expect
          .poll(() => turnInterruptedAfter(b, bCursor), { timeout: 45_000 })
          .toBe(true);
        // Let the controller's five-second disconnect grace period expire while TURN is down.
        await a.waitForTimeout(7_000);
      } finally {
        aRecoveryCursor = await turnStateEventCount(a);
        bRecoveryCursor = await turnStateEventCount(b);
        controlTurnRelay(false);
      }
      await expect
        .poll(() => turnConnectedAfter(a, aRecoveryCursor), {
          timeout: 60_000,
        })
        .toBe(true);
      await expect
        .poll(() => turnConnectedAfter(b, bRecoveryCursor), {
          timeout: 60_000,
        })
        .toBe(true);
      await expect(a.getByTestId("call-status")).toHaveAttribute(
        "data-status",
        "ready",
        { timeout: 60_000 },
      );
      await expect(b.getByTestId("call-status")).toHaveAttribute(
        "data-status",
        "ready",
        { timeout: 60_000 },
      );
      await expect
        .poll(() => hasConnectedRelayPeer(a), { timeout: 60_000 })
        .toBe(true);
      await expect
        .poll(() => hasConnectedRelayPeer(b), { timeout: 60_000 })
        .toBe(true);
      await expect
        .poll(() => bob.media?.offers.map((o) => o.source).sort(), {
          timeout: 60_000,
        })
        .toEqual(["CAMERA", "MICROPHONE"]);
      const resumedStart = await inbound(b);
      await expect
        .poll(async () => (await inbound(b)).audio, { timeout: 20_000 })
        .toBeGreaterThan(resumedStart.audio);
      await expect
        .poll(async () => (await inbound(b)).video, { timeout: 20_000 })
        .toBeGreaterThan(resumedStart.video);
      // Screen sharing requires a fresh user action after transport recovery.
      await expect(
        a.getByRole("button", { name: "화면 공유 시작", exact: true }),
      ).toBeEnabled();
      await a
        .getByRole("button", { name: "화면 공유 시작", exact: true })
        .click();
      await expect
        .poll(() => bob.media?.offers.map((o) => o.source).sort(), {
          timeout: 20_000,
        })
        .toEqual(["CAMERA", "MICROPHONE", "SCREEN", "SCREEN_AUDIO"]);
    }
    await a.evaluate(() => {
      const host = window as typeof window & {
        __townSyntheticScreenTracks?: MediaStreamTrack[];
      };
      host.__townSyntheticScreenTracks
        ?.at(-1)
        ?.dispatchEvent(new Event("ended"));
    });
    await expect
      .poll(() => bob.media?.offers.map((o) => o.source).sort())
      .toEqual(["CAMERA", "MICROPHONE"]);
    await expect(b.getByRole("region", { name: "공유 화면" })).toHaveCount(0);
    await expect(b.locator('audio[data-source="SCREEN_AUDIO"]')).toHaveCount(0);
    await a.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        throw new DOMException("Permission denied", "NotAllowedError");
      };
    });
    await a
      .getByRole("button", { name: "화면 공유 시작", exact: true })
      .click();
    await expect(a.locator(".call-error")).toContainText(
      "화면 공유 권한이 거부됐어요",
    );
    await expect(
      a.getByRole("button", { name: "화면 공유 시작", exact: true }),
    ).toBeEnabled();
    const before = await inbound(b);
    await b.screenshot({ path: testInfo.outputPath("media-connected.png") });
    // Walk around the desk into the central aisle before crossing the distance threshold.
    await walk(b, bob, "x", 26.95);
    await walk(b, bob, "y", 20.5);
    await expect.poll(() => bob.media?.offers.length).toBe(0);
    await expect(b.locator(".world-stage audio[data-source]")).toHaveCount(0);
    await expect(b.getByRole("region", { name: "공유 화면" })).toHaveCount(0);
    // Allow queued packets to drain, then prove no additional RTP arrives.
    await b.waitForTimeout(700);
    const stopped = await inbound(b);
    await b.waitForTimeout(1000);
    const rangeAfter = await inbound(b);
    expect(rangeAfter.frames).toBe(stopped.frames);
    expect(rangeAfter.samples).toBe(stopped.samples);
    expect((await serverStats(b, bob.media!.policyEpoch)).consumers).toEqual(
      [],
    );
    await a.getByRole("button", { name: "장치 설정", exact: true }).click();
    await expect(a.getByRole("dialog")).toBeVisible();
    await expect(a.getByLabel("마이크 장치")).toBeVisible();
    await expect(a.getByLabel("마이크 입력 수준")).toBeVisible();
    await a.getByRole("button", { name: "닫기", exact: true }).click();
    await a.getByRole("button", { name: "나가기", exact: true }).click();
    await expect.poll(async () => (await inbound(a)).open).toBe(0);
    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
    await testInfo.attach("RTP evidence", {
      body: JSON.stringify(
        {
          receivedBeforeRangeExit: before,
          receivedAfterRangeExit: await inbound(b),
          errors: [...alice.errors, ...bob.errors],
          replies: [...alice.replies, ...bob.replies],
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test("a screen source restriction stops shared video and audio together", async ({
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
    const [a, b] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    await Promise.all([join(a, "화면 제한 A"), join(b, "화면 제한 B")]);
    await a
      .getByRole("button", { name: "화면 공유 시작", exact: true })
      .click();
    await expect(
      b.getByRole("region", { name: "공유 화면", exact: true }),
    ).toBeVisible();
    await expect(b.locator('audio[data-source="SCREEN_AUDIO"]')).toHaveCount(1);
    await expect
      .poll(async () => (await inbound(b)).audio, { timeout: 20_000 })
      .toBeGreaterThan(1000);
    await expect
      .poll(async () => (await inbound(b)).video, { timeout: 20_000 })
      .toBeGreaterThan(5000);

    const epoch = await a.evaluate(() => {
      const host = window as typeof window & {
        __townLastMediaState?: { policyEpoch: number };
      };
      const policyEpoch = host.__townLastMediaState?.policyEpoch;
      if (policyEpoch === undefined) throw new Error("Media state is missing.");
      const socket = (window as typeof window & { __townSocket: WebSocket })
        .__townSocket;
      const restricted = {
        ...host.__townLastMediaState,
        moderatedSources: ["SCREEN"],
      };
      socket.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(restricted) }),
      );
      return policyEpoch;
    });
    await expect
      .poll(() =>
        a.evaluate(() => {
          const host = window as typeof window & {
            __townSyntheticScreenTracks?: MediaStreamTrack[];
            __townSyntheticScreenAudioTracks?: MediaStreamTrack[];
          };
          return [
            host.__townSyntheticScreenTracks?.at(-1)?.readyState,
            host.__townSyntheticScreenAudioTracks?.at(-1)?.readyState,
          ];
        }),
      )
      .toEqual(["ended", "ended"]);
    await expect(
      b.getByRole("region", { name: "공유 화면", exact: true }),
    ).toHaveCount(0);
    await expect(b.locator('audio[data-source="SCREEN_AUDIO"]')).toHaveCount(0);
    await expect
      .poll(async () => (await serverStats(a, epoch)).producers)
      .toBe(0);

    await a.evaluate(() => {
      const host = window as typeof window & {
        __townLastMediaState?: Record<string, unknown>;
        __townSocket: WebSocket;
      };
      host.__townSocket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            ...host.__townLastMediaState,
            moderatedSources: [],
          }),
        }),
      );
    });
    const shareButton = a.getByRole("button", {
      name: "화면 공유 시작",
      exact: true,
    });
    await expect(shareButton).toBeVisible();
    await expect(shareButton).toBeEnabled();
    await shareButton.click();
    await expect(
      b.getByRole("region", { name: "공유 화면", exact: true }),
    ).toBeVisible();
    await expect(b.locator('audio[data-source="SCREEN_AUDIO"]')).toHaveCount(1);
    await a.evaluate(() => {
      const socket = (window as typeof window & { __townSocket: WebSocket })
        .__townSocket;
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "error",
            code: "MODERATION_KICKED",
            message: "운영 조치로 입장을 종료했어요.",
          }),
        }),
      );
    });
    await expect
      .poll(() =>
        a.evaluate(() => {
          const host = window as typeof window & {
            __townSyntheticScreenTracks?: MediaStreamTrack[];
            __townSyntheticScreenAudioTracks?: MediaStreamTrack[];
          };
          return [
            host.__townSyntheticScreenTracks?.at(-1)?.readyState,
            host.__townSyntheticScreenAudioTracks?.at(-1)?.readyState,
          ];
        }),
      )
      .toEqual(["ended", "ended"]);
    await expect(
      b.getByRole("region", { name: "공유 화면", exact: true }),
    ).toHaveCount(0);
    await expect(b.locator('audio[data-source="SCREEN_AUDIO"]')).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

async function walk(
  page: Page,
  _seen: Awaited<ReturnType<typeof join>>,
  axis: "x" | "y",
  target: number,
) {
  const position = await page.evaluate(
    ({ axis, target }) =>
      (
        window as unknown as {
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

test("a locked private room admits a guest only after the host approves their knock", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({
        permissions: ["microphone", "camera"],
        viewport: { width: 960, height: 720 },
      }),
    ),
  );
  try {
    const [hostPage, guestPage] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const [host, guest] = await Promise.all([
      join(hostPage, "회의 운영자"),
      join(guestPage, "회의 입장자"),
    ]);
    await Promise.all(
      [hostPage, guestPage].map(async (page, index) => {
        const seen = index === 0 ? host : guest;
        await walk(page, seen, "x", 26.95);
        await walk(page, seen, "y", 13.45);
        await walk(page, seen, "x", 7.6);
      }),
    );

    await walk(hostPage, host, "y", 11.7);
    await expect.poll(() => host.media?.kind).toBe("PRIVATE");
    const hostId = host.welcome!.playerId;
    const roomId = () =>
      host.snapshot?.rooms.find((room) => room.hostPlayerId === hostId)?.zoneId;
    await expect.poll(roomId).not.toBeUndefined();
    const roomControls = hostPage.getByLabel("회의실 설정");
    await expect(roomControls).toBeVisible();
    await hostPage
      .getByRole("button", { name: "마이크 켜기", exact: true })
      .click();
    await hostPage
      .getByRole("button", { name: "카메라 켜기", exact: true })
      .click();
    await expect(
      hostPage.getByRole("button", { name: "마이크 끄기", exact: true }),
    ).toBeVisible();
    await expect(
      hostPage.getByRole("button", { name: "카메라 끄기", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        guest.media?.offers.some((offer) => offer.playerId === hostId),
      )
      .toBe(false);
    await roomControls.getByRole("button", { name: "회의실 잠그기" }).click();
    await expect(
      roomControls.getByRole("button", { name: "잠금 해제" }),
    ).toBeVisible();

    await guestPage.evaluate(() =>
      (
        window as unknown as {
          __townSocket: {
            walk(axis: "x" | "y", target: number): Promise<number>;
          };
        }
      ).__townSocket.walk("y", 11.7),
    );
    await expect(
      guestPage.getByText("회의실 호스트에게 입장 노크를 보냈어요."),
    ).toBeVisible();
    await expect.poll(() => guest.media?.kind).not.toBe("PRIVATE");
    await expect(guestPage.getByLabel("회의실 설정")).toHaveCount(0);
    await expect(
      roomControls.getByText("회의 입장자님이 입장을 요청했어요"),
    ).toBeVisible();

    await roomControls.getByRole("button", { name: "승인" }).click();
    await expect(
      guestPage.getByText("입장이 승인됐어요. 문 쪽으로 이동해 주세요."),
    ).toBeVisible();
    await guestPage.evaluate(() =>
      (
        window as unknown as {
          __townSocket: {
            walk(axis: "x" | "y", target: number): Promise<number>;
          };
        }
      ).__townSocket.walk("y", 11.7),
    );
    await expect
      .poll(() => guest.media?.kind, { timeout: 15_000 })
      .toBe("PRIVATE");
    const guestRoomControls = guestPage.getByLabel("회의실 설정");
    await expect(guestRoomControls).toBeVisible();
    await expect(guestRoomControls).toContainText("2/12명");
    await expect.poll(() => guest.media?.peers).toContain(hostId);
    await expect
      .poll(() =>
        guest.media?.offers
          .filter((offer) => offer.playerId === hostId)
          .map((offer) => offer.source)
          .sort(),
      )
      .toEqual(["CAMERA", "MICROPHONE"]);
    await expect
      .poll(async () => (await inbound(guestPage)).audio, { timeout: 20_000 })
      .toBeGreaterThan(2000);
    await expect
      .poll(async () => (await inbound(guestPage)).video, { timeout: 20_000 })
      .toBeGreaterThan(5000);
    const oldHostEpoch = host.media!.policyEpoch;
    await hostPage.evaluate(() =>
      (window as unknown as { __townSocket: WebSocket }).__townSocket.close(),
    );
    await expect
      .poll(() =>
        hostPage.evaluate(
          () =>
            (window as unknown as { __townSocket: WebSocket }).__townSocket
              .readyState === WebSocket.OPEN,
        ),
      )
      .toBe(true);
    await expect.poll(() => host.welcome?.playerId).toBe(hostId);
    await expect
      .poll(() => host.media?.kind === "PRIVATE" && host.media.available)
      .toBe(true);
    expect(host.media!.policyEpoch).toBeGreaterThanOrEqual(oldHostEpoch);
    await expect(hostPage.getByTestId("call-status")).toHaveAttribute(
      "data-status",
      "ready",
    );
    await expect
      .poll(() =>
        guest.media?.offers
          .filter((offer) => offer.playerId === hostId)
          .map((offer) => offer.source)
          .sort(),
      )
      .toEqual(["CAMERA", "MICROPHONE"]);
    await expect
      .poll(async () => (await inbound(guestPage)).audio, { timeout: 20_000 })
      .toBeGreaterThan(2000);
    const successorControls = guestPage.getByLabel("회의실 설정");
    await expect(
      successorControls.getByRole("button", { name: "잠금 해제" }),
    ).toBeVisible();
    await expect(
      roomControls.getByRole("button", { name: "잠금 해제" }),
    ).toHaveCount(0);
    await successorControls
      .getByRole("button", {
        name: "회의 운영자님을 회의실에서 내보내기",
      })
      .click();
    await expect(hostPage.getByLabel("회의실 설정")).toHaveCount(0);
    await expect.poll(() => host.media?.kind).not.toBe("PRIVATE");
    await expect
      .poll(() =>
        guest.media?.offers.some((offer) => offer.playerId === hostId),
      )
      .toBe(false);
    await expect.poll(() => guest.media?.peers).not.toContain(hostId);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("recording waits for every consent and finalizes a playable file containing only the selected source", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  recordingContainer();
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({
        permissions: ["microphone", "camera"],
        viewport: { width: 960, height: 720 },
      }),
    ),
  );
  try {
    const [hostPage, guestPage] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const [host, guest] = await Promise.all([
      join(hostPage, "녹화 회의 운영자", "preview-recording-host"),
      join(guestPage, "녹화 회의 참가자", "preview-recording-guest"),
    ]);

    await Promise.all(
      [hostPage, guestPage].map(async (page, index) => {
        const peer = index === 0 ? host : guest;
        await walk(page, peer, "x", 26.95);
        await walk(page, peer, "y", 13.45);
        await walk(page, peer, "x", 7.6);
      }),
    );
    await walk(hostPage, host, "y", 11.7);
    await expect.poll(() => host.media?.kind).toBe("PRIVATE");
    await walk(guestPage, guest, "y", 11.7);
    await expect.poll(() => guest.media?.kind).toBe("PRIVATE");

    for (const page of [hostPage, guestPage]) {
      await page
        .getByRole("button", { name: "마이크 켜기", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "마이크 끄기", exact: true }),
      ).toBeVisible();
    }
    await expect
      .poll(
        async () =>
          (await serverStats(hostPage, host.media!.policyEpoch)).producers,
      )
      .toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          (await serverStats(guestPage, guest.media!.policyEpoch)).producers,
      )
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await inbound(guestPage)).audio, { timeout: 20_000 })
      .toBeGreaterThan(2000);

    await hostPage.getByRole("button", { name: "새 녹화 요청" }).click();
    await hostPage
      .locator(".room-recording-source-option")
      .filter({ hasText: "마이크" })
      .locator("input")
      .check();
    await hostPage.getByRole("button", { name: "참가자 동의 요청" }).click();
    await expect
      .poll(() => host.recording?.status, {
        message: JSON.stringify({
          acks: host.recordingAcks,
          wireErrors: host.wireErrors,
          sent: host.sentMessages.filter(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "roomRecordingRequest",
          ),
        }),
      })
      .toBe("AWAITING_CONSENT");
    const recordingId = host.recording!.recordingId;
    expect(host.recording!.sources).toEqual(["MICROPHONE"]);
    expect(readRecordingArtifact(recordingId)).toBeNull();

    await hostPage.getByRole("button", { name: "동의하고 녹화 허용" }).click();
    await expect
      .poll(
        () =>
          host.recording?.participants.filter(
            (participant) => participant.decision === "ACCEPTED",
          ).length,
      )
      .toBe(1);
    expect(readRecordingArtifact(recordingId)).toBeNull();

    await guestPage.getByRole("button", { name: "동의하고 녹화 허용" }).click();
    await expect
      .poll(() => host.recording?.status, {
        message: JSON.stringify({
          hostRecording: host.recording,
          hostAcks: host.recordingAcks,
          guestRecording: guest.recording,
          guestAcks: guest.recordingAcks,
        }),
      })
      .toBe("RECORDING");
    await expect.poll(() => guest.recording?.status).toBe("RECORDING");
    await hostPage.waitForTimeout(2_500);

    await hostPage.getByRole("button", { name: "녹화 중지" }).click();
    await expect.poll(() => host.recording?.status).toBe("STOPPED");
    await expect
      .poll(() => readRecordingArtifact(recordingId)?.manifest.status)
      .toBe("STOPPED");

    const artifact = readRecordingArtifact(recordingId)!;
    expect(artifact.manifest.sources).toEqual(["MICROPHONE"]);
    expect(artifact.manifest.retentionDays).toBe(30);
    expect(artifact.manifest.retentionExpiresAt).toBeGreaterThan(Date.now());
    expect(artifact.tracks.length).toBeGreaterThan(0);
    expect(
      artifact.tracks.some(
        (track) => track.rtpPackets > 0 && track.rtpBytes > 0,
      ),
      JSON.stringify(artifact.tracks),
    ).toBe(true);
    for (const track of artifact.tracks) {
      expect(track.source).toBe("MICROPHONE");
      expect(track.status).toBe("FINALIZED");
      expect(track.rtpPackets).toBeGreaterThan(0);
      expect(track.rtpBytes).toBeGreaterThan(0);
      expect(track.bytes).toBeGreaterThan(0);
      expect(track.fileBytes).toBe(track.bytes);
      expect(track.sha256).toMatch(/^[0-9a-f]{64}$/);
      const probe = probeRecordingTrack(recordingId, track.fileKey);
      expect(probe.format.format_name).toMatch(/webm/);
      expect(Number(probe.format.duration)).toBeGreaterThan(0);
    }
    expect([...host.errors, ...guest.errors]).toEqual([]);
    await testInfo.attach("recording manifest summary", {
      body: JSON.stringify(
        {
          status: artifact.manifest.status,
          sources: artifact.manifest.sources,
          retentionDays: artifact.manifest.retentionDays,
          tracks: artifact.tracks.map(
            ({ source, bytes, rtpPackets, rtpBytes, status }) => ({
              source,
              bytes,
              rtpPackets,
              rtpBytes,
              status,
            }),
          ),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("twelve nearby participants keep a two-way microphone RTP link", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const contexts = await Promise.all(
    Array.from({ length: 12 }, () =>
      browser.newContext({
        permissions: ["microphone", "camera"],
        viewport: { width: 960, height: 720 },
      }),
    ),
  );
  await Promise.all(contexts.map(enableRtcCapacityRenderingMode));
  try {
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const peers: Awaited<ReturnType<typeof join>>[] = [];
    for (const [index, page] of pages.entries()) {
      peers.push(await join(page, `양방향 통화 ${index + 1}`, "", false));
    }
    await expectRtcCapacityRenderingMode(pages);
    expect(new Set(peers.map((peer) => peer.welcome!.playerId)).size).toBe(12);
    const first = pages[0];
    const last = pages.at(-1)!;
    const activePeers = [peers[0], peers.at(-1)!];
    await first
      .getByRole("button", { name: "마이크 켜기", exact: true })
      .click();
    await last
      .getByRole("button", { name: "마이크 켜기", exact: true })
      .click();
    await Promise.all(
      activePeers.map(async (peer) => {
        await expect
          .poll(
            () =>
              peer.media?.offers.filter((offer) => offer.kind === "audio")
                .length,
            { timeout: 30_000 },
          )
          .toBe(1);
      }),
    );
    const inboundAudio = await Promise.all(
      [first, last].map(async (page) => {
        await expect
          .poll(async () => (await inbound(page)).audio, { timeout: 30_000 })
          .toBeGreaterThan(5000);
        return (await inbound(page)).audio;
      }),
    );
    const serverMedia = await serverStats(
      pages[0],
      peers[0].media!.policyEpoch,
    );
    expect(serverMedia.producers).toBe(1);
    const inboundAudioConsumers = serverMedia.consumers.filter(
      (consumer) =>
        typeof consumer === "object" &&
        consumer !== null &&
        "kind" in consumer &&
        consumer.kind === "audio" &&
        "type" in consumer &&
        consumer.type === "inbound-rtp",
    );
    expect(inboundAudioConsumers).toHaveLength(1);
    const inboundAudioSenders = new Set(
      inboundAudioConsumers.flatMap((consumer) =>
        typeof consumer === "object" &&
        consumer !== null &&
        "playerId" in consumer &&
        typeof consumer.playerId === "string"
          ? [consumer.playerId]
          : [],
      ),
    );
    expect(inboundAudioSenders.size).toBe(1);
    expect(activePeers.flatMap((peer) => peer.errors)).toEqual([]);
    await testInfo.attach("twelve participant RTP summary", {
      body: JSON.stringify(
        {
          participants: peers.length,
          uniquePlayerIds: new Set(peers.map((peer) => peer.welcome!.playerId))
            .size,
          inboundAudioSendersOnFirstParticipant: inboundAudioSenders.size,
          activeAudioParticipants: activePeers.length,
          audioOffersForActiveParticipants: activePeers.map(
            (peer) =>
              peer.media?.offers.filter((offer) => offer.kind === "audio")
                .length,
          ),
          inboundAudioBytes: inboundAudio,
          producersOnFirstParticipant: serverMedia.producers,
          inboundAudioConsumersOnFirstParticipant: inboundAudioConsumers.length,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("twelve nearby participants receive six concurrent microphone RTP streams", async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const speakerCount = 6;
  const contexts = await Promise.all(
    Array.from({ length: 12 }, () =>
      browser.newContext({
        permissions: ["microphone", "camera"],
        viewport: { width: 960, height: 720 },
      }),
    ),
  );
  await Promise.all(contexts.map(enableRtcCapacityRenderingMode));
  try {
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const peers: Awaited<ReturnType<typeof join>>[] = [];
    for (const [index, page] of pages.entries()) {
      peers.push(await join(page, `여섯 명 발화 ${index + 1}`, "", false));
    }
    await expectRtcCapacityRenderingMode(pages);
    expect(new Set(peers.map((peer) => peer.welcome!.playerId)).size).toBe(12);
    await expect
      .poll(() => peers.map((peer) => peer.media?.eventMode))
      .toEqual(Array.from({ length: 12 }, () => false));
    await Promise.all(
      pages.map((page) =>
        expect(page.locator(".event-controls")).toHaveCount(0),
      ),
    );

    for (const [index, page] of pages.slice(0, speakerCount).entries()) {
      await expect
        .poll(
          () => {
            const state = peers[index].media;
            return Boolean(
              state?.available &&
              !state.transitioning &&
              state.peers.length === 11,
            );
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      await page
        .getByRole("button", { name: "마이크 켜기", exact: true })
        .click();
      try {
        await expect(
          page.getByRole("button", { name: "마이크 끄기", exact: true }),
        ).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
        await expect
          .poll(
            async () =>
              (await serverStats(page, peers[index].media!.policyEpoch))
                .producers,
            { timeout: 20_000 },
          )
          .toBe(1);
      } catch (error) {
        const diagnostic = {
          participant: index + 1,
          media: peers[index].media,
          replies: peers[index].replies,
          errors: peers[index].errors,
          wireErrors: peers[index].wireErrors,
          produceRequests: peers[index].sentMessages.filter(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "mediaRequest" &&
              "method" in message &&
              message.method === "produce",
          ),
          callStatus: await page
            .getByTestId("call-status")
            .getAttribute("data-status"),
          callError: await page.locator(".call-error").allTextContents(),
          microphoneButton: {
            disabled: await page
              .getByRole("button", { name: /마이크/ })
              .isDisabled(),
            pressed: await page
              .getByRole("button", { name: /마이크/ })
              .getAttribute("aria-pressed"),
          },
          worldSnapshotPlayerCount: peers[index].snapshot?.players.length,
          capture: await page.evaluate(() => {
            const debug = (
              window as typeof window & {
                __townMediaCaptureDebug?: {
                  captureRequests: Array<{
                    audio: boolean;
                    video: boolean;
                    outcome?: string;
                    errorName?: string;
                    startedAt: number;
                    finishedAt?: number;
                  }>;
                  capturedTracks: MediaStreamTrack[];
                  trackStops: Array<{ kind: string; stack: string }>;
                };
              }
            ).__townMediaCaptureDebug;
            return {
              captureRequests: debug?.captureRequests,
              capturedTracks: debug?.capturedTracks.map((track) => ({
                kind: track.kind,
                readyState: track.readyState,
                enabled: track.enabled,
              })),
              peerConnections: (
                window as typeof window & {
                  __townRtc?: RTCPeerConnection[];
                }
              ).__townRtc?.map((peer) => ({
                connectionState: peer.connectionState,
                iceConnectionState: peer.iceConnectionState,
              })),
              trackStops: debug?.trackStops,
              worldSocketReadyState: (
                window as typeof window & { __townSocket?: WebSocket }
              ).__townSocket?.readyState,
              lastMediaState: (
                window as typeof window & {
                  __townLastMediaState?: MediaState;
                }
              ).__townLastMediaState
                ? {
                    available: (
                      window as typeof window & {
                        __townLastMediaState: MediaState;
                      }
                    ).__townLastMediaState.available,
                    transitioning: (
                      window as typeof window & {
                        __townLastMediaState: MediaState;
                      }
                    ).__townLastMediaState.transitioning,
                    peers: (
                      window as typeof window & {
                        __townLastMediaState: MediaState;
                      }
                    ).__townLastMediaState.peers.length,
                    offers: (
                      window as typeof window & {
                        __townLastMediaState: MediaState;
                      }
                    ).__townLastMediaState.offers.length,
                  }
                : undefined,
              pageVisible: document.visibilityState,
            };
          }),
          cause: error instanceof Error ? error.message : String(error),
        };
        console.error("SPEAKER_DIAGNOSTIC", JSON.stringify(diagnostic));
        await testInfo.attach(
          `${speakerCount}-speaker producer failure ${index + 1}`,
          {
            body: JSON.stringify(diagnostic, null, 2),
            contentType: "application/json",
          },
        );
        throw error;
      }
    }

    const expectedOffers = pages.map((_, index) =>
      index < speakerCount ? speakerCount - 1 : speakerCount,
    );
    await expect
      .poll(
        () =>
          peers.map(
            (peer) =>
              peer.media?.offers.filter((offer) => offer.kind === "audio")
                .length ?? 0,
          ),
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toEqual(expectedOffers);

    await expect
      .poll(
        async () =>
          (await Promise.all(pages.map((page) => inbound(page)))).every(
            (stats) => stats.audio > 5000,
          ),
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
    const receivedBytes = await Promise.all(
      pages.map(async (page) => (await inbound(page)).audio),
    );
    const serverStatsByParticipant = await Promise.all(
      pages.map((page, index) =>
        serverStats(page, peers[index].media!.policyEpoch),
      ),
    );
    const inboundAudioConsumerCounts = serverStatsByParticipant.map(
      (stats) =>
        stats.consumers.filter(
          (consumer) =>
            typeof consumer === "object" &&
            consumer !== null &&
            "kind" in consumer &&
            consumer.kind === "audio" &&
            "type" in consumer &&
            consumer.type === "inbound-rtp",
        ).length,
    );
    expect(serverStatsByParticipant.map((stats) => stats.producers)).toEqual(
      pages.map((_, index) => (index < speakerCount ? 1 : 0)),
    );
    expect(inboundAudioConsumerCounts).toEqual(expectedOffers);
    expect(peers.flatMap((peer) => peer.errors)).toEqual([]);

    await testInfo.attach("twelve participant six-speaker RTP summary", {
      body: JSON.stringify(
        {
          participants: peers.length,
          uniquePlayerIds: new Set(peers.map((peer) => peer.welcome!.playerId))
            .size,
          activeSpeakers: speakerCount,
          activeMicrophoneProducers: serverStatsByParticipant.reduce(
            (total, stats) => total + stats.producers,
            0,
          ),
          inboundAudioConsumerCounts,
          inboundAudioBytes: receivedBytes,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("twelve nearby participants receive six concurrent camera RTP streams", async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const cameraCount = 6;
  const contexts = await Promise.all(
    Array.from({ length: 12 }, () =>
      browser.newContext({
        permissions: ["microphone", "camera"],
        viewport: { width: 960, height: 720 },
      }),
    ),
  );
  await Promise.all(contexts.map(enableRtcCapacityRenderingMode));
  try {
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const peers: Awaited<ReturnType<typeof join>>[] = [];
    for (const [index, page] of pages.entries()) {
      peers.push(await join(page, `여섯 명 카메라 ${index + 1}`, "", false));
    }
    await expectRtcCapacityRenderingMode(pages);
    expect(new Set(peers.map((peer) => peer.welcome!.playerId)).size).toBe(12);
    await expect
      .poll(() => peers.map((peer) => peer.media?.eventMode))
      .toEqual(Array.from({ length: 12 }, () => false));
    await Promise.all(
      pages.map((page) =>
        expect(page.locator(".event-controls")).toHaveCount(0),
      ),
    );

    await expect
      .poll(() => peers.map((peer) => peer.media?.peers.length))
      .toEqual(Array.from({ length: 12 }, () => 11));
    for (const page of pages.slice(0, cameraCount)) {
      await page
        .getByRole("button", { name: "카메라 켜기", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "카메라 끄기", exact: true }),
      ).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
    }

    const expectedOffers = pages.map((_, index) =>
      index < cameraCount ? cameraCount - 1 : cameraCount,
    );
    await expect
      .poll(
        () =>
          peers.map(
            (peer) =>
              peer.media?.offers.filter((offer) => offer.source === "CAMERA")
                .length ?? 0,
          ),
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toEqual(expectedOffers);
    await expect
      .poll(
        async () =>
          (await Promise.all(pages.map((page) => inbound(page)))).every(
            (stats) => stats.video > 5000,
          ),
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          Promise.all(
            pages.map((page) =>
              page.evaluate(async () => {
                let count = 0;
                for (const connection of (
                  window as unknown as {
                    __townRtc: RTCPeerConnection[];
                  }
                ).__townRtc) {
                  const reports = await connection.getStats();
                  reports.forEach((report) => {
                    if (
                      report.type === "inbound-rtp" &&
                      report.kind === "video" &&
                      (report.framesDecoded ?? 0) > 0
                    )
                      count++;
                  });
                }
                return count;
              }),
            ),
          ),
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toEqual(expectedOffers);

    const inboundVideoBytes = await Promise.all(
      pages.map(async (page) => (await inbound(page)).video),
    );
    const videoConsumerCount = (consumers: unknown[]) =>
      consumers.filter(
        (consumer) =>
          typeof consumer === "object" &&
          consumer !== null &&
          "kind" in consumer &&
          consumer.kind === "video" &&
          "type" in consumer &&
          consumer.type === "inbound-rtp",
      ).length;
    await expect
      .poll(
        async () => {
          const stats = await Promise.all(
            pages.map((page, index) =>
              serverStats(page, peers[index].media!.policyEpoch),
            ),
          );
          return stats.map((participant) =>
            videoConsumerCount(participant.consumers),
          );
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toEqual(expectedOffers);
    const serverStatsByParticipant = await Promise.all(
      pages.map((page, index) =>
        serverStats(page, peers[index].media!.policyEpoch),
      ),
    );
    const browserVideoRtpByParticipant = await Promise.all(
      pages.map((page) =>
        page.evaluate(async () => {
          const connections = (
            window as unknown as { __townRtc: RTCPeerConnection[] }
          ).__townRtc;
          const result: Array<Record<string, unknown>> = [];
          for (const [connectionIndex, connection] of connections.entries()) {
            const reports = await connection.getStats();
            reports.forEach((report) => {
              if (report.type === "inbound-rtp" && report.kind === "video") {
                result.push({
                  connectionIndex,
                  connectionState: connection.connectionState,
                  iceConnectionState: connection.iceConnectionState,
                  trackIdentifier: report.trackIdentifier,
                  mid: report.mid,
                  ssrc: report.ssrc,
                  bytesReceived: report.bytesReceived,
                  packetsReceived: report.packetsReceived,
                  framesReceived: report.framesReceived,
                  framesDecoded: report.framesDecoded,
                });
              }
            });
          }
          return result;
        }),
      ),
    );
    await Promise.all(
      pages.map((page, participantIndex) =>
        Promise.all(
          Array.from({ length: cameraCount }, (_, senderIndex) => senderIndex)
            .filter((senderIndex) => senderIndex !== participantIndex)
            .map((senderIndex) =>
              expect(
                page.getByLabel(`여섯 명 카메라 ${senderIndex + 1} 카메라`, {
                  exact: true,
                }),
              ).toBeVisible(),
            ),
        ),
      ),
    );
    const decodedCameraFramesByParticipant = browserVideoRtpByParticipant.map(
      (reports) =>
        reports.filter((report) => Number(report.framesDecoded ?? 0) > 0)
          .length,
    );
    const inboundVideoConsumerCounts = serverStatsByParticipant.map((stats) =>
      videoConsumerCount(stats.consumers),
    );
    expect(decodedCameraFramesByParticipant).toEqual(expectedOffers);
    await testInfo.attach("twelve participant six-camera RTP diagnostics", {
      body: JSON.stringify(
        {
          expectedOffers,
          inboundVideoBytes,
          decodedCameraFramesByParticipant,
          inboundVideoConsumerCounts,
          serverConsumers: serverStatsByParticipant.map((stats) =>
            stats.consumers.map((consumer) =>
              typeof consumer === "object" && consumer !== null
                ? {
                    type: "type" in consumer ? consumer.type : undefined,
                    kind: "kind" in consumer ? consumer.kind : undefined,
                    source: "source" in consumer ? consumer.source : undefined,
                    playerId:
                      "playerId" in consumer ? consumer.playerId : undefined,
                    byteCount:
                      "byteCount" in consumer ? consumer.byteCount : undefined,
                    packetCount:
                      "packetCount" in consumer
                        ? consumer.packetCount
                        : undefined,
                    currentLayers:
                      "currentLayers" in consumer
                        ? consumer.currentLayers
                        : undefined,
                  }
                : consumer,
            ),
          ),
          browserVideoRtpByParticipant,
          offersByParticipant: peers.map((peer) =>
            peer.media?.offers.filter((offer) => offer.source === "CAMERA"),
          ),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(serverStatsByParticipant.map((stats) => stats.producers)).toEqual(
      pages.map((_, index) => (index < cameraCount ? 1 : 0)),
    );
    expect(inboundVideoConsumerCounts).toEqual(expectedOffers);
    expect(peers.flatMap((peer) => peer.errors)).toEqual([]);

    await testInfo.attach("twelve participant six-camera RTP summary", {
      body: JSON.stringify(
        {
          participants: peers.length,
          uniquePlayerIds: new Set(peers.map((peer) => peer.welcome!.playerId))
            .size,
          activeCameraSenders: cameraCount,
          activeCameraProducers: serverStatsByParticipant.reduce(
            (total, stats) => total + stats.producers,
            0,
          ),
          inboundVideoConsumerCounts,
          inboundVideoBytes,
          eventMode: peers.map((peer) => peer.media?.eventMode),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("one nearby screen share reaches eleven participants with video and share audio", async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const contexts = await Promise.all(
    Array.from({ length: 12 }, () =>
      browser.newContext({
        permissions: ["microphone", "camera"],
        viewport: { width: 960, height: 720 },
      }),
    ),
  );
  await Promise.all(contexts.map(enableRtcCapacityRenderingMode));
  try {
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const peers: Awaited<ReturnType<typeof join>>[] = [];
    for (const [index, page] of pages.entries()) {
      peers.push(await join(page, `화면공유 ${index + 1}`, "", false));
    }
    await expectRtcCapacityRenderingMode(pages);
    expect(new Set(peers.map((peer) => peer.welcome!.playerId)).size).toBe(12);
    await expect
      .poll(() => peers.map((peer) => peer.media?.eventMode))
      .toEqual(Array.from({ length: 12 }, () => false));
    await Promise.all(
      pages.map((page) =>
        expect(page.locator(".event-controls")).toHaveCount(0),
      ),
    );
    await expect
      .poll(() => peers.map((peer) => peer.media?.peers.length))
      .toEqual(Array.from({ length: 12 }, () => 11));

    await pages[0]
      .getByRole("button", { name: "화면 공유 시작", exact: true })
      .click();
    await expect(
      pages[0].getByRole("button", { name: "화면 공유 중지", exact: true }),
    ).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
    const remoteShareSources = Array.from({ length: 11 }, () => [
      "SCREEN",
      "SCREEN_AUDIO",
    ]);
    await expect
      .poll(
        () =>
          peers
            .slice(1)
            .map((peer) =>
              peer.media?.offers.map((offer) => offer.source).sort(),
            ),
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toEqual(remoteShareSources);
    await expect
      .poll(
        async () =>
          (
            await Promise.all(pages.slice(1).map((page) => inbound(page)))
          ).every((stats) => stats.video > 5000 && stats.audio > 1000),
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          Promise.all(
            pages.slice(1).map((page) =>
              page.locator(".shared-screen video").evaluateAll((videos) =>
                videos.some((video) => {
                  const element = video as HTMLVideoElement;
                  return (
                    element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
                    element.videoWidth > 0 &&
                    element.videoHeight > 0
                  );
                }),
              ),
            ),
          ),
        { timeout: 30_000, intervals: [250, 500, 1000] },
      )
      .toEqual(Array.from({ length: 11 }, () => true));
    await Promise.all(
      pages.slice(1).map(async (page) => {
        await expect(
          page.getByLabel("화면공유 1님의 화면", { exact: true }),
        ).toBeVisible();
        await expect(
          page.locator('audio[data-source="SCREEN_AUDIO"]'),
        ).toHaveCount(1);
      }),
    );
    const decodedSharedScreens = await Promise.all(
      pages.slice(1).map((page) =>
        page
          .getByLabel("화면공유 1님의 화면", { exact: true })
          .evaluate((element) => {
            const video = element as HTMLVideoElement;
            return {
              ready: video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
              width: video.videoWidth,
              height: video.videoHeight,
            };
          }),
      ),
    );
    expect(
      decodedSharedScreens.every(
        (frame) => frame.ready && frame.width > 0 && frame.height > 0,
      ),
    ).toBe(true);

    const receivedMediaBytes = await Promise.all(
      pages.map(async (page) => ({
        video: (await inbound(page)).video,
        audio: (await inbound(page)).audio,
      })),
    );
    const serverStatsByParticipant = await Promise.all(
      pages.map((page, index) =>
        serverStats(page, peers[index].media!.policyEpoch),
      ),
    );
    const incomingShareSources = serverStatsByParticipant.map((stats) =>
      stats.consumers
        .filter(
          (consumer) =>
            typeof consumer === "object" &&
            consumer !== null &&
            "type" in consumer &&
            consumer.type === "inbound-rtp" &&
            "source" in consumer &&
            (consumer.source === "SCREEN" ||
              consumer.source === "SCREEN_AUDIO"),
        )
        .map((consumer) =>
          typeof consumer === "object" &&
          consumer !== null &&
          "source" in consumer &&
          typeof consumer.source === "string"
            ? consumer.source
            : "",
        )
        .sort(),
    );
    expect(serverStatsByParticipant.map((stats) => stats.producers)).toEqual([
      2,
      ...Array.from({ length: 11 }, () => 0),
    ]);
    expect(incomingShareSources).toEqual([[], ...remoteShareSources]);
    expect(peers.flatMap((peer) => peer.errors)).toEqual([]);
    await testInfo.attach("twelve participant screen share RTP summary", {
      body: JSON.stringify(
        {
          participants: peers.length,
          uniquePlayerIds: new Set(peers.map((peer) => peer.welcome!.playerId))
            .size,
          screenPublishers: serverStatsByParticipant.filter(
            (stats) => stats.producers === 2,
          ).length,
          screenVideoAndAudioConsumers: incomingShareSources.reduce(
            (total, sources) => total + sources.length,
            0,
          ),
          incomingShareSources,
          decodedSharedScreens,
          receivedMediaBytes,
          eventMode: peers.map((peer) => peer.media?.eventMode),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });

    await pages[0]
      .getByRole("button", { name: "화면 공유 중지", exact: true })
      .click();
    await expect
      .poll(() => peers.slice(1).map((peer) => peer.media?.offers.length))
      .toEqual(Array.from({ length: 11 }, () => 0));
    await expect
      .poll(async () =>
        Promise.all(
          pages
            .slice(1)
            .map(
              async (page, index) =>
                (await serverStats(page, peers[index + 1].media!.policyEpoch))
                  .consumers.length,
            ),
        ),
      )
      .toEqual(Array.from({ length: 11 }, () => 0));
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("three peers: crossing the meeting-room boundary revokes outside receivers and never reshares the screen automatically", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const contexts = await Promise.all(
    [0, 1, 2].map(() =>
      browser.newContext({
        permissions: ["microphone", "camera"],
        viewport: { width: 960, height: 720 },
      }),
    ),
  );
  try {
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    const peers = await Promise.all(
      pages.map((p, i) => join(p, `회의 테스트 ${i}`)),
    );
    await Promise.all(
      pages.map(async (page, i) => {
        await walk(page, peers[i], "x", 26.95);
        await walk(page, peers[i], "y", 13.45);
        await walk(page, peers[i], "x", 7.6);
      }),
    );
    const [a, b, outside] = pages,
      [alice, bob, carol] = peers;
    await a.getByRole("button", { name: "마이크 켜기", exact: true }).click();
    await a.getByRole("button", { name: "카메라 켜기", exact: true }).click();
    await a
      .getByRole("button", { name: "화면 공유 시작", exact: true })
      .click();
    await expect.poll(() => carol.media?.offers.length).toBe(4);
    await expect
      .poll(async () => (await inbound(outside)).video, { timeout: 20_000 })
      .toBeGreaterThan(5000);
    const oldEpoch = alice.media!.policyEpoch;
    await walk(a, alice, "y", 11.7);
    await expect.poll(() => alice.media?.kind).toBe("PRIVATE");
    await expect(a.getByTestId("call-status")).toHaveAttribute(
      "data-status",
      "ready",
    );
    expect(alice.media!.policyEpoch).toBeGreaterThan(oldEpoch);
    await expect(
      a.getByRole("button", { name: "마이크 끄기", exact: true }),
    ).toBeEnabled();
    await expect(
      a.getByRole("button", { name: "카메라 끄기", exact: true }),
    ).toBeEnabled();
    await expect(
      a.getByRole("button", { name: "화면 공유 시작", exact: true }),
    ).toBeEnabled();
    await expect.poll(() => carol.media?.offers.length).toBe(0);
    await expect.poll(() => bob.media?.offers.length).toBe(0);
    await expect(
      outside.locator(".world-stage audio[data-source]"),
    ).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await serverStats(outside, carol.media!.policyEpoch)).consumers,
      )
      .toEqual([]);
    // Chromium reports inbound counters on its own cadence; take the baseline after that delay.
    await outside.waitForTimeout(2200);
    const stopped = await inbound(outside);
    await walk(b, bob, "y", 11.7);
    await expect.poll(() => bob.media?.kind).toBe("PRIVATE");
    const privateStats = {
      alice: await serverStats(a, alice.media!.policyEpoch),
      bob: await serverStats(b, bob.media!.policyEpoch),
      outside: await serverStats(outside, carol.media!.policyEpoch),
    };
    await expect
      .poll(() => bob.media?.offers.map((o) => o.source).sort(), {
        timeout: 20_000,
        message: `Same-room media offers after the policy switch: ${JSON.stringify({ alice: alice.media, bob: bob.media, carol: carol.media, privateStats, replies: peers.map((peer) => peer.replies) })}`,
      })
      .toEqual(["CAMERA", "MICROPHONE"]);
    await a
      .getByRole("button", { name: "화면 공유 시작", exact: true })
      .click();
    await expect.poll(() => bob.media?.offers.length).toBe(4);
    await expect
      .poll(async () => (await inbound(b)).video, { timeout: 20_000 })
      .toBeGreaterThan(5000);
    expect(carol.media?.offers).toEqual([]);
    expect(
      (await serverStats(outside, carol.media!.policyEpoch)).consumers,
    ).toEqual([]);
    const after = await inbound(outside);
    await testInfo.attach("outside media counters", {
      body: JSON.stringify({ stopped, after }),
      contentType: "application/json",
    });
    expect(after.frames).toBe(stopped.frames);
    expect(after.samples).toBe(stopped.samples);
    expect(peers.flatMap((p) => p.errors)).toEqual([]);
    await testInfo.attach("meeting separation", {
      body: JSON.stringify(
        {
          inside: await inbound(b),
          outsideAfterRevocation: stopped,
          outsideAfterInsideReshare: await inbound(outside),
          domains: peers.map((p) => p.media?.domain),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test("silent area stops every capture device and permission denial leaves the microphone off", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const mediaDevices = navigator.mediaDevices;
      const original = mediaDevices.getUserMedia.bind(mediaDevices);
      let deniedFirstMicrophoneRequest = false;
      Object.defineProperty(window, "__townMicrophonePermissionDenials", {
        configurable: true,
        value: 0,
        writable: true,
      });
      Object.defineProperty(mediaDevices, "getUserMedia", {
        configurable: true,
        value: async (constraints: MediaStreamConstraints) => {
          if (
            !deniedFirstMicrophoneRequest &&
            constraints.audio !== false &&
            constraints.video === false
          ) {
            deniedFirstMicrophoneRequest = true;
            const host = window as typeof window & {
              __townMicrophonePermissionDenials?: number;
            };
            host.__townMicrophonePermissionDenials =
              (host.__townMicrophonePermissionDenials ?? 0) + 1;
            throw new DOMException("denied by test", "NotAllowedError");
          }
          return original(constraints);
        },
      });
    });
    const seen = await join(page, "장치 테스트");
    const microphone = page.getByRole("button", {
      name: "마이크 켜기",
      exact: true,
    });
    await expect(microphone).toHaveAttribute("aria-pressed", "false");
    await microphone.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __townMicrophonePermissionDenials?: number;
              }
            ).__townMicrophonePermissionDenials,
        ),
      )
      .toBe(1);
    await expect(page.locator(".call-error")).toContainText(
      "권한이 거부됐어요",
    );
    await expect(microphone).toHaveAttribute("aria-pressed", "false");
    await expect(microphone).toBeEnabled();
    await microphone.click();
    await page
      .getByRole("button", { name: "카메라 켜기", exact: true })
      .click();
    await page
      .getByRole("button", { name: "화면 공유 시작", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "화면 공유 중지", exact: true }),
    ).toBeEnabled();
    await walk(page, seen, "x", 26.95);
    await walk(page, seen, "y", 26.5);
    await walk(page, seen, "x", 34.1);
    await expect(page.getByTestId("call-status")).toHaveAttribute(
      "data-status",
      "silent",
    );
    for (const name of ["마이크 켜기", "카메라 켜기", "화면 공유 시작"])
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeDisabled();
    await expect.poll(async () => (await inbound(page)).open).toBe(0);
    expect(seen.errors).toEqual([]);
  } finally {
    await context.close();
  }
});
