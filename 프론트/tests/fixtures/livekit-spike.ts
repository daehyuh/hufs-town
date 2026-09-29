import { Room, RoomEvent, Track } from "livekit-client";

type SpikeConfig = {
  url: string;
  token: string;
  identity: string;
  role: "full" | "microphone-only";
  share?: boolean;
};

declare global {
  interface Window {
    livekitSpikeConfig?: SpikeConfig;
    livekitSpikeState?: {
      status: string;
      identity: string;
      mediaReady: boolean;
      progress: string[];
      localSources: string[];
      subscriptions: Array<{ identity: string; source: string; kind: string }>;
      publishError?: string;
      room?: Room;
    };
  }
}

const state = {
  status: "idle",
  identity: "",
  mediaReady: false,
  progress: [] as string[],
  localSources: [] as string[],
  subscriptions: [] as Array<{
    identity: string;
    source: string;
    kind: string;
  }>,
  publishError: undefined as string | undefined,
  room: undefined as Room | undefined,
};
window.livekitSpikeState = state;

Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
  configurable: true,
  value: async (constraints: MediaStreamConstraints) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    let frame = 0;
    const draw = () => {
      if (!context) return;
      context.fillStyle = frame++ % 2 ? "#f30" : "#03f";
      context.fillRect(0, 0, canvas.width, canvas.height);
      requestAnimationFrame(draw);
    };
    draw();
    const tracks = canvas.captureStream(12).getVideoTracks();
    if (constraints.audio) {
      const audioContext = new AudioContext();
      await audioContext.resume();
      const oscillator = audioContext.createOscillator();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      tracks.push(...destination.stream.getAudioTracks());
    }
    return new MediaStream(tracks);
  },
});

document
  .querySelector<HTMLButtonElement>("#join")!
  .addEventListener("click", () => void joinRoom());

async function joinRoom() {
  const config = window.livekitSpikeConfig;
  if (!config) throw new Error("Missing LiveKit test config");
  state.identity = config.identity;
  const room = new Room({ adaptiveStream: false, dynacast: false });
  state.room = room;
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    state.subscriptions.push({
      identity: participant.identity,
      source: publication.source,
      kind: publication.kind,
    });
    const element = track.attach();
    element.muted = true;
    document.body.append(element);
  });
  room.on(RoomEvent.LocalTrackPublished, (publication) => {
    state.progress.push(`track-published:${publication.source}`);
  });
  room.on(RoomEvent.ConnectionStateChanged, (connectionState) => {
    state.status = connectionState;
    document.querySelector("#status")!.textContent = connectionState;
  });

  try {
    await room.connect(config.url, config.token, { autoSubscribe: true });
    state.progress.push("connected");
    await room.localParticipant.setMicrophoneEnabled(true);
    state.progress.push("microphone-published");
    if (config.role === "full") {
      await room.localParticipant.setCameraEnabled(true);
      state.progress.push("camera-published");
      if (config.share) {
        await room.localParticipant.setScreenShareEnabled(true, {
          audio: true,
        });
        state.progress.push("screen-published");
      }
    } else {
      try {
        await room.localParticipant.setCameraEnabled(true);
      } catch (error) {
        state.publishError =
          error instanceof Error ? error.message : String(error);
        state.progress.push("camera-denied");
      }
    }
  } catch (error) {
    state.publishError = error instanceof Error ? error.message : String(error);
    state.progress.push("publish-error");
  } finally {
    state.localSources = [...room.localParticipant.trackPublications.values()]
      .map((publication) => publication.source)
      .filter((source): source is Track.Source => Boolean(source));
    state.mediaReady = true;
    document.querySelector("#status")!.textContent = JSON.stringify({
      status: state.status,
      progress: state.progress,
      error: state.publishError,
    });
  }
}
