import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const enabled = process.env.TOWN_RTC_CAPACITY === "true";
const clients = Number(process.env.TOWN_RTC_CAPACITY_CLIENTS ?? "2");
const speakers = Number(process.env.TOWN_RTC_CAPACITY_SPEAKERS ?? "1");
const rtpHoldSeconds = Number(
  process.env.TOWN_RTC_CAPACITY_RTP_HOLD_SECONDS ?? "0",
);
const outputPath = process.env.TOWN_RTC_CAPACITY_OUTPUT;
const allowedTiers = new Set([2, 12, 25, 50, 100]);

test.skip(
  !enabled,
  "Run scripts/rtc-capacity-e2e.ps1 against the isolated capacity SFU to opt in.",
);

type PeerSummary = {
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  dtlsStates: string[];
  audioBytesReceived: number;
  audioPacketsReceived: number;
  audioBytesSent: number;
};

type Participant = {
  page: Page;
  identity: string;
  playerId?: string;
  errors: string[];
};

type HostSample = {
  elapsedMs: number;
  availableMemoryMb: number;
  usedMemoryPercent: number;
  cpuPercent?: number;
};

function cpuSnapshot() {
  return os.cpus().reduce(
    (total, cpu) => {
      const times = cpu.times;
      return {
        idle: total.idle + times.idle,
        total:
          total.total +
          times.user +
          times.nice +
          times.sys +
          times.irq +
          times.idle,
      };
    },
    { idle: 0, total: 0 },
  );
}

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const state: {
      playerId?: string;
      welcomeAt?: number;
      media?: {
        eventMode?: boolean;
        eventSpeaker?: boolean;
        kind?: string;
        peers?: string[];
        offers?: unknown[];
      };
      event?: { active?: boolean; title?: string };
      transportDirections: string[];
    } = { transportDirections: [] };
    const peerConnections: RTCPeerConnection[] = [];
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeerConnection {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        peerConnections.push(this);
      }
    };
    Object.assign(window, {
      __rtcCapacityState: state,
      __rtcCapacityPeerConnections: peerConnections,
      __hufsRtcCapacityHeadless: true,
    });

    const NativeWebSocket = window.WebSocket;
    const nativeSend = NativeWebSocket.prototype.send;
    NativeWebSocket.prototype.send = function (
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ) {
      if (typeof data === "string") {
        try {
          const message = JSON.parse(data);
          if (
            message.type === "mediaRequest" &&
            message.method === "createTransport"
          )
            state.transportDirections.push(
              JSON.parse(message.dataJson).direction,
            );
        } catch {
          // Leave malformed or non-application frames to the original socket.
        }
      }
      nativeSend.call(this, data);
    };
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(String(event.data));
            if (message.type === "welcome") {
              state.playerId = message.playerId;
              state.welcomeAt = Date.now();
            } else if (message.type === "mediaState") {
              state.media = message;
            } else if (message.type === "eventState") {
              state.event = message;
            }
          } catch {
            // Ignore non-JSON WebSocket frames from the application.
          }
        });
      }
    };
  });
}

async function peerSummary(page: Page): Promise<PeerSummary[]> {
  return page.evaluate(async () => {
    const peers = (
      window as typeof window & {
        __rtcCapacityPeerConnections: RTCPeerConnection[];
      }
    ).__rtcCapacityPeerConnections;
    return Promise.all(
      peers.map(async (peer) => {
        const reports = [...(await peer.getStats()).values()];
        const audio = reports.filter(
          (report) =>
            report.type === "inbound-rtp" &&
            (report.kind === "audio" || report.mediaType === "audio"),
        );
        const outboundAudio = reports.filter(
          (report) =>
            report.type === "outbound-rtp" &&
            (report.kind === "audio" || report.mediaType === "audio"),
        );
        return {
          connectionState: peer.connectionState,
          iceConnectionState: peer.iceConnectionState,
          dtlsStates: reports
            .filter((report) => report.type === "transport")
            .flatMap((report) =>
              "dtlsState" in report && typeof report.dtlsState === "string"
                ? [report.dtlsState]
                : [],
            ),
          audioBytesReceived: audio.reduce(
            (sum, report) => sum + (report.bytesReceived ?? 0),
            0,
          ),
          audioPacketsReceived: audio.reduce(
            (sum, report) => sum + (report.packetsReceived ?? 0),
            0,
          ),
          audioBytesSent: outboundAudio.reduce(
            (sum, report) => sum + (report.bytesSent ?? 0),
            0,
          ),
        };
      }),
    );
  });
}

async function mediaTransportDirections(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __rtcCapacityState: { transportDirections: string[] };
        }
      ).__rtcCapacityState.transportDirections,
  );
}

async function mediaState(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __rtcCapacityState?: {
            playerId?: string;
            media?: {
              kind?: string;
              eventMode?: boolean;
              peers?: string[];
              offers?: Array<{ playerId?: string; source?: string }>;
            };
            event?: { active?: boolean };
          };
        }
      ).__rtcCapacityState,
  );
}

test("isolated HUFS app carries nearby audio over ICE/DTLS/RTP at the selected tier", async ({
  browser,
}, testInfo) => {
  expect(allowedTiers.has(clients), `Unsupported client tier: ${clients}`).toBe(
    true,
  );
  expect(speakers).toBeGreaterThanOrEqual(1);
  expect(speakers).toBeLessThanOrEqual(4);
  expect(speakers).toBeLessThan(clients);
  expect(Number.isInteger(rtpHoldSeconds)).toBe(true);
  expect(rtpHoldSeconds).toBeGreaterThanOrEqual(0);
  expect(rtpHoldSeconds).toBeLessThanOrEqual(600);
  test.setTimeout(
    Math.max(180_000, clients * 7_000, (rtpHoldSeconds + 120) * 1000),
  );

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const freeFloorMb = Number(
    process.env.TOWN_RTC_CAPACITY_MIN_FREE_MB ?? "2048",
  );
  const participants: Participant[] = [];
  const resourceSamples: HostSample[] = [];
  const pageErrors: string[] = [];
  let context: BrowserContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let previousCpu = cpuSnapshot();
  let highCpuSamples = 0;
  let capturedFailure = "";
  let summary: Record<string, unknown> = {};

  const sampleHost = () => {
    const availableMemoryMb = Math.round(os.freemem() / 1024 / 1024);
    const usedMemoryPercent =
      ((os.totalmem() - os.freemem()) / os.totalmem()) * 100;
    const currentCpu = cpuSnapshot();
    const cpuPercent =
      currentCpu.total > previousCpu.total
        ? ((currentCpu.total -
            previousCpu.total -
            (currentCpu.idle - previousCpu.idle)) /
            (currentCpu.total - previousCpu.total)) *
          100
        : undefined;
    previousCpu = currentCpu;
    if (cpuPercent !== undefined && cpuPercent >= 95) highCpuSamples++;
    else highCpuSamples = 0;
    const sample = {
      elapsedMs: Date.now() - startMs,
      availableMemoryMb,
      usedMemoryPercent: Number(usedMemoryPercent.toFixed(1)),
      cpuPercent:
        cpuPercent === undefined ? undefined : Number(cpuPercent.toFixed(1)),
    };
    resourceSamples.push(sample);
    if (resourceSamples.length > 900) resourceSamples.shift();
    return sample;
  };
  const resourceGuard = () => {
    const sample = sampleHost();
    if (sample.availableMemoryMb < freeFloorMb) {
      throw new Error(
        `Safe stop: host free memory ${sample.availableMemoryMb} MiB fell below ${freeFloorMb} MiB.`,
      );
    }
    if (highCpuSamples >= 20) {
      throw new Error(
        "Safe stop: host CPU remained at or above 95% for 20 consecutive one-second samples.",
      );
    }
  };

  try {
    resourceGuard();
    timer = setInterval(() => {
      try {
        resourceGuard();
      } catch (error) {
        capturedFailure =
          error instanceof Error ? error.message : String(error);
        clearInterval(timer);
        timer = undefined;
        void context?.close().catch(() => {});
      }
    }, 1000);
    const appOrigin = new URL(
      process.env.TOWN_E2E_BASE_URL ?? "http://localhost:5173",
    ).origin;
    context = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 960, height: 720 },
      storageState: {
        cookies: [],
        origins: [
          {
            origin: appOrigin,
            localStorage: [
              { name: "hufs-town.render-mode", value: "low-spec" },
            ],
          },
        ],
      },
    });

    for (let index = 0; index < clients; index++) {
      if (capturedFailure) throw new Error(capturedFailure);
      if (index % 5 === 0) resourceGuard();
      const identity = `preview-rtc-capacity-${String(index + 1).padStart(3, "0")}`;
      const page = await context.newPage();
      const participant: Participant = { page, identity, errors: [] };
      participants.push(participant);
      page.on("pageerror", (error) => {
        participant.errors.push(error.message);
        pageErrors.push(`${identity}: ${error.message}`);
      });
      await instrument(page);
      await page.goto("/");
      await page
        .getByPlaceholder("이름이나 닉네임을 알려주세요")
        .fill(`RTC 참가자 ${index + 1}`);
      await page.getByRole("button", { name: "캠퍼스 입장하기" }).click();
      await expect
        .poll(() => mediaState(page).then((state) => state?.playerId), {
          timeout: 30_000,
          message: `Participant ${index + 1} did not receive a World welcome.`,
        })
        .toBeTruthy();
      await expect
        .poll(() =>
          page.evaluate(() => window.__hufsRtcCapacityHeadlessApplied),
        )
        .toBe(true);
      await expect(
        page.locator('[data-testid="world-canvas"] canvas'),
      ).toHaveCount(0);
      expect(
        await page.evaluate(() =>
          localStorage.getItem("hufs-town.render-mode"),
        ),
      ).toBe("low-spec");
      await expect(page.getByTestId("call-status")).toHaveAttribute(
        "data-status",
        "ready",
        { timeout: 30_000 },
      );
      await expect.poll(() => mediaTransportDirections(page)).toEqual(["recv"]);
      await expect(page.locator(".event-controls")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "마이크 켜기", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "카메라 켜기", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "화면 공유 시작", exact: true }),
      ).toBeVisible();
      participant.playerId = (await mediaState(page))?.playerId;
    }

    expect(
      new Set(participants.map((participant) => participant.playerId)).size,
    ).toBe(clients);

    const readNearbyPolicies = async () =>
      Promise.all(
        participants.map(async (participant) => ({
          participant,
          state: await mediaState(participant.page),
        })),
      );
    let nearbyPolicies = await readNearbyPolicies();
    const policyDeadline = Date.now() + 45_000;
    const nearbyPoliciesReady = (states: typeof nearbyPolicies) =>
      states.every(
        ({ state }) =>
          Boolean(state?.playerId) &&
          state?.event?.active !== true &&
          state?.media?.eventMode === false &&
          state?.media?.kind === "PUBLIC" &&
          (state?.media?.peers?.length ?? 0) > 0,
      );
    while (
      !nearbyPoliciesReady(nearbyPolicies) &&
      Date.now() < policyDeadline
    ) {
      resourceGuard();
      await new Promise((resolve) => setTimeout(resolve, 500));
      nearbyPolicies = await readNearbyPolicies();
    }
    expect(nearbyPoliciesReady(nearbyPolicies)).toBe(true);

    const speakerParticipants = [...nearbyPolicies]
      .sort(
        (a, b) =>
          (b.state?.media?.peers?.length ?? 0) -
          (a.state?.media?.peers?.length ?? 0),
      )
      .slice(0, speakers)
      .map(({ participant }) => participant);
    expect(speakerParticipants).toHaveLength(speakers);
    const speakerIds = speakerParticipants.map(
      (participant) => participant.playerId!,
    );
    const expectedAudioByRecipient = new Map(
      nearbyPolicies.map(({ participant, state }) => [
        participant.playerId!,
        (state?.media?.peers ?? []).filter((peerId) =>
          speakerIds.includes(peerId),
        ),
      ]),
    );
    const expectedStreams = [...expectedAudioByRecipient.values()].reduce(
      (total, sources) => total + sources.length,
      0,
    );
    const requiredRecipients = participants.filter(
      (participant) =>
        (expectedAudioByRecipient.get(participant.playerId!)?.length ?? 0) > 0,
    );
    const expectedRecipientCount = requiredRecipients.length;
    expect(expectedRecipientCount).toBeGreaterThan(0);
    expect(expectedStreams).toBeGreaterThanOrEqual(speakers);

    for (const speaker of speakerParticipants) {
      await speaker.page
        .getByRole("button", { name: "마이크 켜기", exact: true })
        .click();
      await expect(
        speaker.page.getByRole("button", {
          name: "마이크 끄기",
          exact: true,
        }),
      ).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
      await expect
        .poll(
          async () =>
            (await mediaTransportDirections(speaker.page)).filter(
              (direction) => direction === "send",
            ).length,
        )
        .toBe(1);
      const speakerDirections = await mediaTransportDirections(speaker.page);
      expect(speakerDirections).toContain("recv");
      expect(
        speakerDirections.every((direction) =>
          ["recv", "send"].includes(direction),
        ),
      ).toBe(true);
    }
    for (const listener of participants.filter(
      (participant) => !speakerParticipants.includes(participant),
    )) {
      const listenerDirections = await mediaTransportDirections(listener.page);
      expect(listenerDirections).toContain("recv");
      expect(listenerDirections).not.toContain("send");
    }

    const offersDeadline = Date.now() + 90_000;
    let offersMatchNearbyPolicy = false;
    while (!offersMatchNearbyPolicy && Date.now() < offersDeadline) {
      if (capturedFailure) throw new Error(capturedFailure);
      const states = await Promise.all(
        participants.map((participant) => mediaState(participant.page)),
      );
      offersMatchNearbyPolicy = states.every((state, index) => {
        const playerId = participants[index].playerId!;
        const expected = [
          ...(expectedAudioByRecipient.get(playerId) ?? []),
        ].sort();
        const actual = (state?.media?.offers ?? [])
          .filter((offer) => offer.source === "MICROPHONE")
          .map((offer) => offer.playerId ?? "")
          .sort();
        return JSON.stringify(actual) === JSON.stringify(expected);
      });
      if (!offersMatchNearbyPolicy)
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(offersMatchNearbyPolicy).toBe(true);

    // Sample in batches so evidence collection does not spike the host at the top tier.
    let listenerSummaries: Array<{
      identity: string;
      peers: PeerSummary[];
    }> = [];
    const readAllPeerStats = async () => {
      const values: typeof listenerSummaries = [];
      for (let offset = 0; offset < participants.length; offset += 10) {
        if (capturedFailure) return values;
        const batch = participants.slice(offset, offset + 10);
        const next = await Promise.all(
          batch.map(async (participant) => ({
            identity: participant.identity,
            peers: await peerSummary(participant.page),
          })),
        );
        values.push(...next);
      }
      listenerSummaries = values;
      return values;
    };
    const recipientTotals = (peers: PeerSummary[]) => ({
      bytes: peers.reduce((sum, peer) => sum + peer.audioBytesReceived, 0),
      packets: peers.reduce((sum, peer) => sum + peer.audioPacketsReceived, 0),
      connectedPeer: peers.some(
        (peer) =>
          peer.iceConnectionState === "connected" &&
          peer.dtlsStates.includes("connected"),
      ),
    });
    const expectedRecipients = expectedRecipientCount;
    const qualifiedRecipients = (measured: typeof listenerSummaries) =>
      requiredRecipients.filter((participant) => {
        const peer = measured.find(
          (value) => value.identity === participant.identity,
        );
        if (!peer) return false;
        const receipt = recipientTotals(peer.peers);
        return (
          receipt.bytes >= 5_000 && receipt.packets > 0 && receipt.connectedPeer
        );
      }).length;
    const rtpDeadline = Date.now() + 120_000;
    while (Date.now() < rtpDeadline) {
      if (capturedFailure) throw new Error(capturedFailure);
      const measured = await readAllPeerStats();
      if (qualifiedRecipients(measured) === expectedRecipients) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (capturedFailure) throw new Error(capturedFailure);
    const rtpQualified = qualifiedRecipients(listenerSummaries);
    expect(
      rtpQualified,
      `Only ${rtpQualified}/${expectedRecipients} expected nearby participants received at least 5,000 audio bytes with packets and connected ICE/DTLS.`,
    ).toBe(expectedRecipients);
    const receivingParticipants = requiredRecipients.length;
    const receiptTotals = requiredRecipients.map((participant) => {
      const measured = listenerSummaries.find(
        (value) => value.identity === participant.identity,
      );
      return recipientTotals(measured?.peers ?? []);
    });
    const minInboundAudioBytes = Math.min(
      ...receiptTotals.map((receipt) => receipt.bytes),
    );
    const minInboundAudioPackets = Math.min(
      ...receiptTotals.map((receipt) => receipt.packets),
    );
    expect(receivingParticipants).toBe(expectedRecipients);
    expect(pageErrors).toEqual([]);

    let sustainedRtp: Record<string, unknown> = {
      status: "not-requested",
      holdSeconds: rtpHoldSeconds,
    };
    if (rtpHoldSeconds > 0) {
      const beforeHold = listenerSummaries;
      const holdStartedAt = Date.now();
      await new Promise((resolve) =>
        setTimeout(resolve, rtpHoldSeconds * 1000),
      );
      if (capturedFailure) throw new Error(capturedFailure);
      const afterHold = await readAllPeerStats();
      const perRecipientIncrease = requiredRecipients.map((participant) => {
        const before = beforeHold.find(
          (value) => value.identity === participant.identity,
        );
        const after = afterHold.find(
          (value) => value.identity === participant.identity,
        );
        const previous = recipientTotals(before?.peers ?? []);
        const current = recipientTotals(after?.peers ?? []);
        return {
          identity: participant.identity,
          bytesReceived: current.bytes - previous.bytes,
          packetsReceived: current.packets - previous.packets,
          connectedPeer: current.connectedPeer,
        };
      });
      expect(
        perRecipientIncrease.every(
          (recipient) =>
            recipient.bytesReceived > 0 &&
            recipient.packetsReceived > 0 &&
            recipient.connectedPeer,
        ),
      ).toBe(true);
      listenerSummaries = afterHold;
      sustainedRtp = {
        status: "PASS",
        holdSeconds: rtpHoldSeconds,
        observedSeconds: Number(
          ((Date.now() - holdStartedAt) / 1000).toFixed(1),
        ),
        receivingParticipants: perRecipientIncrease.length,
        minBytesIncrease: Math.min(
          ...perRecipientIncrease.map((recipient) => recipient.bytesReceived),
        ),
        minPacketsIncrease: Math.min(
          ...perRecipientIncrease.map((recipient) => recipient.packetsReceived),
        ),
      };
    }

    summary = {
      status: "PASS",
      startedAt,
      finishedAt: new Date().toISOString(),
      tier: clients,
      participantsRequested: clients,
      participantsJoined: participants.length,
      uniquePlayerIds: new Set(
        participants.map((participant) => participant.playerId),
      ).size,
      activeSpeakers: speakers,
      mediaMode: "nearby proximity; presenter/event mode not activated",
      selectedSpeakerIds: speakerIds,
      nearbyPeerLimit: 12,
      expectedInboundAudioStreams: expectedStreams,
      participantsWithMicrophoneOffers: requiredRecipients.length,
      participantsWithInboundAudioRtpIceAndDtls: receivingParticipants,
      expectedParticipantsWithInboundAudio: expectedRecipients,
      minInboundAudioBytesAcrossRecipients: minInboundAudioBytes,
      minInboundAudioPacketsAcrossRecipients: minInboundAudioPackets,
      rtpHoldSeconds,
      sustainedRtp,
      mediaEngine: "isolated host capacity SFU 127.0.0.1:18083; RTP 44445",
      browser: "Chromium with fake media-device flags; fake microphone only",
      hostLimits: {
        minFreeMemoryMb: freeFloorMb,
        stopIfCpuAtOrAbovePercentForSeconds: 95,
        cpuStopConsecutiveSamples: 20,
        maxClients: 100,
      },
      hostResources: {
        totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
        finalAvailableMemoryMb: Math.round(os.freemem() / 1024 / 1024),
        peakUsedMemoryPercent: Math.max(
          ...resourceSamples.map((sample) => sample.usedMemoryPercent),
        ),
        peakCpuPercent: Math.max(
          ...resourceSamples.map((sample) => sample.cpuPercent ?? 0),
        ),
      },
      participants: listenerSummaries.map(({ identity, peers: rtcPeers }) => ({
        identity,
        peers: rtcPeers,
      })),
      resourceSamples,
      pageErrors,
    };
  } catch (error) {
    capturedFailure ||= error instanceof Error ? error.message : String(error);
    summary = {
      status: "FAILED_OR_SAFE_STOP",
      startedAt,
      finishedAt: new Date().toISOString(),
      tier: clients,
      participantsRequested: clients,
      participantsJoined: participants.length,
      failure: capturedFailure,
      rtpHoldSeconds,
      mediaEngine: "isolated host capacity SFU 127.0.0.1:18083; RTP 44445",
      hostLimits: {
        minFreeMemoryMb: freeFloorMb,
        stopIfCpuAtOrAbovePercentForSeconds: 95,
        cpuStopConsecutiveSamples: 20,
        maxClients: 100,
      },
      resourceSamples,
      pageErrors,
    };
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    summary.resourceSamples ??= resourceSamples;
    summary.pageErrors ??= pageErrors;
    summary.participantsJoined ??= participants.length;
    summary.finishedAt ??= new Date().toISOString();
    const serialized = JSON.stringify(summary, null, 2);
    if (outputPath) {
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${serialized}\n`, "utf8");
    }
    await testInfo.attach(`rtc-capacity-${clients}-summary.json`, {
      body: serialized,
      contentType: "application/json",
    });
    if (context) await context.close();
  }
});
