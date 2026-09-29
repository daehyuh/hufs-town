import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  MonitorUp,
  Settings2,
  Volume2,
  X,
  Maximize2,
  Minimize2,
  Grid2X2,
  Pin,
  PinOff,
  Move,
} from "lucide-react";
import { Dialog } from "../components/Dialog";
import {
  formatNumber,
  useLanguage,
  type TranslationKey,
} from "../i18n/language";
import type { EventState, MediaState, PlayerView } from "../generated/protocol";
import type {
  MediaController,
  MediaView,
  RemoteMedia,
} from "./MediaController";
import { mediaErrorMessage } from "./mediaError";
import { proximityAudioVolume } from "./proximityAudio";
import "./media.css";

export function MediaControls({
  controller,
  view,
}: {
  controller: MediaController;
  view: MediaView;
}) {
  const [settings, setSettings] = useState(false);
  const { t } = useLanguage();
  const ready = view.status === "ready";
  const microphoneLimited = view.moderatedSources.includes("MICROPHONE");
  const cameraLimited = view.moderatedSources.includes("CAMERA");
  const screenLimited =
    view.moderatedSources.includes("SCREEN") ||
    view.moderatedSources.includes("SCREEN_AUDIO");
  useEffect(() => {
    if (!view.pushToTalk) return;
    let keyHeld = false;
    const release = () => {
      keyHeld = false;
      controller.setPttTalking(false);
    };
    const isTyping = (event: KeyboardEvent) => {
      const target = event.target;
      return (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
          !!target.closest("dialog[open]"))
      );
    };
    const down = (event: KeyboardEvent) => {
      if (
        event.code !== "KeyV" ||
        event.repeat ||
        event.defaultPrevented ||
        isTyping(event)
      )
        return;
      event.preventDefault();
      keyHeld = true;
      controller.setPttTalking(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "KeyV") release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      release();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, [controller, view.pushToTalk]);
  return (
    <>
      <button
        className={`control ${view.pushToTalk ? (view.talking ? "selected talking" : "ptt-armed") : view.microphone ? "selected" : ""}`}
        aria-label={
          microphoneLimited
            ? t("media.control.mic.restrictedAria")
            : view.pushToTalk
              ? view.talking
                ? t("media.control.ptt.sending")
                : t("media.control.ptt.hold")
              : view.microphone
                ? t("media.control.mic.off")
                : t("media.control.mic.on")
        }
        aria-pressed={view.pushToTalk ? view.talking : view.microphone}
        aria-keyshortcuts={view.pushToTalk ? "V Space Enter" : undefined}
        disabled={
          microphoneLimited ||
          (view.pushToTalk ? !ready : !ready && !view.microphone) ||
          view.busy.includes("MICROPHONE")
        }
        onClick={() => {
          if (!view.pushToTalk) void controller.toggle("MICROPHONE");
        }}
        onPointerDown={(event) => {
          if (!view.pushToTalk) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          controller.setPttTalking(true);
        }}
        onPointerUp={() => {
          if (view.pushToTalk) controller.setPttTalking(false);
        }}
        onPointerCancel={() => controller.setPttTalking(false)}
        onLostPointerCapture={() => controller.setPttTalking(false)}
        onKeyDown={(event) => {
          if (
            view.pushToTalk &&
            (event.code === "Space" || event.code === "Enter")
          ) {
            event.preventDefault();
            controller.setPttTalking(true);
          }
        }}
        onKeyUp={(event) => {
          if (
            view.pushToTalk &&
            (event.code === "Space" || event.code === "Enter")
          )
            controller.setPttTalking(false);
        }}
        onBlur={() => controller.setPttTalking(false)}
        onContextMenu={(event) => {
          if (view.pushToTalk) event.preventDefault();
        }}
      >
        {view.pushToTalk ? (
          view.talking ? (
            <Mic size={21} />
          ) : (
            <MicOff size={21} />
          )
        ) : view.microphone ? (
          <Mic size={21} />
        ) : (
          <MicOff size={21} />
        )}
        <span>
          {microphoneLimited
            ? t("media.control.mic.restricted")
            : view.pushToTalk
              ? view.talking
                ? t("media.control.ptt.talking")
                : t("media.control.ptt.label")
              : t("media.control.mic.label")}
        </span>
      </button>
      <button
        className={`control ${view.pushToTalk ? "selected" : ""}`}
        aria-label={
          view.pushToTalk
            ? t("media.control.ptt.off")
            : t("media.control.ptt.on")
        }
        aria-pressed={view.pushToTalk}
        title={
          view.pushToTalk
            ? t("media.control.ptt.enabledTitle")
            : t("media.control.ptt.title")
        }
        disabled={
          !view.pushToTalk &&
          (!ready || microphoneLimited || view.busy.includes("MICROPHONE"))
        }
        onClick={() => controller.setPushToTalk(!view.pushToTalk)}
      >
        {view.pushToTalk ? <Mic size={21} /> : <MicOff size={21} />}
        <span>
          {view.pushToTalk
            ? t("media.control.ptt.enabled")
            : t("media.control.ptt.label")}
        </span>
      </button>
      <button
        className={`control ${view.camera ? "selected" : ""}`}
        aria-label={
          cameraLimited
            ? t("media.control.camera.restrictedAria")
            : view.camera
              ? t("media.control.camera.off")
              : t("media.control.camera.on")
        }
        aria-pressed={view.camera}
        disabled={
          cameraLimited ||
          (!ready && !view.camera) ||
          view.busy.includes("CAMERA")
        }
        onClick={() => void controller.toggle("CAMERA")}
      >
        {view.camera ? <Video size={21} /> : <VideoOff size={21} />}
        <span>
          {cameraLimited
            ? t("media.control.camera.restricted")
            : t("media.control.camera.label")}
        </span>
      </button>
      <button
        className={`control ${view.screen ? "selected" : ""}`}
        aria-label={
          screenLimited
            ? t("media.control.screen.restrictedAria")
            : view.screen
              ? t("media.control.screen.off")
              : t("media.control.screen.on")
        }
        aria-pressed={view.screen}
        disabled={
          screenLimited ||
          (!ready && !view.screen) ||
          view.busy.includes("SCREEN")
        }
        onClick={() => void controller.toggleScreen()}
      >
        <MonitorUp size={21} />
        <span>
          {screenLimited
            ? t("media.control.screen.restricted")
            : t("media.control.screen.label")}
        </span>
      </button>
      <button
        className="control"
        aria-label={t("media.control.devices")}
        disabled={!controller.enabled}
        onClick={() => setSettings(true)}
      >
        <Settings2 size={21} />
        <span>{t("media.control.devices.short")}</span>
      </button>
      {settings && (
        <DeviceSettings
          controller={controller}
          view={view}
          close={() => setSettings(false)}
        />
      )}
    </>
  );
}

function DeviceSettings({
  controller,
  view,
  close,
}: {
  controller: MediaController;
  view: MediaView;
  close: () => void;
}) {
  const { t } = useLanguage();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState<TranslationKey | "">("");
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void navigator.mediaDevices
        .enumerateDevices()
        .then((list) => {
          if (alive) setDevices(list);
        })
        .catch(() => {
          if (alive) setError("media.settings.devicesError");
        });
    };
    refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener("devicechange", refresh);
    };
  }, [view.microphone, view.camera]);
  const errorMessage = error
    ? t(error)
    : mediaErrorMessage(view.error, view.errorTranslationKey, t);
  return (
    <Dialog title={t("media.settings.title")} close={close}>
      <div className="media-settings">
        <p>{t("media.settings.intro")}</p>
        {(
          [
            ["audioinput", t("media.settings.microphone"), view.inputDevice],
            ["videoinput", t("media.settings.camera"), view.cameraDevice],
            ["audiooutput", t("media.settings.speaker"), view.outputDevice],
          ] as const
        ).map(([kind, label, value]) => (
          <label key={kind}>
            {label}
            <select
              aria-label={t("media.settings.deviceLabel", { device: label })}
              value={value}
              disabled={
                kind === "audiooutput"
                  ? !("setSinkId" in HTMLMediaElement.prototype)
                  : view.busy.includes(
                      kind === "audioinput" ? "MICROPHONE" : "CAMERA",
                    )
              }
              onChange={(e) => void controller.setDevice(kind, e.target.value)}
            >
              <option value="">{t("media.settings.defaultDevice")}</option>
              {devices
                .filter((d) => d.kind === kind && d.deviceId)
                .map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `${label} ${i + 1}`}
                  </option>
                ))}
            </select>
          </label>
        ))}
        {!("setSinkId" in HTMLMediaElement.prototype) && (
          <small>{t("media.settings.speakerUnsupported")}</small>
        )}
        <div className="mic-test">
          <span>{t("media.settings.micInput")}</span>
          <MicrophoneMeter stream={view.microphoneStream} />
          <small>
            {view.microphone
              ? t("media.settings.micSpeak")
              : t("media.settings.micEnable")}
          </small>
        </div>
        {view.cameraStream && (
          <StreamVideo
            stream={view.cameraStream}
            label={t("media.settings.cameraPreview")}
            mirror
          />
        )}
        {errorMessage && <p role="alert">{errorMessage}</p>}
      </div>
    </Dialog>
  );
}

function MicrophoneMeter({ stream }: { stream?: MediaStream }) {
  const { t } = useLanguage();
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream) {
      setLevel(0);
      return;
    }
    const context = new AudioContext(),
      source = context.createMediaStreamSource(stream),
      analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      setLevel(
        Math.min(
          100,
          Math.sqrt(
            data.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) /
              data.length,
          ) * 350,
        ),
      );
    }, 100);
    void context.resume().catch(() => {});
    return () => {
      clearInterval(timer);
      source.disconnect();
      void context.close().catch(() => {});
    };
  }, [stream]);
  return (
    <meter
      aria-label={t("media.settings.micLevel")}
      min={0}
      max={100}
      value={level}
    />
  );
}

function StreamVideo({
  stream,
  label,
  mirror = false,
}: {
  stream: MediaStream;
  label: string;
  mirror?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current!;
    element.srcObject = stream;
    void element.play().catch(() => {});
    return () => {
      element.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={ref}
      aria-label={label}
      className={mirror ? "mirror" : ""}
      autoPlay
      playsInline
      muted
    />
  );
}
function TrackVideo({ item, label }: { item: RemoteMedia; label: string }) {
  const stream = useMemo(() => new MediaStream([item.track]), [item.track]);
  return <StreamVideo stream={stream} label={label} />;
}
function CameraTile({
  id,
  label,
  item,
  stream,
  mirror = false,
  pinned,
  onTogglePin,
}: {
  id: string;
  label: string;
  item?: RemoteMedia;
  stream?: MediaStream;
  mirror?: boolean;
  pinned: boolean;
  onTogglePin: (id: string) => void;
}) {
  const { t } = useLanguage();
  return (
    <figure
      className={`camera-tile ${pinned ? "pinned" : ""}`}
      data-player-id={id}
    >
      {item ? (
        <TrackVideo
          item={item}
          label={t("media.camera.videoLabel", { name: label })}
        />
      ) : stream ? (
        <StreamVideo
          stream={stream}
          label={t("media.camera.videoLabel", { name: label })}
          mirror={mirror}
        />
      ) : null}
      <figcaption>
        <span>{label}</span>
        <button
          type="button"
          className="camera-pin"
          aria-label={
            pinned
              ? t("media.camera.unpin", { name: label })
              : t("media.camera.pin", { name: label })
          }
          aria-pressed={pinned}
          title={
            pinned ? t("media.camera.unpinTitle") : t("media.camera.pinTitle")
          }
          onClick={() => onTogglePin(id)}
        >
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
      </figcaption>
    </figure>
  );
}
type CameraTileData = {
  id: string;
  label: string;
  item?: RemoteMedia;
  stream?: MediaStream;
  mirror: boolean;
};
function RemoteAudio({
  item,
  volume,
  output,
  playAttempt,
  blocked,
  report,
}: {
  item: RemoteMedia;
  volume: number;
  output: string;
  playAttempt: number;
  blocked: (id: string, value: boolean) => void;
  report: (error: unknown) => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current!;
    element.srcObject = new MediaStream([item.track]);
    let alive = true;
    void element
      .play()
      .then(() => {
        if (alive) blocked(item.id, false);
      })
      .catch(() => {
        if (alive) blocked(item.id, true);
      });
    return () => {
      alive = false;
      element.srcObject = null;
      blocked(item.id, false);
    };
  }, [item.id, item.track, playAttempt, blocked]);
  useEffect(() => {
    if (ref.current) ref.current.volume = Math.max(0, Math.min(1, volume));
  }, [volume]);
  useEffect(() => {
    const element = ref.current!;
    if ("setSinkId" in element)
      void (
        element as HTMLAudioElement & { setSinkId(id: string): Promise<void> }
      )
        .setSinkId(output)
        .catch(report);
  }, [output, report]);
  return (
    <audio
      ref={ref}
      autoPlay
      data-source={item.source}
      data-player-id={item.playerId}
    />
  );
}

interface FloatingFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}
type PanelInteraction = {
  pointerId: number;
  kind: "drag" | "resize";
  startX: number;
  startY: number;
  initial: FloatingFrame;
};

function getStageSize() {
  const stage = document.querySelector<HTMLElement>(".world-stage");
  const rect = stage?.getBoundingClientRect();
  return rect
    ? { width: rect.width, height: rect.height }
    : { width: window.innerWidth, height: window.innerHeight };
}

function clampFloatingFrame(
  frame: FloatingFrame,
  minWidth: number,
  minHeight: number,
): FloatingFrame {
  const stage = getStageSize();
  const maxWidth = Math.max(160, stage.width - 16);
  const maxHeight = Math.max(120, stage.height - 16);
  const width = Math.max(
    Math.min(minWidth, maxWidth),
    Math.min(frame.width, maxWidth),
  );
  const height = Math.max(
    Math.min(minHeight, maxHeight),
    Math.min(frame.height, maxHeight),
  );
  return {
    x: Math.min(Math.max(frame.x, 8), Math.max(8, stage.width - width - 8)),
    y: Math.min(Math.max(frame.y, 8), Math.max(8, stage.height - height - 8)),
    width,
    height,
  };
}

function sameFloatingFrame(left: FloatingFrame, right: FloatingFrame) {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function useFloatingFrame(
  storageKey: string,
  defaults: () => FloatingFrame,
  minWidth: number,
  minHeight: number,
  legacyDefault?: () => FloatingFrame,
) {
  const recalculateDefault = useRef(false);
  const [frame, setFrame] = useState<FloatingFrame>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const saved = clampFloatingFrame(
          JSON.parse(stored),
          minWidth,
          minHeight,
        );
        if (
          legacyDefault &&
          sameFloatingFrame(
            saved,
            clampFloatingFrame(legacyDefault(), minWidth, minHeight),
          )
        ) {
          recalculateDefault.current = true;
          return clampFloatingFrame(defaults(), minWidth, minHeight);
        }
        return saved;
      }
    } catch {
      // Storage can be unavailable in private browsing; the default layout still works.
    }
    recalculateDefault.current = true;
    return clampFloatingFrame(defaults(), minWidth, minHeight);
  });
  const interaction = useRef<PanelInteraction | undefined>(undefined);
  useLayoutEffect(() => {
    const resize = () => {
      if (recalculateDefault.current) {
        recalculateDefault.current = false;
        setFrame(clampFloatingFrame(defaults(), minWidth, minHeight));
      } else {
        setFrame((current) => clampFloatingFrame(current, minWidth, minHeight));
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [minWidth, minHeight]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(frame));
    } catch {
      // Keep the current window usable when storage is unavailable.
    }
  }, [frame, storageKey]);
  const start = (
    kind: PanelInteraction["kind"],
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (
      kind === "drag" &&
      (event.target as HTMLElement).closest("button, input, select, a")
    )
      return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    interaction.current = {
      pointerId: event.pointerId,
      kind,
      startX: event.clientX,
      startY: event.clientY,
      initial: frame,
    };
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const active = interaction.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    setFrame(
      clampFloatingFrame(
        active.kind === "drag"
          ? {
              ...active.initial,
              x: active.initial.x + dx,
              y: active.initial.y + dy,
            }
          : {
              ...active.initial,
              width: active.initial.width + dx,
              height: active.initial.height + dy,
            },
        minWidth,
        minHeight,
      ),
    );
  };
  const finish = (event: ReactPointerEvent<HTMLElement>) => {
    if (interaction.current?.pointerId !== event.pointerId) return;
    interaction.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeByKeyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    const delta = event.shiftKey ? 32 : 16;
    if (
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
    )
      return;
    event.preventDefault();
    setFrame((current) =>
      clampFloatingFrame(
        {
          ...current,
          width:
            current.width +
            (event.key === "ArrowRight"
              ? delta
              : event.key === "ArrowLeft"
                ? -delta
                : 0),
          height:
            current.height +
            (event.key === "ArrowDown"
              ? delta
              : event.key === "ArrowUp"
                ? -delta
                : 0),
        },
        minWidth,
        minHeight,
      ),
    );
  };
  const moveByKeyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const delta = event.shiftKey ? 32 : 16;
    if (
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
    )
      return;
    event.preventDefault();
    setFrame((current) =>
      clampFloatingFrame(
        {
          ...current,
          x:
            current.x +
            (event.key === "ArrowRight"
              ? delta
              : event.key === "ArrowLeft"
                ? -delta
                : 0),
          y:
            current.y +
            (event.key === "ArrowDown"
              ? delta
              : event.key === "ArrowUp"
                ? -delta
                : 0),
        },
        minWidth,
        minHeight,
      ),
    );
  };
  const style: CSSProperties = {
    position: "absolute",
    left: frame.x,
    top: frame.y,
    width: frame.width,
    height: frame.height,
  };
  return {
    frame,
    setFrame: (next: FloatingFrame) =>
      setFrame(clampFloatingFrame(next, minWidth, minHeight)),
    style,
    onDragStart: (event: ReactPointerEvent<HTMLElement>) =>
      start("drag", event),
    onResizeStart: (event: ReactPointerEvent<HTMLElement>) =>
      start("resize", event),
    onPointerMove: move,
    onPointerUp: finish,
    onPointerCancel: finish,
    onResizeKeyDown: resizeByKeyboard,
    onMoveKeyDown: moveByKeyboard,
  };
}

export function MediaStage({
  controller,
  view,
  policy,
  event,
  players,
  selfId,
  currentMapName,
}: {
  controller: MediaController;
  view: MediaView;
  policy?: MediaState;
  event?: EventState;
  players: PlayerView[];
  selfId: string;
  currentMapName: string;
}) {
  const { language, t } = useLanguage();
  const screenFrameDefault = () => {
    const stage = getStageSize();
    const hasCameraColumn = stage.width > 760;
    const left = stage.width <= 760 ? 8 : 24;
    const cameraColumn = hasCameraColumn ? 228 : 0;
    const cameraGap = hasCameraColumn ? 32 : 8;
    const widthLimit = Math.max(
      240,
      stage.width - left - 8 - cameraColumn - cameraGap,
    );
    const heightLimit = Math.max(170, stage.height - 138 - 16);
    const width = Math.min(widthLimit, (heightLimit - 40) * (16 / 9));
    return {
      x: left,
      y: 138,
      width,
      height: width * (9 / 16) + 40,
    };
  };
  const cameraFrameDefault = () => {
    const stage = getStageSize();
    const compactViewport = stage.width <= 640;
    const width = Math.min(
      stage.width - 16,
      compactViewport ? 128 : stage.width <= 760 ? 144 : 220,
    );
    return {
      x: Math.max(8, stage.width - width - 16),
      y: 84,
      width,
      height: compactViewport
        ? Math.min(220, Math.max(150, stage.height - 150))
        : Math.min(500, Math.max(220, stage.height - 150)),
    };
  };
  const screenPanel = useFloatingFrame(
    "hufs.media.screen-frame.v1",
    screenFrameDefault,
    240,
    150,
    () => ({ x: 24, y: 138, width: 500, height: 330 }),
  );
  const cameraPanel = useFloatingFrame(
    "hufs.media.camera-frame.v1",
    cameraFrameDefault,
    120,
    150,
    () => {
      const stage = getStageSize();
      return {
        x: Math.max(8, stage.width - 210),
        y: 84,
        width: 190,
        height: Math.min(430, Math.max(220, stage.height - 230)),
      };
    },
  );
  const screenRestoreFrame = useRef<FloatingFrame | undefined>(undefined);
  const [expanded, setExpanded] = useState(false),
    [blockedIds, setBlockedIds] = useState<string[]>([]),
    [playAttempt, setPlayAttempt] = useState(0),
    [volumeDialog, setVolumeDialog] = useState(false),
    [personalVolumes, setPersonalVolumes] = useState<Record<string, number>>(
      {},
    ),
    [screenAudioVolumes, setScreenAudioVolumes] = useState<
      Record<string, number>
    >({}),
    [cameraLayout, setCameraLayout] = useState<"strip" | "gallery">("strip"),
    [pinnedCameraId, setPinnedCameraId] = useState<string | null>(null),
    [pinnedScreen, setPinnedScreen] = useState(false);
  const [frontPanel, setFrontPanel] = useState<"camera" | "screen">("camera");
  const [blocked] = useState(
    () => (id: string, value: boolean) =>
      setBlockedIds((old) =>
        value
          ? old.includes(id)
            ? old
            : [...old, id]
          : old.filter((v) => v !== id),
      ),
  );
  const name = (id: string) =>
    players.find((p) => p.id === id)?.name ??
    event?.participants.find((participant) => participant.playerId === id)
      ?.name ??
    t("media.participant.fallback");
  const onlinePeerKey = players
    .filter((player) => player.id !== selfId)
    .map((player) => player.id)
    .sort()
    .join("\u0000");
  useEffect(() => {
    const onlineIds = new Set(
      onlinePeerKey ? onlinePeerKey.split("\u0000") : [],
    );
    setPersonalVolumes((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([id]) => onlineIds.has(id)),
      );
      return Object.keys(next).length === Object.keys(current).length
        ? current
        : next;
    });
    setScreenAudioVolumes((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([id]) => onlineIds.has(id)),
      );
      return Object.keys(next).length === Object.keys(current).length
        ? current
        : next;
    });
  }, [onlinePeerKey]);
  const audioPeers = [
    ...new Set((policy?.peers ?? []).filter((id) => id !== selfId)),
  ];
  const eventMode = Boolean(policy?.eventMode && event?.active);
  const eventSpeakerIds = new Set(event?.speakerPlayerIds ?? []);
  const eventSpeakerRank = (id: string) => {
    const index = event?.speakerPlayerIds.indexOf(id) ?? -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const activeMicrophones = new Set(
    view.remote
      .filter((item) => item.kind === "audio" && item.source === "MICROPHONE")
      .map((item) => item.playerId),
  );
  const activeScreenAudio = new Set(
    view.remote
      .filter((item) => item.kind === "audio" && item.source === "SCREEN_AUDIO")
      .map((item) => item.playerId),
  );
  const incomingVideoCount = view.remote.filter(
    (item) =>
      item.kind === "video" &&
      (item.source === "CAMERA" || item.source === "SCREEN"),
  ).length;
  const distanceVolume = (playerId: string) => {
    if (!policy) return 1;
    const self = players.find((player) => player.id === selfId);
    const other = players.find((player) => player.id === playerId);
    if (!self || !other) return 1;
    const distance = Math.hypot(self.x - other.x, self.y - other.y);
    return proximityAudioVolume(
      distance,
      policy.proximityEnterDistance,
      policy.proximityExitDistance,
      policy.kind === "PRIVATE",
    );
  };
  const screenItems = view.remote
    .filter((r) => r.source === "SCREEN")
    .sort(
      (left, right) =>
        eventSpeakerRank(left.playerId) - eventSpeakerRank(right.playerId),
    );
  const screen = screenItems[0];
  const cameras = view.remote
    .filter((r) => r.source === "CAMERA")
    .sort(
      (left, right) =>
        eventSpeakerRank(left.playerId) - eventSpeakerRank(right.playerId),
    );
  const cameraTiles: CameraTileData[] = [
    ...(view.cameraStream
      ? [
          {
            id: "__self__",
            label: view.microphone
              ? t("media.camera.self")
              : t("media.camera.selfMuted"),
            stream: view.cameraStream,
            mirror: true,
          },
        ]
      : []),
    ...cameras.map((item) => ({
      id: item.playerId,
      label: name(item.playerId),
      item,
      mirror: false,
    })),
  ];
  const pinnedCamera = cameraTiles.find(
    (camera) => camera.id === pinnedCameraId,
  );
  const unpinnedCameraTiles = pinnedCamera
    ? cameraTiles.filter((camera) => camera.id !== pinnedCamera.id)
    : cameraTiles;
  const cameraTileKey = cameraTiles
    .map((camera) => camera.id)
    .sort()
    .join("\u0000");
  const remoteCameraKey = cameras
    .map((camera) => `${camera.playerId}:${camera.id}`)
    .sort()
    .join("\u0000");
  useEffect(() => {
    for (const camera of cameras)
      controller.setCameraSpatialLayer(
        camera.playerId,
        camera.playerId === pinnedCameraId ? 1 : 0,
      );
  }, [controller, pinnedCameraId, remoteCameraKey]);
  useEffect(() => {
    if (
      pinnedCameraId &&
      !cameraTileKey.split("\u0000").includes(pinnedCameraId)
    )
      setPinnedCameraId(null);
  }, [cameraTileKey, pinnedCameraId]);
  useEffect(() => {
    if (!screen && !view.screenStream) setPinnedScreen(false);
  }, [screen, view.screenStream]);
  useEffect(() => {
    if (!eventMode) return;
    setCameraLayout("gallery");
    setPinnedCameraId((current) =>
      current && eventSpeakerIds.has(current) ? current : null,
    );
  }, [eventMode, event?.speakerPlayerIds.join("\u0000")]);
  const toggleCameraPin = (id: string) =>
    setPinnedCameraId((current) => (current === id ? null : id));
  const renderCameraTile = (camera: CameraTileData) => (
    <CameraTile
      key={camera.id}
      id={camera.id}
      label={camera.label}
      item={camera.item}
      stream={camera.stream}
      mirror={camera.mirror}
      pinned={camera.id === pinnedCameraId}
      onTogglePin={toggleCameraPin}
    />
  );
  const status = (() => {
    switch (view.status) {
      case "disabled":
        return t("media.call.disabled");
      case "connecting":
        return t("media.call.connecting");
      case "ready":
        return t(
          eventMode
            ? "media.call.eventListen"
            : policy?.kind === "PRIVATE"
              ? "media.call.private"
              : "media.call.nearby",
        );
      case "switching":
        return t("media.call.switching");
      case "silent":
        return t("media.call.silent");
      case "unavailable":
        return t("media.call.unavailable");
    }
  })();
  return (
    <>
      {view.remote
        .filter((r) => r.kind === "audio")
        .map((item) => (
          <RemoteAudio
            key={item.id}
            item={item}
            volume={
              (distanceVolume(item.playerId) *
                (personalVolumes[item.playerId] ?? 100) *
                (item.source === "SCREEN_AUDIO"
                  ? (screenAudioVolumes[item.playerId] ?? 100)
                  : 100)) /
              10000
            }
            output={view.outputDevice}
            playAttempt={playAttempt}
            blocked={blocked}
            report={controller.reportError}
          />
        ))}
      <div
        className="call-status"
        data-testid="call-status"
        data-status={view.status}
        role="status"
      >
        <span
          className={view.status === "ready" ? "call-dot ready" : "call-dot"}
        />
        <span>
          {status}
          {view.status === "ready"
            ? ` · ${t("media.call.peersAvailable", {
                count: formatNumber(language, policy?.peers.length ?? 0),
              })}`
            : ""}
        </span>
        {view.status === "unavailable" && (
          <button onClick={controller.retry}>{t("media.call.retry")}</button>
        )}
        {audioPeers.length > 0 && (
          <button
            type="button"
            className="peer-volume-trigger"
            onClick={() => setVolumeDialog(true)}
          >
            <Volume2 size={14} /> {t("media.call.volumeByPerson")}
          </button>
        )}
        {cameraTiles.length > 1 && (
          <button
            type="button"
            className="camera-layout-trigger"
            aria-label={
              cameraLayout === "gallery"
                ? t("media.call.cameraList")
                : t("media.call.cameraGallery")
            }
            aria-pressed={cameraLayout === "gallery"}
            onClick={() =>
              setCameraLayout((layout) =>
                layout === "gallery" ? "strip" : "gallery",
              )
            }
          >
            <Grid2X2 size={14} />
            {cameraLayout === "gallery"
              ? t("media.call.list")
              : t("media.call.gallery")}
          </button>
        )}
        {policy?.limited && (
          <small>
            {eventMode
              ? t("media.call.eventLimit")
              : t("media.call.nearbyLimit")}
          </small>
        )}
      </div>
      {event?.active && event && (
        <section
          className="event-media-summary"
          aria-label={t("media.event.participantsLabel")}
        >
          {eventSpeakerIds.has(selfId) && !policy?.eventSpeaker && (
            <p role="status">{t("media.event.speakerHint")}</p>
          )}
          <header>
            <span className="event-media-live" />
            <strong>{event.title}</strong>
            <small>
              {t("media.event.participantCount", {
                count: formatNumber(language, event.participants.length),
                peers: formatNumber(language, policy?.peers.length ?? 0),
                videos: formatNumber(language, incomingVideoCount),
              })}
            </small>
          </header>
          <div className="event-speaker-list">
            {event.speakerPlayerIds.map((id) => (
              <span className="event-speaker-chip" key={id}>
                {name(id)}
                {id === selfId ? t("media.event.self") : ""}
              </span>
            ))}
          </div>
          {event.description && (
            <p className="event-description">{event.description}</p>
          )}
          {event.resourceUrl &&
            /^https?:\/\/[^\s]+$/i.test(event.resourceUrl) && (
              <a
                className="event-resource-link"
                href={event.resourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t("media.event.openResource")}
              </a>
            )}
          <details className="event-participant-list">
            <summary>
              {t("media.event.participantList", {
                count: formatNumber(language, event.participants.length),
              })}
            </summary>
            <div className="event-participant-grid">
              {[...event.participants]
                .sort((left, right) =>
                  left.name.localeCompare(right.name, language),
                )
                .map((participant) => (
                  <span
                    className={
                      eventSpeakerIds.has(participant.playerId)
                        ? "is-speaker"
                        : ""
                    }
                    key={participant.playerId}
                    title={`${participant.name} · ${participant.mapName}`}
                  >
                    {participant.name}
                    {eventSpeakerIds.has(participant.playerId)
                      ? t("media.event.speaker")
                      : ""}
                    <small>
                      {participant.mapName === currentMapName
                        ? t("media.event.currentMap")
                        : participant.mapName}
                    </small>
                  </span>
                ))}
            </div>
          </details>
          {screen && (
            <p>
              <MonitorUp size={13} />
              {t("media.event.screenPriority", {
                name: name(screen.playerId),
              })}
            </p>
          )}
        </section>
      )}
      {volumeDialog && (
        <Dialog
          title={t("media.volume.title")}
          close={() => setVolumeDialog(false)}
        >
          <div className="peer-volume-settings">
            <p>{t("media.volume.intro")}</p>
            {audioPeers.length === 0 ? (
              <p className="peer-volume-empty">{t("media.volume.empty")}</p>
            ) : (
              <div className="peer-volume-list">
                {audioPeers.map((id) => {
                  const volume = personalVolumes[id] ?? 100;
                  return (
                    <label className="peer-volume-row" key={id}>
                      <span className="peer-volume-person">
                        <strong>{name(id)}</strong>
                        <small>
                          {activeMicrophones.has(id)
                            ? activeScreenAudio.has(id)
                              ? t("media.volume.micAndScreen")
                              : t("media.volume.mic")
                            : activeScreenAudio.has(id)
                              ? t("media.volume.screen")
                              : t("media.volume.muted")}
                        </small>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={volume}
                        aria-label={t("media.volume.personLabel", {
                          name: name(id),
                        })}
                        onChange={(event) =>
                          setPersonalVolumes((current) => ({
                            ...current,
                            [id]: Number(event.target.value),
                          }))
                        }
                      />
                      <output>
                        {volume === 0 ? t("media.volume.mute") : `${volume}%`}
                      </output>
                    </label>
                  );
                })}
              </div>
            )}
            <button
              type="button"
              className="peer-volume-reset"
              onClick={() => setPersonalVolumes({})}
              disabled={Object.keys(personalVolumes).length === 0}
            >
              {t("media.volume.reset")}
            </button>
          </div>
        </Dialog>
      )}
      {blockedIds.length > 0 && (
        <button
          className="enable-audio"
          onClick={() => {
            // play() must run synchronously within a user gesture for strict autoplay policies.
            document
              .querySelectorAll<HTMLAudioElement>(".world-stage audio")
              .forEach((element) => void element.play().catch(() => {}));
            setPlayAttempt((n) => n + 1);
          }}
        >
          <Volume2 size={16} />
          {t("media.audio.enable")}
        </button>
      )}
      {cameraTiles.length > 0 && (
        <div
          className={`camera-stage ${cameraLayout} ${pinnedCamera ? "has-pinned" : ""}`}
          style={{
            ...cameraPanel.style,
            zIndex: frontPanel === "camera" ? 7 : 5,
          }}
          onPointerDownCapture={() => setFrontPanel("camera")}
          onFocusCapture={() => setFrontPanel("camera")}
          role="region"
          aria-label={
            cameraLayout === "gallery"
              ? t("media.camera.galleryLabel")
              : t("media.camera.stageLabel")
          }
        >
          <header
            className="floating-panel-heading camera-stage-heading"
            tabIndex={0}
            aria-label={t("media.window.move", {
              name: t("media.camera.stageLabel"),
            })}
            onKeyDown={cameraPanel.onMoveKeyDown}
            onPointerDown={cameraPanel.onDragStart}
            onPointerMove={cameraPanel.onPointerMove}
            onPointerUp={cameraPanel.onPointerUp}
            onPointerCancel={cameraPanel.onPointerCancel}
          >
            <span>
              <Move size={14} aria-hidden="true" />
              {t("media.camera.stageLabel")}
              <small>{formatNumber(language, cameraTiles.length)}</small>
            </span>
          </header>
          {pinnedCamera && (
            <div className="camera-featured">
              {renderCameraTile(pinnedCamera)}
            </div>
          )}
          <div className="camera-tiles">
            {unpinnedCameraTiles.map(renderCameraTile)}
          </div>
          <button
            type="button"
            className="floating-panel-resize"
            aria-label={t("media.window.resize", {
              name: t("media.camera.stageLabel"),
            })}
            title={t("media.window.resizeHint")}
            onPointerDown={cameraPanel.onResizeStart}
            onPointerMove={cameraPanel.onPointerMove}
            onPointerUp={cameraPanel.onPointerUp}
            onPointerCancel={cameraPanel.onPointerCancel}
            onKeyDown={cameraPanel.onResizeKeyDown}
          />
        </div>
      )}
      {(screen || view.screenStream) && (
        <section
          className={`shared-screen ${expanded ? "expanded" : ""} ${pinnedScreen ? "pinned" : ""}`}
          style={{
            ...screenPanel.style,
            zIndex: expanded
              ? 10
              : pinnedScreen
                ? 9
                : frontPanel === "screen"
                  ? 7
                  : 5,
          }}
          onPointerDownCapture={() => setFrontPanel("screen")}
          onFocusCapture={() => setFrontPanel("screen")}
          aria-label={t("media.screen.label")}
        >
          <header
            className="floating-panel-heading"
            tabIndex={0}
            aria-label={t("media.window.move", {
              name: t("media.screen.label"),
            })}
            onKeyDown={screenPanel.onMoveKeyDown}
            onPointerDown={screenPanel.onDragStart}
            onPointerMove={screenPanel.onPointerMove}
            onPointerUp={screenPanel.onPointerUp}
            onPointerCancel={screenPanel.onPointerCancel}
          >
            <span>
              <Move size={14} aria-hidden="true" />
              <MonitorUp size={16} />
              {screen
                ? t("media.screen.remoteTitle", {
                    name: name(screen.playerId),
                  })
                : t("media.screen.selfTitle")}
            </span>
            <span className="shared-screen-actions">
              {view.screen && (
                <button
                  type="button"
                  className="stop-sharing"
                  aria-label={t("media.screen.stop")}
                  title={t("media.screen.stop")}
                  onClick={() => void controller.toggleScreen()}
                >
                  <VideoOff size={14} aria-hidden="true" />
                </button>
              )}
              {screen && activeScreenAudio.has(screen.playerId) && (
                <label className="screen-audio-volume">
                  <Volume2 size={14} aria-hidden="true" />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={screenAudioVolumes[screen.playerId] ?? 100}
                    aria-label={t("media.screen.volume", {
                      name: name(screen.playerId),
                    })}
                    onChange={(event) =>
                      setScreenAudioVolumes((current) => ({
                        ...current,
                        [screen.playerId]: Number(event.target.value),
                      }))
                    }
                  />
                  <output>{screenAudioVolumes[screen.playerId] ?? 100}%</output>
                </label>
              )}
              <button
                aria-label={
                  pinnedScreen ? t("media.screen.unpin") : t("media.screen.pin")
                }
                aria-pressed={pinnedScreen}
                title={
                  pinnedScreen ? t("media.screen.unpin") : t("media.screen.pin")
                }
                onClick={() => setPinnedScreen((value) => !value)}
              >
                {pinnedScreen ? <PinOff size={16} /> : <Pin size={16} />}
              </button>
              <button
                aria-label={
                  expanded ? t("media.screen.shrink") : t("media.screen.expand")
                }
                onClick={() => {
                  if (expanded) {
                    screenPanel.setFrame(
                      screenRestoreFrame.current ?? screenFrameDefault(),
                    );
                    screenRestoreFrame.current = undefined;
                    setExpanded(false);
                  } else {
                    screenRestoreFrame.current = screenPanel.frame;
                    const stage = getStageSize();
                    screenPanel.setFrame({
                      x: 8,
                      y: 8,
                      width: stage.width - 16,
                      height: stage.height - 16,
                    });
                    setExpanded(true);
                  }
                }}
              >
                {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </button>
            </span>
          </header>
          {screen ? (
            <TrackVideo
              item={screen}
              label={t("media.screen.remoteTitle", {
                name: name(screen.playerId),
              })}
            />
          ) : (
            <StreamVideo
              stream={view.screenStream!}
              label={t("media.screen.selfTitle")}
            />
          )}
          <button
            type="button"
            className="floating-panel-resize"
            aria-label={t("media.window.resize", {
              name: t("media.screen.label"),
            })}
            title={t("media.window.resizeHint")}
            onPointerDown={screenPanel.onResizeStart}
            onPointerMove={screenPanel.onPointerMove}
            onPointerUp={screenPanel.onPointerUp}
            onPointerCancel={screenPanel.onPointerCancel}
            onKeyDown={screenPanel.onResizeKeyDown}
          />
        </section>
      )}
      {view.error && (
        <div className="call-error" role="alert">
          <span>
            {view.errorTranslationKey
              ? t(view.errorTranslationKey)
              : view.error}
          </span>
          <button
            aria-label={t("media.error.dismiss")}
            onClick={controller.clearError}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}
