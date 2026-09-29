import os from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const enabled = process.env.TOWN_RTC_CAPACITY === "true";
const clients = Number(process.env.TOWN_RTC_CAPACITY_CLIENTS ?? "12");
const speakers = Number(process.env.TOWN_RTC_CAPACITY_SPEAKERS ?? "1");
const rtpHoldSeconds = Number(
  process.env.TOWN_RTC_CAPACITY_RTP_HOLD_SECONDS ?? "0",
);
const outputPath = process.env.TOWN_RTC_CAPACITY_OUTPUT;
const allowedTiers = new Set([2, 12, 25, 50, 100]);

test.skip(
  !enabled,
  "Run scripts/rtc-capacity-e2e.ps1 -ModuleHarness against the isolated capacity SFU.",
);

type HostSample = {
  elapsedMs: number;
  availableMemoryMb: number;
  usedMemoryPercent: number;
  cpuPercent?: number;
};

type PeerSummary = {
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  dtlsStates: string[];
  audioBytesReceived: number;
  audioPacketsReceived: number;
  audioBytesSent: number;
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

async function installInstrumentation(page: Page) {
  await page.addInitScript(() => {
    const peerConnections: RTCPeerConnection[] = [];
    const transportDirections: string[] = [];
    const mediaFailures: Array<Record<string, string>> = [];
    const setErrors: Array<Record<string, string>> = [];
    const requestMethods = new Map<string, string>();
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeerConnection {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        for (let index = peerConnections.length - 1; index >= 0; index--)
          if (peerConnections[index].connectionState === "closed")
            peerConnections.splice(index, 1);
        peerConnections.push(this);
        this.addEventListener("connectionstatechange", () => {
          if (this.connectionState !== "closed") return;
          queueMicrotask(() => {
            const index = peerConnections.indexOf(this);
            if (index >= 0 && this.connectionState === "closed")
              peerConnections.splice(index, 1);
          });
        });
      }
    };
    Object.assign(window, {
      __rtcModulePeerConnections: peerConnections,
      __rtcModuleTransportDirections: transportDirections,
      __rtcModuleMediaFailures: mediaFailures,
      __rtcModuleSetErrors: setErrors,
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
            typeof message.requestId === "string"
          ) {
            requestMethods.set(message.requestId, message.method);
            if (message.method === "createTransport")
              transportDirections.push(JSON.parse(message.dataJson).direction);
          }
        } catch {
          // Leave non-application frames to the original WebSocket.
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
            if (message.type === "mediaReply") {
              const method = requestMethods.get(message.requestId) ?? "unknown";
              requestMethods.delete(message.requestId);
              if (message.ok === false && mediaFailures.length < 100)
                mediaFailures.push({
                  method,
                  code: String(message.code ?? ""),
                  message: String(message.message ?? ""),
                });
            }
          } catch {
            // Ignore non-JSON frames.
          }
        });
      }
    };
  });
}

test("product WorldConnection and MediaController carry nearby RTC at the selected tier", async ({
  browser,
}, testInfo) => {
  expect(allowedTiers.has(clients), `Unsupported client tier: ${clients}`).toBe(
    true,
  );
  expect(speakers).toBeGreaterThanOrEqual(1);
  expect(speakers).toBeLessThan(clients);
  expect(speakers).toBeLessThanOrEqual(12);
  expect(Number.isInteger(rtpHoldSeconds)).toBe(true);
  expect(rtpHoldSeconds).toBeGreaterThanOrEqual(0);
  expect(rtpHoldSeconds).toBeLessThanOrEqual(600);
  test.setTimeout(
    Math.max(180_000, clients * 7_000, (rtpHoldSeconds + 120) * 1000),
  );

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const freeFloorMb = Number(
    process.env.TOWN_RTC_CAPACITY_MIN_FREE_MB ?? "2048",
  );
  const resourceSamples: HostSample[] = [];
  let page: Page | undefined;
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
      elapsedMs: Date.now() - startedMs,
      availableMemoryMb,
      usedMemoryPercent: Number(usedMemoryPercent.toFixed(1)),
      cpuPercent:
        cpuPercent === undefined ? undefined : Number(cpuPercent.toFixed(1)),
    };
    resourceSamples.push(sample);
    if (resourceSamples.length > 900) resourceSamples.shift();
    return sample;
  };
  const assertSafe = () => {
    if (capturedFailure) throw new Error(capturedFailure);
    const availableMemoryMb = Math.round(os.freemem() / 1024 / 1024);
    if (availableMemoryMb < freeFloorMb)
      throw new Error(
        `Safe stop: host free memory ${availableMemoryMb} MiB fell below ${freeFloorMb} MiB.`,
      );
    if (highCpuSamples >= 20)
      throw new Error(
        "Safe stop: host CPU remained at or above 95% for 20 consecutive one-second samples.",
      );
  };
  const waitFor = async <T>(
    read: () => Promise<T>,
    ready: (value: T) => boolean,
    timeoutMs: number,
    description: string,
  ) => {
    const deadline = Date.now() + timeoutMs;
    let latest: T | undefined;
    while (Date.now() < deadline) {
      assertSafe();
      latest = await read();
      if (ready(latest)) return latest;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      `Timed out waiting for ${description}: ${JSON.stringify(latest)}.`,
    );
  };

  try {
    assertSafe();
    timer = setInterval(() => {
      const sample = sampleHost();
      if (sample.availableMemoryMb < freeFloorMb)
        capturedFailure = `Safe stop: host free memory ${sample.availableMemoryMb} MiB fell below ${freeFloorMb} MiB.`;
      else if (highCpuSamples >= 20)
        capturedFailure =
          "Safe stop: host CPU remained at or above 95% for 20 consecutive one-second samples.";
      if (capturedFailure) void context?.close().catch(() => {});
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
    page = await context.newPage();
    await installInstrumentation(page);
    page.on("pageerror", (error) => {
      if (!capturedFailure)
        capturedFailure = `Browser module harness: ${error.message}`;
    });
    await page.goto("/");

    await page.evaluate(async (requestedClients) => {
      const loadModule = new Function(
        "specifier",
        "return import(specifier)",
      ) as (
        specifier: string,
      ) => Promise<Record<string, new (...args: any[]) => any>>;
      const [{ WorldConnection }, { MediaController }, bootstrapResponse] =
        await Promise.all([
          loadModule("/src/game/WorldConnection.ts"),
          loadModule("/src/media/MediaController.ts"),
          fetch("/api/v1/bootstrap"),
        ]);
      const mediaControllerPrototype = (MediaController as any).prototype;
      const originalSetError = mediaControllerPrototype.setError;
      mediaControllerPrototype.setError = function (
        error: unknown,
        ...args: unknown[]
      ) {
        const detail =
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                code: String((error as Error & { code?: string }).code ?? ""),
              }
            : { name: typeof error, message: String(error), code: "" };
        const diagnostics = (
          window as typeof window & { __rtcModuleSetErrors: unknown[] }
        ).__rtcModuleSetErrors;
        if (diagnostics.length < 100) diagnostics.push(detail);
        return originalSetError.call(this, error, ...args);
      };
      if (!bootstrapResponse.ok)
        throw new Error(`Bootstrap failed with ${bootstrapResponse.status}.`);
      const bootstrap = (await bootstrapResponse.json()) as {
        map: { revision: string };
        space: { id: string };
        worldPath: string;
      };
      const participants = Array.from(
        { length: requestedClients },
        (_, index) => {
          const identity = `preview-rtc-module-${String(index + 1).padStart(3, "0")}`;
          const connection = new WorldConnection(
            bootstrap.worldPath,
            `Module RTC ${index + 1}`,
            0,
            bootstrap.map.revision,
            undefined,
            "",
            bootstrap.space.id,
          );
          const media = new MediaController(connection, true);
          media.start();
          return { identity, connection, media };
        },
      );
      Object.assign(window, { __rtcModuleParticipants: participants });
      await Promise.all(
        participants.map((participant) => participant.connection.connect()),
      );
    }, clients);

    const participantsOnline = await waitFor(
      () =>
        page!.evaluate(() => {
          const participants = (
            window as typeof window & {
              __rtcModuleParticipants: Array<{
                connection: { getSnapshot: () => { status: string } };
              }>;
            }
          ).__rtcModuleParticipants;
          return participants.filter(
            (participant) =>
              participant.connection.getSnapshot().status === "online",
          ).length;
        }),
      (count) => count === clients,
      90_000,
      "all WorldConnection clients to join",
    );
    expect(participantsOnline).toBe(clients);

    const movementStart = await waitFor(
      () =>
        page!.evaluate(() => {
          const participants = (
            window as typeof window & {
              __rtcModuleParticipants: Array<{
                connection: {
                  getSnapshot: () => {
                    status: string;
                    selfId: string;
                    players: Array<{ id: string; x: number; y: number }>;
                  };
                };
              }>;
            }
          ).__rtcModuleParticipants;
          const states = participants.map((participant) => {
            const snapshot = participant.connection.getSnapshot();
            const self = snapshot.players.find(
              (player) => player.id === snapshot.selfId,
            );
            return {
              status: snapshot.status,
              rosterSize: snapshot.players.length,
              playerId: snapshot.selfId,
              x: self?.x,
              y: self?.y,
            };
          });
          return states;
        }),
      (states) =>
        states.length === clients &&
        states.every(
          (state) =>
            state.status === "online" &&
            state.rosterSize === clients &&
            state.playerId &&
            Number.isFinite(state.x) &&
            Number.isFinite(state.y),
        ),
      30_000,
      "the full participant roster and initial movement positions",
    );
    await page.evaluate(() => {
      const participants = (
        window as typeof window & {
          __rtcModuleParticipants: Array<{
            connection: {
              move: (dx: number, dy: number, running: boolean) => unknown;
            };
          }>;
        }
      ).__rtcModuleParticipants;
      participants.forEach((participant) =>
        participant.connection.move(1, 0, false),
      );
    });
    const movementResult = await waitFor(
      () =>
        page!.evaluate((starts) => {
          const participants = (
            window as typeof window & {
              __rtcModuleParticipants: Array<{
                connection: {
                  getSnapshot: () => {
                    selfId: string;
                    players: Array<{
                      id: string;
                      x: number;
                      y: number;
                      moving: boolean;
                    }>;
                  };
                };
              }>;
            }
          ).__rtcModuleParticipants;
          return participants.map((participant, index) => {
            const snapshot = participant.connection.getSnapshot();
            const self = snapshot.players.find(
              (player) => player.id === snapshot.selfId,
            );
            const start = starts[index];
            const movedDistance =
              self &&
              start &&
              typeof start.x === "number" &&
              typeof start.y === "number"
                ? Math.hypot(self.x - start.x, self.y - start.y)
                : 0;
            return {
              playerId: snapshot.selfId,
              movedDistance,
              moving: self?.moving ?? false,
            };
          });
        }, movementStart),
      (states) =>
        states.filter((state) => state.movedDistance >= 0.2).length === clients,
      15_000,
      "every participant to apply an authoritative movement update",
    );
    expect(movementResult).toHaveLength(clients);
    await page.evaluate(() => {
      const participants = (
        window as typeof window & {
          __rtcModuleParticipants: Array<{
            connection: {
              move: (dx: number, dy: number, running: boolean) => unknown;
            };
          }>;
        }
      ).__rtcModuleParticipants;
      participants.forEach((participant) =>
        participant.connection.move(0, 0, false),
      );
    });
    await waitFor(
      () =>
        page!.evaluate(() => {
          const participants = (
            window as typeof window & {
              __rtcModuleParticipants: Array<{
                connection: {
                  getSnapshot: () => {
                    selfId: string;
                    players: Array<{ id: string; moving: boolean }>;
                  };
                };
              }>;
            }
          ).__rtcModuleParticipants;
          return participants.filter((participant) => {
            const snapshot = participant.connection.getSnapshot();
            return !snapshot.players.find(
              (player) => player.id === snapshot.selfId,
            )?.moving;
          }).length;
        }),
      (stopped) => stopped === clients,
      10_000,
      "all participants to apply the stop input",
    );

    const spaceChatText = `RTC capacity module broadcast ${startedMs}`;
    const spaceChatAccepted = await page.evaluate((message) => {
      const participants = (
        window as typeof window & {
          __rtcModuleParticipants: Array<{
            connection: { sendChat: (...args: unknown[]) => boolean };
          }>;
        }
      ).__rtcModuleParticipants;
      return participants[0].connection.sendChat(message, "space", "");
    }, spaceChatText);
    expect(spaceChatAccepted).toBe(true);
    const spaceChatRecipients = await waitFor(
      () =>
        page!.evaluate((message) => {
          const participants = (
            window as typeof window & {
              __rtcModuleParticipants: Array<{
                connection: {
                  getSnapshot: () => {
                    chatMessages: Array<{
                      text: string;
                      delivery?: string;
                    }>;
                  };
                };
              }>;
            }
          ).__rtcModuleParticipants;
          return participants.filter((participant) =>
            participant.connection
              .getSnapshot()
              .chatMessages.some((line) => line.text === message),
          ).length;
        }, spaceChatText),
      (count) => count === clients,
      15_000,
      "the public-space chat message to reach every participant",
    );
    expect(spaceChatRecipients).toBe(clients);

    const readyMedia = await waitFor(
      () =>
        page!.evaluate(() => {
          const participants = (
            window as typeof window & {
              __rtcModuleParticipants: Array<{
                media: { getSnapshot: () => { status: string } };
              }>;
            }
          ).__rtcModuleParticipants;
          return participants.filter(
            (participant) => participant.media.getSnapshot().status === "ready",
          ).length;
        }),
      (count) => count === clients,
      90_000,
      "all MediaController receive transports to be ready",
    );
    expect(readyMedia).toBe(clients);
    const nearbyPolicies = await waitFor(
      () =>
        page!.evaluate(() => {
          const participants = (
            window as typeof window & {
              __rtcModuleParticipants: Array<{
                connection: {
                  getSnapshot: () => {
                    selfId: string;
                    status: string;
                    event?: { active?: boolean };
                    media?: {
                      available?: boolean;
                      kind?: string;
                      peers?: string[];
                    };
                  };
                };
              }>;
            }
          ).__rtcModuleParticipants;
          return participants.map((participant) => {
            const world = participant.connection.getSnapshot();
            return {
              playerId: world.selfId,
              status: world.status,
              eventActive: Boolean(world.event?.active),
              mediaAvailable: world.media?.available ?? false,
              mediaKind: world.media?.kind ?? "",
              peerIds: world.media?.peers ?? [],
            };
          });
        }),
      (states) =>
        states.length === clients &&
        states.every(
          (state) =>
            state.status === "online" &&
            !state.eventActive &&
            state.mediaAvailable &&
            state.mediaKind === "PUBLIC" &&
            state.peerIds.length > 0,
        ),
      15_000,
      "ordinary nearby media policies to be ready without presenter mode",
    );
    const speakerIndices = nearbyPolicies
      .map((state, index) => ({ index, peerCount: state.peerIds.length }))
      .sort((a, b) => b.peerCount - a.peerCount)
      .slice(0, speakers)
      .map((candidate) => candidate.index);
    expect(speakerIndices).toHaveLength(speakers);
    const speakerPlayerIds = speakerIndices.map(
      (index) => nearbyPolicies[index].playerId,
    );
    const expectedAudioByRecipient = Object.fromEntries(
      nearbyPolicies.map((state) => [
        state.playerId,
        state.peerIds.filter((playerId) => speakerPlayerIds.includes(playerId)),
      ]),
    );
    const nearbyRecipients = Object.entries(expectedAudioByRecipient)
      .filter(([, sources]) => sources.length > 0)
      .map(([playerId]) => playerId);
    const expectedRecipientCount = nearbyRecipients.length;
    const expectedInboundAudioStreams = Object.values(
      expectedAudioByRecipient,
    ).reduce((total, sources) => total + sources.length, 0);
    expect(expectedRecipientCount).toBeGreaterThan(0);
    expect(expectedInboundAudioStreams).toBeGreaterThanOrEqual(speakers);
    await page.evaluate(async (indices) => {
      const participants = (
        window as typeof window & {
          __rtcModuleParticipants: Array<{
            media: { toggle: (source: "MICROPHONE") => Promise<void> };
          }>;
        }
      ).__rtcModuleParticipants;
      await Promise.all(
        indices.map((index: number) =>
          participants[index].media.toggle("MICROPHONE"),
        ),
      );
    }, speakerIndices);
    await waitFor(
      () =>
        page!.evaluate((indices) => {
          const participants = (
            window as typeof window & {
              __rtcModuleParticipants: Array<{
                media: { getSnapshot: () => { microphone: boolean } };
              }>;
            }
          ).__rtcModuleParticipants;
          return indices.filter(
            (index: number) =>
              participants[index].media.getSnapshot().microphone,
          ).length;
        }, speakerIndices),
      (count) => count === speakers,
      45_000,
      "the selected nearby microphone captures",
    );

    const actualAudioByRecipient = await waitFor(
      () =>
        page!.evaluate((expectedByRecipient) => {
          const participants = (
            window as typeof window & {
              __rtcModuleParticipants: Array<{
                connection: { getSnapshot: () => { selfId: string } };
                media: {
                  getSnapshot: () => {
                    remote: Array<{
                      playerId: string;
                      source: string;
                      kind: string;
                      track: { id: string };
                    }>;
                  };
                };
              }>;
            }
          ).__rtcModuleParticipants;
          return participants.map((participant) => {
            const playerId = participant.connection.getSnapshot().selfId;
            const expectedSourceIds = [
              ...(expectedByRecipient[playerId] ?? []),
            ].sort();
            const receivedSourceIds = [
              ...new Set(
                participant.media
                  .getSnapshot()
                  .remote.filter(
                    (item) =>
                      item.source === "MICROPHONE" && item.kind === "audio",
                  )
                  .map((item) => item.playerId),
              ),
            ].sort();
            const receivedAudioTracks = participant.media
              .getSnapshot()
              .remote.filter(
                (item) => item.source === "MICROPHONE" && item.kind === "audio",
              )
              .map((item) => ({
                playerId: item.playerId,
                trackId: item.track.id,
              }));
            return {
              playerId,
              expectedSourceIds,
              receivedSourceIds,
              receivedAudioTracks,
            };
          });
        }, expectedAudioByRecipient),
      (results) =>
        results.every(
          (result) =>
            JSON.stringify(result.receivedSourceIds) ===
            JSON.stringify(result.expectedSourceIds),
        ),
      30_000,
      "nearby recipients to receive exactly their active microphone peers",
    );
    expect(actualAudioByRecipient).toHaveLength(clients);
    const receivedInboundAudioStreams = actualAudioByRecipient.reduce(
      (total, result) => total + result.receivedSourceIds.length,
      0,
    );
    expect(receivedInboundAudioStreams).toBe(expectedInboundAudioStreams);
    for (const result of actualAudioByRecipient)
      expect(new Set(result.receivedSourceIds)).toEqual(
        new Set(result.expectedSourceIds),
      );

    const mediaDiagnostics = await waitFor(
      () =>
        page!.evaluate(async () => {
          const state = window as typeof window & {
            __rtcModulePeerConnections: RTCPeerConnection[];
            __rtcModuleTransportDirections: string[];
            __rtcModuleParticipants: Array<{
              identity: string;
              connection: {
                getSnapshot: () => {
                  status: string;
                  selfId: string;
                  event?: { active?: boolean };
                  lastEventActionAck?: unknown;
                  media?: {
                    available?: boolean;
                    kind?: string;
                    offers?: Array<{ playerId: string; source: string }>;
                  };
                };
              };
              media: {
                getSnapshot: () => {
                  status: string;
                  microphone: boolean;
                  error: string;
                  busy: string[];
                };
              };
            }>;
          };
          const peers = state.__rtcModulePeerConnections;
          const summaries = await Promise.all(
            peers.map(async (peer) => {
              const reports = [...(await peer.getStats()).values()];
              const inboundAudio = reports.filter(
                (report) =>
                  report.type === "inbound-rtp" &&
                  (report.kind === "audio" || report.mediaType === "audio"),
              );
              const outboundAudio = reports.filter(
                (report) =>
                  report.type === "outbound-rtp" &&
                  (report.kind === "audio" || report.mediaType === "audio"),
              );
              const dtlsStates = reports
                .filter((report) => report.type === "transport")
                .flatMap((report) =>
                  "dtlsState" in report && typeof report.dtlsState === "string"
                    ? [report.dtlsState]
                    : [],
                );
              return {
                connectionState: peer.connectionState,
                iceConnectionState: peer.iceConnectionState,
                dtlsStates,
                audioBytesReceived: inboundAudio.reduce(
                  (sum, report) => sum + (report.bytesReceived ?? 0),
                  0,
                ),
                audioPacketsReceived: inboundAudio.reduce(
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
          const participants = state.__rtcModuleParticipants.map(
            (participant) => {
              const world = participant.connection.getSnapshot();
              const media = participant.media.getSnapshot();
              return {
                identity: participant.identity,
                selfId: world.selfId,
                connectionStatus: world.status,
                eventActive: world.event?.active,
                eventAck: world.lastEventActionAck,
                mediaAvailable: world.media?.available,
                mediaKind: world.media?.kind,
                offers: world.media?.offers?.map((offer) => ({
                  playerId: offer.playerId,
                  source: offer.source,
                })),
                controllerStatus: media.status,
                microphone: media.microphone,
                controllerError: media.error,
                busy: media.busy,
              };
            },
          );
          return {
            qualified: summaries.filter(
              (peer) =>
                peer.audioBytesReceived >= 5000 &&
                peer.audioPacketsReceived > 0 &&
                peer.iceConnectionState === "connected" &&
                peer.dtlsStates.includes("connected"),
            ).length,
            transportDirections: state.__rtcModuleTransportDirections,
            participants,
            peers: summaries,
          };
        }),
      (result) => result.qualified === expectedRecipientCount,
      30_000,
      "nearby inbound RTP over connected ICE and DTLS",
    );
    expect(mediaDiagnostics.qualified).toBe(expectedRecipientCount);

    const expectedTrackIds = actualAudioByRecipient.flatMap((result) =>
      result.receivedAudioTracks.map((track) => track.trackId),
    );
    expect(new Set(expectedTrackIds).size).toBe(expectedInboundAudioStreams);
    const readInboundAudioStats = async () =>
      page!.evaluate(async () => {
        const peerConnections = (
          window as typeof window & {
            __rtcModulePeerConnections: RTCPeerConnection[];
          }
        ).__rtcModulePeerConnections;
        const byTrack = new Map<
          string,
          { bytesReceived: number; packetsReceived: number }
        >();
        for (const peer of peerConnections) {
          const reports = [...(await peer.getStats()).values()];
          for (const report of reports) {
            if (
              report.type !== "inbound-rtp" ||
              (report.kind !== "audio" && report.mediaType !== "audio")
            )
              continue;
            const trackId =
              "trackIdentifier" in report &&
              typeof report.trackIdentifier === "string"
                ? report.trackIdentifier
                : "";
            if (!trackId) continue;
            const current = byTrack.get(trackId) ?? {
              bytesReceived: 0,
              packetsReceived: 0,
            };
            current.bytesReceived += report.bytesReceived ?? 0;
            current.packetsReceived += report.packetsReceived ?? 0;
            byTrack.set(trackId, current);
          }
        }
        return Object.fromEntries(byTrack);
      });
    let sustainedRtp: Record<string, unknown> = {
      status: "not-requested",
      holdSeconds: rtpHoldSeconds,
    };
    if (rtpHoldSeconds > 0) {
      const baseline = await waitFor(
        readInboundAudioStats,
        (stats) =>
          expectedTrackIds.every(
            (trackId) => (stats[trackId]?.packetsReceived ?? 0) > 0,
          ),
        15_000,
        "per-track inbound audio RTP counters",
      );
      const holdStartedAt = Date.now();
      await new Promise((resolve) =>
        setTimeout(resolve, rtpHoldSeconds * 1000),
      );
      assertSafe();
      const finalStats = await waitFor(
        readInboundAudioStats,
        (stats) =>
          expectedTrackIds.every(
            (trackId) =>
              (stats[trackId]?.bytesReceived ?? 0) >
                (baseline[trackId]?.bytesReceived ?? 0) &&
              (stats[trackId]?.packetsReceived ?? 0) >
                (baseline[trackId]?.packetsReceived ?? 0),
          ),
        10_000,
        "continued RTP on every nearby microphone track",
      );
      const perTrackIncrease = expectedTrackIds.map((trackId) => ({
        trackId,
        bytesReceived:
          finalStats[trackId].bytesReceived - baseline[trackId].bytesReceived,
        packetsReceived:
          finalStats[trackId].packetsReceived -
          baseline[trackId].packetsReceived,
      }));
      expect(
        perTrackIncrease.every(
          (track) => track.bytesReceived > 0 && track.packetsReceived > 0,
        ),
      ).toBe(true);
      sustainedRtp = {
        status: "PASS",
        holdSeconds: rtpHoldSeconds,
        observedSeconds: Number(
          ((Date.now() - holdStartedAt) / 1000).toFixed(1),
        ),
        inboundMicrophoneTracks: perTrackIncrease.length,
        minBytesIncrease: Math.min(
          ...perTrackIncrease.map((track) => track.bytesReceived),
        ),
        minPacketsIncrease: Math.min(
          ...perTrackIncrease.map((track) => track.packetsReceived),
        ),
      };
    }

    const evidence = await page!.evaluate(async (sourcePlayerIds) => {
      const peers = window as typeof window & {
        __rtcModulePeerConnections: RTCPeerConnection[];
        __rtcModuleTransportDirections: string[];
        __rtcModuleParticipants: Array<{
          identity: string;
          connection: {
            getSnapshot: () => {
              selfId: string;
              status: string;
              media?: {
                peers?: string[];
                offers?: Array<{ playerId: string; source: string }>;
              };
            };
          };
          media: {
            getSnapshot: () => {
              remote: Array<{ playerId: string; source: string; kind: string }>;
            };
          };
        }>;
      };
      const peerSummaries: PeerSummary[] = await Promise.all(
        peers.__rtcModulePeerConnections.map(async (peer) => {
          const reports = [...(await peer.getStats()).values()];
          const inboundAudio = reports.filter(
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
            audioBytesReceived: inboundAudio.reduce(
              (sum, report) => sum + (report.bytesReceived ?? 0),
              0,
            ),
            audioPacketsReceived: inboundAudio.reduce(
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
      const participants = peers.__rtcModuleParticipants.map((participant) => ({
        identity: participant.identity,
        playerId: participant.connection.getSnapshot().selfId,
        status: participant.connection.getSnapshot().status,
        nearbyPeerCount:
          participant.connection.getSnapshot().media?.peers?.length ?? 0,
        speakerOffers:
          participant.connection
            .getSnapshot()
            .media?.offers?.filter((offer) => offer.source === "MICROPHONE")
            .length ?? 0,
        receivedMicrophoneSenderIds: [
          ...new Set(
            participant.media
              .getSnapshot()
              .remote.filter(
                (item) =>
                  sourcePlayerIds.includes(item.playerId) &&
                  item.source === "MICROPHONE" &&
                  item.kind === "audio",
              )
              .map((item) => item.playerId),
          ),
        ],
      }));
      return {
        participants,
        peerSummaries,
        transportDirections: peers.__rtcModuleTransportDirections,
      };
    }, speakerPlayerIds);
    expect(
      new Set(evidence.participants.map((participant) => participant.playerId))
        .size,
    ).toBe(clients);
    expect(
      evidence.transportDirections.filter((direction) => direction === "send"),
    ).toHaveLength(speakers);
    expect(
      evidence.transportDirections.filter((direction) => direction === "recv")
        .length,
    ).toBeGreaterThanOrEqual(clients);
    const qualifyingPeers = evidence.peerSummaries.filter(
      (peer) =>
        peer.audioBytesReceived >= 5000 &&
        peer.audioPacketsReceived > 0 &&
        peer.iceConnectionState === "connected" &&
        peer.dtlsStates.includes("connected"),
    );
    expect(qualifyingPeers).toHaveLength(expectedRecipientCount);
    summary = {
      status: "PASS",
      startedAt,
      finishedAt: new Date().toISOString(),
      tier: clients,
      participantsRequested: clients,
      participantsJoined: evidence.participants.filter(
        (participant) => participant.status === "online",
      ).length,
      uniquePlayerIds: new Set(
        evidence.participants.map((participant) => participant.playerId),
      ).size,
      activeMicrophoneSenders: speakers,
      participantsWithMicrophoneOffers: evidence.participants.filter(
        (participant) => participant.speakerOffers > 0,
      ).length,
      participantsWithAuthoritativeMovement: movementResult.length,
      minAuthoritativeMovementDistance: Math.min(
        ...movementResult.map((state) => state.movedDistance),
      ),
      spaceChatRecipients,
      participantsWithInboundAudioRtpIceAndDtls: qualifyingPeers.length,
      mediaMode: "nearby proximity; presenter/event mode not activated",
      selectedSpeakerPlayerIds: speakerPlayerIds,
      selectedSpeakerNearbyPeers: Object.fromEntries(
        speakerIndices.map((index) => [
          nearbyPolicies[index].playerId,
          nearbyPolicies[index].peerIds,
        ]),
      ),
      nearbyPeerLimit: 12,
      nearbyRecipients,
      expectedAudioByRecipient,
      expectedInboundAudioStreams,
      receivedInboundAudioStreams,
      rtpHoldSeconds,
      sustainedRtp,
      expectedParticipantsWithInboundAudio: expectedRecipientCount,
      minInboundAudioBytesAcrossRecipients: Math.min(
        ...qualifyingPeers.map((peer) => peer.audioBytesReceived),
      ),
      minInboundAudioPacketsAcrossRecipients: Math.min(
        ...qualifyingPeers.map((peer) => peer.audioPacketsReceived),
      ),
      mediaEngine:
        "isolated host capacity SFU; actual WorldConnection and MediaController modules",
      browser:
        "Chromium with fake microphone; single-page product-module harness",
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
      participants: evidence.participants,
      peers: evidence.peerSummaries,
      resourceSamples,
    };
  } catch (error) {
    capturedFailure =
      capturedFailure ||
      (error instanceof Error ? error.message : String(error));
    summary = {
      status: "FAILED_OR_SAFE_STOP",
      startedAt,
      finishedAt: new Date().toISOString(),
      tier: clients,
      participantsRequested: clients,
      failure: capturedFailure,
      rtpHoldSeconds,
      mediaEngine:
        "isolated host capacity SFU; actual WorldConnection and MediaController modules",
      hostLimits: {
        minFreeMemoryMb: freeFloorMb,
        stopIfCpuAtOrAbovePercentForSeconds: 95,
        cpuStopConsecutiveSamples: 20,
        maxClients: 100,
      },
      resourceSamples,
    };
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    await page
      ?.evaluate(() => {
        const participants = (
          window as typeof window & {
            __rtcModuleParticipants?: Array<{
              connection: { disconnect: () => void };
              media: { stop: () => void };
            }>;
          }
        ).__rtcModuleParticipants;
        participants?.forEach((participant) => {
          participant.media.stop();
          participant.connection.disconnect();
        });
      })
      .catch(() => {});
    await context?.close().catch(() => {});
    if (outputPath) {
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, JSON.stringify(summary, null, 2));
    }
    testInfo.annotations.push({
      type: "rtc-capacity-status",
      description: `${summary.status ?? "UNKNOWN"}; ${capturedFailure}`,
    });
  }
});
