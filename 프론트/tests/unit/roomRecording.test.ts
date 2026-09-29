import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { RoomRecordingState } from "../../src/generated/protocol";
import { LanguageProvider } from "../../src/i18n/language";
import {
  DEFAULT_ROOM_RECORDING_SOURCES,
  isRoomRecordingLive,
  ROOM_RECORDING_SOURCES,
  RoomRecordingControls,
} from "../../src/media/RoomRecordingControls";

const recording: RoomRecordingState = {
  type: "roomRecordingState",
  recordingId: "recording-a",
  zoneId: "meeting-a",
  status: "AWAITING_CONSENT",
  sources: ["MICROPHONE", "SCREEN_AUDIO"],
  requestedByPlayerId: "host",
  requestedByName: "회의 진행자",
  requestedAt: 1_700_000_000_000,
  startedAt: 0,
  endedAt: 0,
  retentionDays: 30,
  trackCount: 0,
  participants: [
    {
      playerId: "host",
      name: "회의 진행자",
      decision: "ACCEPTED",
      respondedAt: 1_700_000_000_100,
    },
    {
      playerId: "guest",
      name: "참가자",
      decision: "PENDING",
      respondedAt: 0,
    },
  ],
};

function render(
  overrides: Partial<Parameters<typeof RoomRecordingControls>[0]> = {},
  language: "ko" | "en" = "ko",
) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: { getItem: () => language, setItem: () => undefined },
    },
  });
  try {
    return renderToStaticMarkup(
      createElement(
        LanguageProvider,
        null,
        createElement(RoomRecordingControls, {
          connection: {} as never,
          zoneId: "meeting-a",
          roomName: "회의실 A",
          isHost: false,
          selfId: "guest",
          online: true,
          recording,
          ack: null,
          ...overrides,
        }),
      ),
    );
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

it("keeps every recording source opt-in and distinguishes screen audio", () => {
  expect(DEFAULT_ROOM_RECORDING_SOURCES).toEqual([]);
  expect(ROOM_RECORDING_SOURCES.map((source) => source.id)).toEqual([
    "MICROPHONE",
    "CAMERA",
    "SCREEN",
    "SCREEN_AUDIO",
  ]);
});

it("treats consent, startup, recording, and shutdown as active server states", () => {
  for (const status of [
    "AWAITING_CONSENT",
    "STARTING",
    "RECORDING",
    "STOPPING",
  ] as const)
    expect(isRoomRecordingLive(status)).toBe(true);
  for (const status of ["STOPPED", "DECLINED", "FAILED", "EXPIRED"] as const)
    expect(isRoomRecordingLive(status)).toBe(false);
});

it("renders an explicit default-deny consent dialog with the selected tracks and retention", () => {
  const markup = render();
  expect(markup).toContain("회의실 A 녹화 동의");
  expect(markup).toContain("마이크");
  expect(markup).toContain("화면 오디오");
  expect(markup).toContain("30일");
  expect(markup).toContain(
    "모든 참가자가 동의하기 전에는 녹화를 시작하지 않아요",
  );
  expect(markup).toContain("동의하고 녹화 허용");
  expect(markup).toContain(">거부</button>");
  expect(markup).toContain('aria-live="polite"');
});

it("clearly warns every participant when consent includes external AI transcription", () => {
  const markup = render({ recording: { ...recording, transcribe: true } });
  expect(markup).toContain("음성 인식 서비스에서 처리되며");
  expect(markup).toContain("잘못 인식된 내용이 있을 수 있어요");
});

it("offers recording initiation only to the room host and shows authoritative recording status", () => {
  const hostMarkup = render({
    isHost: true,
    recording: null,
    canViewArchive: true,
    spaceId: "space-a",
  });
  const guestMarkup = render({ isHost: false, recording: null });
  expect(hostMarkup).toContain("새 녹화 요청");
  expect(hostMarkup).toContain("녹화 보관함");
  expect(guestMarkup).not.toContain("새 녹화 요청");
  expect(guestMarkup).not.toContain("녹화 보관함");

  const recordingMarkup = render({
    recording: {
      ...recording,
      status: "RECORDING",
      startedAt: 1_700_000_001_000,
      participants: recording.participants.map((participant) => ({
        ...participant,
        decision: "ACCEPTED",
      })),
    },
  });
  expect(recordingMarkup).toContain("녹화 중");
  expect(recordingMarkup).toContain("실시간");
  expect(recordingMarkup).toContain("녹화 동의 철회");
});

it("renders the consent and live recording states in the selected language", () => {
  const consentMarkup = render({}, "en");
  expect(consentMarkup).toContain("Recording consent for 회의실 A");
  expect(consentMarkup).toContain("Microphone");
  expect(consentMarkup).toContain("Screen audio");
  expect(consentMarkup).toContain("30 days");
  expect(consentMarkup).toContain("Consent and allow recording");
  expect(consentMarkup).not.toContain("동의하고 녹화 허용");

  const liveMarkup = render(
    {
      recording: {
        ...recording,
        status: "RECORDING",
        startedAt: 1_700_000_001_000,
        participants: recording.participants.map((participant) => ({
          ...participant,
          decision: "ACCEPTED",
        })),
      },
    },
    "en",
  );
  expect(liveMarkup).toContain("Recording</strong>");
  expect(liveMarkup).toContain("LIVE");
  expect(liveMarkup).toContain("Started");
  expect(liveMarkup).toContain("Withdraw recording consent");
});

it("localizes the archive affordance", () => {
  expect(render({ canViewArchive: true, spaceId: "space-a" }, "en")).toContain(
    "Recording archive",
  );
  expect(render({ canViewArchive: true }, "en")).not.toContain(
    "Recording archive",
  );
});
