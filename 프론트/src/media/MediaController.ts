import type { Device, types } from "mediasoup-client";
import type {
  MediaOffer,
  MediaRequest,
  MediaState,
} from "../generated/protocol";
import {
  MediaError,
  type ConnectionStatus,
  type WorldConnection,
} from "../game/WorldConnection";
import { completeModeratedSources } from "./moderatedSources";
import type { TranslationKey } from "../i18n/language";
import { mediaErrorTranslationKey } from "./mediaError";
export type Source = MediaOffer["source"];
export interface RemoteMedia extends MediaOffer {
  track: MediaStreamTrack;
}
export interface MediaView {
  status:
    | "disabled"
    | "connecting"
    | "ready"
    | "switching"
    | "silent"
    | "unavailable";
  microphone: boolean;
  pushToTalk: boolean;
  talking: boolean;
  camera: boolean;
  screen: boolean;
  moderatedSources: Source[];
  busy: Source[];
  error: string;
  errorTranslationKey?: TranslationKey;
  remote: RemoteMedia[];
  cameraStream?: MediaStream;
  screenStream?: MediaStream;
  microphoneStream?: MediaStream;
  inputDevice: string;
  cameraDevice: string;
  outputDevice: string;
}
type CaptureBoundary = Pick<MediaState, "policyEpoch" | "domain"> & {
  selfId: string;
};
const CAPTURE_RECONNECT_WAIT_MS = 5_000;
const message = (error: unknown, context?: "screen") =>
  error instanceof DOMException
    ? ({
        NotAllowedError:
          context === "screen"
            ? "화면 공유 권한이 거부됐어요. 브라우저 공유 창에서 허용해 주세요."
            : "장치 권한이 허용되지 않았어요. 브라우저의 마이크·카메라 권한을 확인해 주세요.",
        NotFoundError: "사용할 수 있는 장치를 찾지 못했어요.",
        NotReadableError:
          "다른 앱이 장치를 사용하고 있어요. 장치 상태를 확인해 주세요.",
        OverconstrainedError:
          "선택한 장치를 사용할 수 없어요. 다른 장치를 골라 주세요.",
      }[error.name] ?? "미디어 장치를 사용할 수 없어요.")
    : error instanceof Error
      ? error.message
      : "통화 요청을 처리하지 못했어요.";

export class MediaController {
  private view: MediaView;
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private active = false;
  private generation = 0;
  private key = "";
  private policy?: MediaState;
  private hasWorldState = false;
  private lastWorldStatus?: ConnectionStatus;
  private lastWorldSelfId?: string;
  private lastWorldMedia?: MediaState;
  private device?: Device;
  private iceServers: RTCIceServer[] = [];
  private sendTransport?: types.Transport;
  private sendTransportPromise?: Promise<types.Transport | undefined>;
  private recvTransport?: types.Transport;
  private transportDisconnectTimers = new Map<
    types.Transport,
    ReturnType<typeof setTimeout>
  >();
  private tracks = new Map<Source, MediaStreamTrack>();
  private producers = new Map<Source, types.Producer>();
  private consumers = new Map<
    string,
    { consumer: types.Consumer; offer: MediaOffer }
  >();
  private preferredCameraLayers = new Map<string, 0 | 1>();
  private receiving = false;
  private receiveAgain = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private retries = 0;
  constructor(
    private connection: WorldConnection,
    readonly enabled: boolean,
  ) {
    this.view = {
      status: enabled ? "connecting" : "disabled",
      microphone: false,
      pushToTalk: false,
      talking: false,
      camera: false,
      screen: false,
      moderatedSources: [],
      busy: [],
      error: "",
      errorTranslationKey: undefined,
      remote: [],
      inputDevice: "",
      cameraDevice: "",
      outputDevice: "",
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.view;
  private update(patch: Partial<MediaView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  clearError = () => this.update({ error: "", errorTranslationKey: undefined });
  reportError = (error: unknown) => this.setError(error);
  private setError(
    error: unknown,
    status?: MediaView["status"],
    context?: "screen",
  ) {
    this.update({
      ...(status ? { status } : {}),
      error: message(error, context),
      errorTranslationKey: mediaErrorTranslationKey(error, context),
    });
  }
  start() {
    this.active = true;
    if (!this.enabled) return;
    this.hasWorldState = false;
    this.unsubscribe = this.connection.subscribe(this.worldChanged);
    this.worldChanged();
  }
  stop() {
    this.active = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.reconnectTimer);
    this.generation++;
    this.closeNetwork();
    this.stopDevices();
    this.update({ pushToTalk: false, talking: false });
    this.key = "";
    this.hasWorldState = false;
    this.lastWorldStatus = undefined;
    this.lastWorldSelfId = undefined;
    this.lastWorldMedia = undefined;
  }
  private worldChanged = () => {
    if (!this.active) return;
    const world = this.connection.getSnapshot(),
      next = world.media;
    // World snapshots arrive frequently for player movement. The media policy
    // keeps its reference until the server sends a real policy update, so skip
    // SFU reconciliation and remote-view updates for position-only snapshots.
    if (
      this.hasWorldState &&
      world.status === this.lastWorldStatus &&
      world.selfId === this.lastWorldSelfId &&
      next === this.lastWorldMedia
    )
      return;
    this.hasWorldState = true;
    this.lastWorldStatus = world.status;
    this.lastWorldSelfId = world.selfId;
    this.lastWorldMedia = next;
    this.policy = next;
    const moderatedSources = completeModeratedSources(
      next?.moderatedSources ?? [],
    );
    if (
      moderatedSources.includes("SCREEN") ||
      moderatedSources.includes("SCREEN_AUDIO")
    )
      this.stopScreen();
    for (const source of moderatedSources)
      if (
        source !== "SCREEN" &&
        source !== "SCREEN_AUDIO" &&
        this.tracks.has(source)
      )
        this.stopSource(source);
    if (moderatedSources.join(",") !== this.view.moderatedSources.join(","))
      this.update({ moderatedSources });
    if (
      world.status !== "online" ||
      !next?.available ||
      next.transitioning ||
      next.kind === "SILENT"
    ) {
      if (this.view.pushToTalk && this.view.talking) this.setPttTalking(false);
      const status = next?.transitioning
        ? "switching"
        : next?.kind === "SILENT"
          ? "silent"
          : world.status === "online" && next
            ? "unavailable"
            : "connecting";
      if (this.key || this.sendTransport || this.recvTransport) {
        this.generation++;
        this.closeNetwork();
        this.stopScreen();
        this.key = "";
      }
      if (
        status === "silent" ||
        status === "unavailable" ||
        world.status === "closed"
      )
        this.stopDevices();
      if (this.view.status !== status) this.update({ status });
      return;
    }
    // A live event changes the server-owned media domain without changing the
    // player session or policy epoch. Rebuild the SFU peer for that domain too.
    const key = `${world.selfId}:${next.policyEpoch}:${next.engineId}:${next.domain}`;
    if (key !== this.key) {
      if (this.view.pushToTalk && this.view.talking) this.setPttTalking(false);
      this.key = key;
      this.retries = 0;
      void this.connect();
    } else if (this.view.status === "ready") {
      // Revoke local remote tracks synchronously with the authoritative policy update.
      // receive() can already be awaiting an SFU RPC, so relying on its next pass can
      // leave an old audio element mounted after the world has removed the peer.
      this.pruneConsumers(next.offers ?? []);
      void this.receive();
    }
  };
  private rpc<T>(
    method: MediaRequest["method"],
    data: object,
    policyEpoch = this.policy?.policyEpoch,
  ) {
    if (!policyEpoch)
      return Promise.reject(
        new MediaError("MEDIA_STALE", "통화 연결을 준비하고 있어요."),
      );
    return this.connection.mediaRequest<T>(policyEpoch, method, data);
  }
  setCameraSpatialLayer(playerId: string, spatialLayer: 0 | 1) {
    const entry = [...this.consumers.entries()].find(
      ([, value]) =>
        value.offer.playerId === playerId && value.offer.source === "CAMERA",
    );
    if (!entry) return;
    const [producerId, { consumer }] = entry;
    const previous = this.preferredCameraLayers.get(producerId);
    if (
      previous === spatialLayer ||
      (previous === undefined && spatialLayer === 0)
    )
      return;
    this.preferredCameraLayers.set(producerId, spatialLayer);
    void this.rpc("setPreferredLayers", {
      consumerId: consumer.id,
      spatialLayer,
    }).catch((error) => {
      if (this.preferredCameraLayers.get(producerId) === spatialLayer)
        this.preferredCameraLayers.delete(producerId);
      if (
        !(error instanceof MediaError) ||
        !["MEDIA_STALE", "MEDIA_DENIED", "MEDIA_BUSY"].includes(error.code)
      )
        this.reportError(error);
    });
  }
  private current(gen: number) {
    return this.active && gen === this.generation;
  }
  private captureBoundary(source: Source): CaptureBoundary | undefined {
    const { selfId, media } = this.connection.getSnapshot();
    if (
      !media ||
      !media.available ||
      media.transitioning ||
      media.kind === "SILENT" ||
      completeModeratedSources(media.moderatedSources).includes(source)
    )
      return undefined;
    return { selfId, policyEpoch: media.policyEpoch, domain: media.domain };
  }
  private captureContextIsCurrent(source: Source, boundary: CaptureBoundary) {
    const world = this.connection.getSnapshot();
    const policy = this.policy;
    if (
      !this.active ||
      world.status === "closed" ||
      world.selfId !== boundary.selfId ||
      !policy
    )
      return false;
    return (
      policy.policyEpoch === boundary.policyEpoch &&
      policy.domain === boundary.domain &&
      !policy.transitioning &&
      policy.kind !== "SILENT" &&
      !completeModeratedSources(policy.moderatedSources).includes(source)
    );
  }
  private waitForCaptureTransport(
    source: Source,
    boundary: CaptureBoundary,
  ): Promise<number | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (generation: number | undefined) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(generation);
      };
      const inspect = () => {
        if (!this.captureContextIsCurrent(source, boundary)) {
          finish(undefined);
          return;
        }
        if (this.policy?.available && this.view.status === "ready")
          finish(this.generation);
      };
      unsubscribe = this.subscribe(inspect);
      timer = setTimeout(() => finish(undefined), CAPTURE_RECONNECT_WAIT_MS);
      inspect();
    });
  }
  private async connect() {
    const policy = this.policy;
    if (!policy?.available || policy.transitioning || policy.kind === "SILENT")
      return;
    const gen = ++this.generation;
    this.closeNetwork();
    this.stopScreen();
    this.update({
      status: "connecting",
      error: "",
      errorTranslationKey: undefined,
    });
    try {
      const { Device } = await import("mediasoup-client");
      if (!this.current(gen)) return;
      const caps = await this.rpc<{
        routerRtpCapabilities: types.RtpCapabilities;
        iceServers: RTCIceServer[];
      }>("capabilities", {}, policy.policyEpoch);
      if (!this.current(gen)) return;
      this.iceServers = caps.iceServers;
      const device = new Device();
      await device.load({ routerRtpCapabilities: caps.routerRtpCapabilities });
      if (!this.current(gen)) return;
      this.device = device;
      const receive = await this.rpc<types.TransportOptions>(
        "createTransport",
        { direction: "recv" },
        policy.policyEpoch,
      );
      if (!this.current(gen)) return;
      this.recvTransport = device.createRecvTransport({
        ...receive,
        iceServers: caps.iceServers,
      });
      this.bind(this.recvTransport, gen, policy.policyEpoch);
      this.update({ status: "ready" });
      for (const source of ["MICROPHONE", "CAMERA"] as const) {
        const track = this.tracks.get(source);
        if (track?.readyState === "live")
          await this.publish(source, track, gen);
      }
      if (this.current(gen)) {
        this.retries = 0;
        void this.receive();
      }
    } catch (error) {
      if (this.current(gen)) this.recover(error);
    }
  }
  private ensureSendTransport(gen: number, epoch: number) {
    if (this.sendTransport) return Promise.resolve(this.sendTransport);
    if (this.sendTransportPromise) return this.sendTransportPromise;
    const device = this.device;
    if (!device || !this.current(gen)) return Promise.resolve(undefined);

    const pending = (async () => {
      const send = await this.rpc<types.TransportOptions>(
        "createTransport",
        { direction: "send" },
        epoch,
      );
      if (!this.current(gen) || this.device !== device) return undefined;
      const transport = device.createSendTransport({
        ...send,
        iceServers: this.iceServers,
      });
      this.bind(transport, gen, epoch);
      transport.on(
        "produce",
        ({ kind, rtpParameters, appData }, callback, errback) => {
          if (!this.current(gen) || this.sendTransport !== transport) {
            errback(new Error("Connection changed"));
            return;
          }
          void this.rpc<{ id: string }>(
            "produce",
            {
              transportId: transport.id,
              kind,
              rtpParameters,
              source: appData.source,
            },
            epoch,
          )
            .then((result) => {
              if (this.current(gen) && this.sendTransport === transport)
                callback(result);
              else errback(new Error("Connection changed"));
            })
            .catch(errback);
        },
      );
      if (!this.current(gen) || this.device !== device) {
        transport.close();
        return undefined;
      }
      this.sendTransport = transport;
      return transport;
    })();
    this.sendTransportPromise = pending;
    void pending.then(
      () => {
        if (this.sendTransportPromise === pending)
          this.sendTransportPromise = undefined;
      },
      () => {
        if (this.sendTransportPromise === pending)
          this.sendTransportPromise = undefined;
      },
    );
    return this.sendTransportPromise;
  }
  private bind(transport: types.Transport, gen: number, epoch: number) {
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      if (!this.current(gen)) {
        errback(new Error("Connection changed"));
        return;
      }
      void this.rpc(
        "connectTransport",
        { transportId: transport.id, dtlsParameters },
        epoch,
      )
        .then(() => {
          if (this.current(gen)) callback();
          else errback(new Error("Connection changed"));
        })
        .catch(errback);
    });
    transport.on("connectionstatechange", (state) => {
      const timer = this.transportDisconnectTimers.get(transport);
      if (["connected", "failed", "closed"].includes(state) && timer) {
        clearTimeout(timer);
        this.transportDisconnectTimers.delete(transport);
      }
      if (state === "failed" && this.current(gen)) {
        this.recover(
          new MediaError(
            "MEDIA_UNAVAILABLE",
            "통화 연결이 끊겼어요. 다시 연결하고 있어요.",
          ),
        );
      } else if (state === "disconnected" && !timer) {
        const disconnectTimer = setTimeout(() => {
          this.transportDisconnectTimers.delete(transport);
          if (this.current(gen))
            this.recover(
              new MediaError(
                "MEDIA_UNAVAILABLE",
                "네트워크 연결이 복구되지 않아 다시 연결하고 있어요.",
              ),
            );
        }, 5000);
        this.transportDisconnectTimers.set(transport, disconnectTimer);
      }
    });
  }
  private recover(error: unknown) {
    this.generation++;
    this.closeNetwork();
    this.stopScreen();
    this.setError(error, "unavailable");
    clearTimeout(this.reconnectTimer);
    if (this.active && this.retries++ < 3)
      this.reconnectTimer = setTimeout(
        () => {
          if (
            this.policy?.available &&
            !this.policy.transitioning &&
            this.policy.kind !== "SILENT"
          )
            void this.connect();
        },
        Math.min(500 * 2 ** this.retries, 4000),
      );
    else this.stopDevices();
  }
  retry = () => {
    this.retries = 0;
    clearTimeout(this.reconnectTimer);
    void this.connect();
  };
  private closeNetwork() {
    for (const timer of this.transportDisconnectTimers.values())
      clearTimeout(timer);
    this.transportDisconnectTimers.clear();
    for (const { consumer } of this.consumers.values()) consumer.close();
    this.consumers.clear();
    this.preferredCameraLayers.clear();
    for (const producer of this.producers.values()) producer.close();
    this.producers.clear();
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = undefined;
    this.sendTransportPromise = undefined;
    this.recvTransport = undefined;
    this.device = undefined;
    this.iceServers = [];
    this.update({ remote: [] });
  }
  private async publish(source: Source, track: MediaStreamTrack, gen: number) {
    if (!this.current(gen) || track.readyState !== "live") return;
    const epoch = this.policy?.policyEpoch;
    if (epoch === undefined) return;
    const transport = await this.ensureSendTransport(gen, epoch);
    if (
      !transport ||
      !this.current(gen) ||
      this.view.status !== "ready" ||
      track.readyState !== "live"
    )
      return;
    const producer = await transport.produce({
      track,
      stopTracks: false,
      appData: { source },
      ...(source === "CAMERA"
        ? {
            encodings: [
              { scaleResolutionDownBy: 2, maxBitrate: 100_000 },
              { scaleResolutionDownBy: 1, maxBitrate: 450_000 },
            ],
          }
        : source === "SCREEN"
          ? { encodings: [{ maxBitrate: 1_800_000, maxFramerate: 15 }] }
          : { codecOptions: { opusDtx: true, opusFec: true } }),
    });
    if (!this.current(gen) || this.tracks.get(source) !== track) {
      producer.close();
      return;
    }
    this.producers.set(source, producer);
  }
  private async receive() {
    if (this.receiving) {
      this.receiveAgain = true;
      return;
    }
    if (this.view.status !== "ready" || !this.recvTransport || !this.device)
      return;
    this.receiving = true;
    const gen = this.generation;
    try {
      do {
        this.receiveAgain = false;
        const offers = this.policy?.offers ?? [];
        this.pruneConsumers(offers);
        this.remoteView();
        for (const offer of offers) {
          if (
            !this.current(gen) ||
            this.view.status !== "ready" ||
            !this.recvTransport ||
            !this.device
          )
            return;
          if (this.consumers.has(offer.id)) continue;
          let created: types.Consumer | undefined;
          let consumerId: string | undefined;
          const policyEpoch = this.policy?.policyEpoch;
          try {
            const result = await this.rpc<types.ConsumerOptions>("consume", {
              transportId: this.recvTransport.id,
              producerId: offer.id,
              rtpCapabilities: this.device.recvRtpCapabilities,
            });
            consumerId = result.id;
            if (!this.current(gen) || !this.recvTransport) return;
            const consumer = await this.recvTransport.consume(result);
            created = consumer;
            if (
              !this.current(gen) ||
              !this.policy?.offers.some((o) => o.id === offer.id)
            ) {
              consumer.close();
              void this.rpc("closeConsumer", { consumerId: consumer.id }).catch(
                () => {},
              );
              continue;
            }
            this.consumers.set(offer.id, { consumer, offer });
            await this.rpc("resumeConsumer", { consumerId: consumer.id });
            if (this.current(gen)) this.remoteView();
          } catch (error) {
            if (created) {
              created.close();
              if (this.consumers.get(offer.id)?.consumer === created)
                this.consumers.delete(offer.id);
            }
            if (consumerId) {
              void this.rpc("closeConsumer", { consumerId }, policyEpoch).catch(
                () => {},
              );
            }
            if (
              this.current(gen) &&
              !(
                error instanceof MediaError &&
                ["MEDIA_STALE", "MEDIA_DENIED", "MEDIA_BUSY"].includes(
                  error.code,
                )
              )
            )
              this.setError(error);
          }
        }
      } while (this.receiveAgain && this.current(gen));
    } finally {
      this.receiving = false;
      if (this.receiveAgain && this.active) void this.receive();
    }
  }
  private remoteView() {
    this.update({
      remote: [...this.consumers.values()]
        .filter((c) => !c.consumer.closed)
        .map(({ consumer, offer }) => ({ ...offer, track: consumer.track })),
    });
  }
  private pruneConsumers(offers: MediaOffer[]) {
    const available = new Set(offers.map((offer) => offer.id));
    let removed = false;
    for (const [id, value] of this.consumers)
      if (!available.has(id)) {
        value.consumer.close();
        this.consumers.delete(id);
        this.preferredCameraLayers.delete(id);
        removed = true;
        void this.rpc("closeConsumer", {
          consumerId: value.consumer.id,
        }).catch(() => {});
      }
    if (removed) this.remoteView();
  }
  private busy(source: Source, value: boolean) {
    this.update({
      busy: value
        ? [...this.view.busy.filter((s) => s !== source), source]
        : this.view.busy.filter((s) => s !== source),
    });
  }
  async toggle(source: "MICROPHONE" | "CAMERA", pttCapture = false) {
    if (this.view.busy.includes(source)) return;
    if (this.tracks.has(source)) {
      this.stopSource(source);
      return;
    }
    if (this.view.status !== "ready") return;
    const boundary = this.captureBoundary(source);
    if (!boundary) return;
    const gen = this.generation;
    this.busy(source, true);
    this.update({ error: "", errorTranslationKey: undefined });
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        source === "MICROPHONE"
          ? { audio: this.audioConstraints(), video: false }
          : { audio: false, video: this.videoConstraints() },
      );
      if (!this.captureContextIsCurrent(source, boundary)) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (pttCapture && !this.view.pushToTalk) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      let publishGeneration = gen;
      if (
        !this.current(gen) ||
        this.view.status !== "ready" ||
        !this.policy?.available
      ) {
        const recoveredGeneration = await this.waitForCaptureTransport(
          source,
          boundary,
        );
        if (
          recoveredGeneration === undefined ||
          !this.captureContextIsCurrent(source, boundary) ||
          (pttCapture && !this.view.pushToTalk)
        ) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        publishGeneration = recoveredGeneration;
      }
      const track = stream.getTracks()[0];
      if (source === "MICROPHONE" && this.view.pushToTalk)
        track.enabled = this.view.talking;
      this.installTrack(source, track);
      await this.publish(source, track, publishGeneration);
    } catch (error) {
      if (this.current(gen)) {
        this.stopSource(source);
        this.setError(error);
      }
    } finally {
      this.busy(source, false);
    }
  }
  async toggleScreen() {
    if (this.view.busy.includes("SCREEN")) return;
    if (this.tracks.has("SCREEN")) {
      this.stopScreen();
      return;
    }
    if (this.view.status !== "ready") return;
    const getDisplayMedia = navigator.mediaDevices?.getDisplayMedia;
    if (typeof getDisplayMedia !== "function") {
      this.update({
        error:
          "이 브라우저에서는 화면 공유를 지원하지 않아요. 마이크와 카메라는 계속 사용할 수 있어요.",
        errorTranslationKey: "media.error.screenUnsupported",
      });
      return;
    }
    const gen = this.generation;
    this.busy("SCREEN", true);
    this.update({ error: "", errorTranslationKey: undefined });
    let captured: MediaStream | undefined;
    try {
      // Called directly from the user's click; the browser always owns source selection.
      const stream = await getDisplayMedia.call(navigator.mediaDevices, {
        video: { frameRate: { ideal: 15, max: 15 } },
        audio: true,
      });
      captured = stream;
      if (!this.current(gen) || this.view.status !== "ready") {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = stream.getVideoTracks()[0];
      if (!video) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.contentHint = "detail";
      this.installTrack("SCREEN", video);
      await this.publish("SCREEN", video, gen);
      const audio = stream.getAudioTracks()[0];
      if (audio && this.current(gen)) {
        this.installTrack("SCREEN_AUDIO", audio);
        await this.publish("SCREEN_AUDIO", audio, gen);
      } else audio?.stop();
    } catch (error) {
      captured?.getTracks().forEach((track) => {
        if (![...this.tracks.values()].includes(track)) track.stop();
      });
      if (this.current(gen)) {
        this.stopScreen();
        this.setError(error, undefined, "screen");
      }
    } finally {
      this.busy("SCREEN", false);
    }
  }
  private audioConstraints(): MediaTrackConstraints {
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(this.view.inputDevice
        ? { deviceId: { exact: this.view.inputDevice } }
        : {}),
    };
  }
  private videoConstraints(): MediaTrackConstraints {
    return {
      width: { ideal: 640 },
      height: { ideal: 360 },
      frameRate: { ideal: 24, max: 24 },
      ...(this.view.cameraDevice
        ? { deviceId: { exact: this.view.cameraDevice } }
        : {}),
    };
  }
  private installTrack(source: Source, track: MediaStreamTrack) {
    this.tracks.set(source, track);
    track.onended = () => {
      if (this.tracks.get(source) === track) {
        if (source === "SCREEN") this.stopScreen();
        else this.stopSource(source);
      }
    };
    this.deviceView();
  }
  private deviceView() {
    const stream = (source: Source) => {
      const t = this.tracks.get(source);
      return t ? new MediaStream([t]) : undefined;
    };
    this.update({
      microphone: this.tracks.has("MICROPHONE"),
      camera: this.tracks.has("CAMERA"),
      screen: this.tracks.has("SCREEN"),
      microphoneStream: stream("MICROPHONE"),
      cameraStream: stream("CAMERA"),
      screenStream: stream("SCREEN"),
    });
  }
  private stopSource(source: Source) {
    const producer = this.producers.get(source);
    producer?.close();
    this.producers.delete(source);
    if (producer) void this.rpc("closeProducer", { source }).catch(() => {});
    const track = this.tracks.get(source);
    if (track) {
      track.onended = null;
      track.stop();
      this.tracks.delete(source);
    }
    if (source === "MICROPHONE" && this.view.talking)
      this.update({ talking: false });
    this.deviceView();
  }
  private stopScreen() {
    this.stopSource("SCREEN");
    this.stopSource("SCREEN_AUDIO");
  }
  private stopDevices() {
    for (const source of [...this.tracks.keys()]) this.stopSource(source);
    if (this.view.talking) this.update({ talking: false });
  }
  setPushToTalk(enabled: boolean) {
    if (enabled === this.view.pushToTalk) return;
    if (!enabled) {
      this.update({ pushToTalk: false, talking: false });
      this.stopSource("MICROPHONE");
      return;
    }
    if (
      this.view.status !== "ready" ||
      this.view.moderatedSources.includes("MICROPHONE") ||
      this.view.busy.includes("MICROPHONE")
    )
      return;
    this.update({ pushToTalk: true, talking: false });
    const track = this.tracks.get("MICROPHONE");
    if (track) track.enabled = false;
    else void this.toggle("MICROPHONE", true);
  }
  setPttTalking(pressed: boolean) {
    if (!this.view.pushToTalk) return;
    const allowed =
      pressed &&
      this.view.status === "ready" &&
      !this.view.moderatedSources.includes("MICROPHONE");
    if (this.view.talking !== allowed) this.update({ talking: allowed });
    const track = this.tracks.get("MICROPHONE");
    if (track) track.enabled = allowed;
    else if (allowed && !this.view.busy.includes("MICROPHONE"))
      void this.toggle("MICROPHONE", true);
  }
  async setDevice(
    kind: "audioinput" | "videoinput" | "audiooutput",
    value: string,
  ) {
    if (kind === "audiooutput") {
      this.update({ outputDevice: value });
      return;
    }
    const source = kind === "audioinput" ? "MICROPHONE" : "CAMERA";
    const previousDevice =
      kind === "audioinput" ? this.view.inputDevice : this.view.cameraDevice;
    this.update(
      kind === "audioinput" ? { inputDevice: value } : { cameraDevice: value },
    );
    if (!this.tracks.has(source) || this.view.busy.includes(source)) return;
    // A device change is an explicit user action; replace the track without changing its audience.
    this.busy(source, true);
    const gen = this.generation;
    let captured: MediaStream | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        source === "MICROPHONE"
          ? { audio: this.audioConstraints() }
          : { video: this.videoConstraints() },
      );
      captured = stream;
      const track = stream.getTracks()[0];
      if (source === "MICROPHONE" && this.view.pushToTalk)
        track.enabled = this.view.talking;
      if (!this.current(gen)) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const producer = this.producers.get(source);
      if (producer) await producer.replaceTrack({ track });
      if (!this.current(gen)) {
        track.stop();
        return;
      }
      const old = this.tracks.get(source);
      if (old) {
        old.onended = null;
        old.stop();
      }
      this.installTrack(source, track);
      if (!producer) await this.publish(source, track, gen);
      if (this.current(gen))
        this.update({ error: "", errorTranslationKey: undefined });
    } catch (error) {
      captured?.getTracks().forEach((track) => {
        if (this.tracks.get(source) !== track) track.stop();
      });
      if (this.current(gen)) {
        this.update(
          kind === "audioinput"
            ? { inputDevice: previousDevice }
            : { cameraDevice: previousDevice },
        );
        this.reportError(error);
      }
    } finally {
      this.busy(source, false);
    }
  }
}
