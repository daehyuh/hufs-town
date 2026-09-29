import { useEffect, useRef, useState } from "react";
import { Camera, Mic, MicOff, Volume2, X } from "lucide-react";
import { Dialog } from "../components/Dialog";
import {
  formatNumber,
  translate,
  useLanguage,
  type Language,
  type TranslationKey,
} from "../i18n/language";
import "./media.css";

type InputKind = "microphone" | "camera";

function release(stream?: MediaStream) {
  stream?.getTracks().forEach((track) => {
    track.onended = null;
    track.stop();
  });
}

function deviceError(error: unknown, language: Language) {
  if (error instanceof Error && error.message === "MEDIA_PREFLIGHT_NO_TRACK")
    return translate(language, "media.preflight.error.noTrack");
  if (error instanceof DOMException) {
    const key: Record<string, TranslationKey> = {
      NotAllowedError: "media.preflight.error.denied",
      NotFoundError: "media.preflight.error.missing",
      NotReadableError: "media.preflight.error.busy",
      OverconstrainedError: "media.preflight.error.constraint",
    };
    return translate(
      language,
      key[error.name] ?? "media.preflight.error.device",
    );
  }
  if (language === "ko" && error instanceof Error) return error.message;
  return translate(language, "media.preflight.error.generic");
}

export function MediaPreflight({
  close,
  enter,
  canEnter,
}: {
  close: () => void;
  enter: () => void;
  canEnter: boolean;
}) {
  const { language, t } = useLanguage();
  const languageRef = useRef(language);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [microphone, setMicrophone] = useState<MediaStream | undefined>(
    undefined,
  );
  const [camera, setCamera] = useState<MediaStream | undefined>(undefined);
  const [inputDevice, setInputDevice] = useState("");
  const [cameraDevice, setCameraDevice] = useState("");
  const [outputDevice, setOutputDevice] = useState("");
  const [busy, setBusy] = useState<InputKind | "speaker">();
  const [error, setError] = useState("");
  const [speakerMessage, setSpeakerMessage] = useState("");
  const microphoneRef = useRef<MediaStream | undefined>(undefined);
  const cameraRef = useRef<MediaStream | undefined>(undefined);
  const outputCleanup = useRef<(() => void) | undefined>(undefined);
  const cameraElement = useRef<HTMLVideoElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((list) => {
          if (mounted.current) setDevices(list);
        })
        .catch(() => {
          if (mounted.current)
            setError(
              translate(languageRef.current, "media.preflight.error.list"),
            );
        });
    };
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => {
      mounted.current = false;
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
      release(microphoneRef.current);
      release(cameraRef.current);
      outputCleanup.current?.();
    };
  }, []);

  useEffect(() => {
    const element = cameraElement.current;
    if (!element) return;
    element.srcObject = camera ?? null;
    if (camera) void element.play().catch(() => {});
    return () => {
      element.srcObject = null;
    };
  }, [camera]);

  async function toggleInput(kind: InputKind, selectedId?: string) {
    const current =
      kind === "microphone" ? microphoneRef.current : cameraRef.current;
    if (current && selectedId === undefined) {
      release(current);
      if (kind === "microphone") {
        microphoneRef.current = undefined;
        setMicrophone(undefined);
      } else {
        cameraRef.current = undefined;
        setCamera(undefined);
      }
      return;
    }
    if (busy) return;
    const devicesApi = navigator.mediaDevices;
    if (!window.isSecureContext || !devicesApi?.getUserMedia) {
      setError(t("media.preflight.error.secure"));
      return;
    }
    setBusy(kind);
    setError("");
    try {
      const constraints: MediaStreamConstraints =
        kind === "microphone"
          ? {
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                ...(selectedId ? { deviceId: { exact: selectedId } } : {}),
              },
              video: false,
            }
          : {
              audio: false,
              video: {
                width: { ideal: 640 },
                height: { ideal: 360 },
                ...(selectedId ? { deviceId: { exact: selectedId } } : {}),
              },
            };
      const stream = await devicesApi.getUserMedia(constraints);
      if (!mounted.current) {
        release(stream);
        return;
      }
      const track = stream.getTracks()[0];
      if (!track) {
        release(stream);
        throw new Error("MEDIA_PREFLIGHT_NO_TRACK");
      }
      track.onended = () => {
        if (kind === "microphone" && microphoneRef.current === stream) {
          microphoneRef.current = undefined;
          setMicrophone(undefined);
        }
        if (kind === "camera" && cameraRef.current === stream) {
          cameraRef.current = undefined;
          setCamera(undefined);
        }
      };
      if (kind === "microphone") {
        release(microphoneRef.current);
        microphoneRef.current = stream;
        setMicrophone(stream);
        if (selectedId !== undefined) setInputDevice(selectedId);
      } else {
        release(cameraRef.current);
        cameraRef.current = stream;
        setCamera(stream);
        if (selectedId !== undefined) setCameraDevice(selectedId);
      }
      void devicesApi
        .enumerateDevices()
        .then((list) => {
          if (mounted.current) setDevices(list);
        })
        .catch(() => {});
    } catch (cause) {
      if (mounted.current) setError(deviceError(cause, languageRef.current));
    } finally {
      if (mounted.current) setBusy(undefined);
    }
  }

  async function testSpeaker() {
    if (busy) return;
    outputCleanup.current?.();
    setBusy("speaker");
    setError("");
    setSpeakerMessage("");
    let context: AudioContext | undefined;
    let oscillator: OscillatorNode | undefined;
    let audio: HTMLAudioElement | undefined;
    let speakerStream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (timer) clearTimeout(timer);
      if (started) {
        try {
          oscillator?.stop();
        } catch {
          /* The tone may already have ended. */
        }
      }
      audio?.pause();
      if (audio) audio.srcObject = null;
      release(speakerStream);
      context?.close().catch(() => {});
      if (outputCleanup.current === cleanup) outputCleanup.current = undefined;
    };
    outputCleanup.current = cleanup;
    try {
      context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      speakerStream = destination.stream;
      oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 440;
      gain.gain.value = 0.12;
      oscillator.connect(gain).connect(destination);
      audio = document.createElement("audio");
      audio.srcObject = destination.stream;
      const setSinkId = (
        audio as HTMLAudioElement & {
          setSinkId?: (id: string) => Promise<void>;
        }
      ).setSinkId;
      if (outputDevice && setSinkId) await setSinkId.call(audio, outputDevice);
      if (!mounted.current) {
        cleanup();
        return;
      }
      await context.resume();
      if (!mounted.current) {
        cleanup();
        return;
      }
      await audio.play();
      if (!mounted.current) {
        cleanup();
        return;
      }
      oscillator.start();
      started = true;
      setSpeakerMessage(t("media.preflight.speaker.playing"));
      timer = setTimeout(() => {
        cleanup();
        if (!mounted.current) return;
        setBusy(undefined);
        setSpeakerMessage(
          translate(languageRef.current, "media.preflight.speaker.ready"),
        );
      }, 1100);
    } catch (cause) {
      cleanup();
      if (!mounted.current) return;
      setBusy(undefined);
      setError(deviceError(cause, languageRef.current));
    }
  }

  const mediaAvailable =
    window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  const mediaWarning = !window.isSecureContext
    ? t("media.preflight.warning.secure")
    : !navigator.mediaDevices?.getUserMedia
      ? t("media.preflight.warning.unsupported")
      : "";
  return (
    <Dialog
      title={t("media.preflight.title")}
      close={close}
      closeLabel={t("dialog.close")}
    >
      <div className="media-preflight">
        <p className="media-preflight-intro">{t("media.preflight.intro")}</p>
        {mediaWarning && (
          <p className="media-preflight-warning" role="status">
            {mediaWarning}
          </p>
        )}
        <section className="media-preflight-device">
          <div className="media-preflight-heading">
            <span>
              <Mic size={17} /> {t("media.settings.microphone")}
            </span>
            <button
              type="button"
              disabled={!mediaAvailable || !!busy}
              onClick={() => void toggleInput("microphone")}
            >
              {microphone ? (
                <>
                  <MicOff size={15} />
                  {t("media.preflight.microphone.stop")}
                </>
              ) : (
                <>
                  <Mic size={15} />
                  {t("media.preflight.microphone.test")}
                </>
              )}
            </button>
          </div>
          <label>
            {t("media.preflight.microphone.input")}
            <select
              aria-label={t("media.preflight.microphone.device")}
              value={inputDevice}
              disabled={!mediaAvailable || !!busy}
              onChange={(event) => {
                const value = event.target.value;
                setInputDevice(value);
                if (microphone) void toggleInput("microphone", value);
              }}
            >
              <option value="">
                {t("media.preflight.microphone.default")}
              </option>
              {devices
                .filter(
                  (device) => device.kind === "audioinput" && device.deviceId,
                )
                .map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label ||
                      t("media.preflight.microphone.option", {
                        index: formatNumber(language, index + 1),
                      })}
                  </option>
                ))}
            </select>
          </label>
          <div className="media-preflight-meter">
            <span>{t("media.preflight.microphone.level")}</span>
            <MicrophoneMeter stream={microphone} />
          </div>
          <small>
            {microphone
              ? t("media.preflight.microphone.detected")
              : t("media.preflight.microphone.start")}
          </small>
        </section>
        <section className="media-preflight-device">
          <div className="media-preflight-heading">
            <span>
              <Camera size={17} /> {t("media.settings.camera")}
            </span>
            <button
              type="button"
              disabled={!mediaAvailable || !!busy}
              onClick={() => void toggleInput("camera")}
            >
              {camera ? (
                <>
                  <X size={15} /> {t("media.preflight.camera.stop")}
                </>
              ) : (
                <>
                  <Camera size={15} /> {t("media.preflight.camera.preview")}
                </>
              )}
            </button>
          </div>
          <label>
            {t("media.preflight.camera.device")}
            <select
              aria-label={t("media.preflight.camera.aria")}
              value={cameraDevice}
              disabled={!mediaAvailable || !!busy}
              onChange={(event) => {
                const value = event.target.value;
                setCameraDevice(value);
                if (camera) void toggleInput("camera", value);
              }}
            >
              <option value="">{t("media.preflight.camera.default")}</option>
              {devices
                .filter(
                  (device) => device.kind === "videoinput" && device.deviceId,
                )
                .map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label ||
                      t("media.preflight.camera.option", {
                        index: formatNumber(language, index + 1),
                      })}
                  </option>
                ))}
            </select>
          </label>
          {camera ? (
            <video
              ref={cameraElement}
              className="media-preflight-video"
              aria-label={t("media.settings.cameraPreview")}
              autoPlay
              playsInline
              muted
            />
          ) : (
            <div className="media-preflight-camera-empty">
              {t("media.preflight.camera.empty")}
            </div>
          )}
        </section>
        <section className="media-preflight-device">
          <div className="media-preflight-heading">
            <span>
              <Volume2 size={17} /> {t("media.settings.speaker")}
            </span>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void testSpeaker()}
            >
              <Volume2 size={15} /> {t("media.preflight.speaker.test")}
            </button>
          </div>
          <label>
            {t("media.preflight.speaker.output")}
            <select
              aria-label={t("media.preflight.speaker.device")}
              value={outputDevice}
              disabled={!!busy || !("setSinkId" in HTMLMediaElement.prototype)}
              onChange={(event) => setOutputDevice(event.target.value)}
            >
              <option value="">{t("media.preflight.speaker.default")}</option>
              {devices
                .filter(
                  (device) => device.kind === "audiooutput" && device.deviceId,
                )
                .map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label ||
                      t("media.preflight.speaker.option", {
                        index: formatNumber(language, index + 1),
                      })}
                  </option>
                ))}
            </select>
          </label>
          {speakerMessage && <small role="status">{speakerMessage}</small>}
          {!("setSinkId" in HTMLMediaElement.prototype) && (
            <small>{t("media.preflight.speaker.fallback")}</small>
          )}
        </section>
        {error && (
          <p className="media-preflight-error" role="alert">
            {error}
          </p>
        )}
        <div className="media-preflight-actions">
          <button
            type="button"
            className="media-preflight-secondary"
            onClick={close}
          >
            {t("media.preflight.action.later")}
          </button>
          <button
            type="button"
            className="media-preflight-primary"
            disabled={!canEnter}
            onClick={enter}
          >
            {t("media.preflight.action.enter")}
          </button>
        </div>
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
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      context = new AudioContext();
      source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      timer = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        setLevel(
          Math.min(
            100,
            Math.sqrt(
              data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) /
                data.length,
            ) * 350,
          ),
        );
      }, 100);
      void context.resume().catch(() => {});
    } catch {
      setLevel(0);
    }
    return () => {
      if (timer) clearInterval(timer);
      source?.disconnect();
      void context?.close().catch(() => {});
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
