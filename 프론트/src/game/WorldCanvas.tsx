import { useEffect, useMemo, useRef, useState } from "react";
import type {
  MapDefinition,
  MapInteraction,
  Portal,
} from "../generated/protocol";
import type { WorldConnection } from "./WorldConnection";
import type {
  CampusScene,
  CampusSceneLabels,
  NearbyAmbientSound,
} from "./CampusScene";
import { worldFpsLimit, type WorldRenderMode } from "./renderPreference";
import { useLanguage } from "../i18n/language";

declare global {
  interface Window {
    __hufsRtcCapacityHeadless?: boolean;
    __hufsRtcCapacityHeadlessApplied?: boolean;
  }
}

export function WorldCanvas({
  map,
  connection,
  sceneRef,
  renderMode,
  onPortal,
  onInteraction,
  onAmbientSoundChange,
}: {
  map: MapDefinition;
  connection: WorldConnection;
  sceneRef: React.RefObject<CampusScene | null>;
  renderMode: WorldRenderMode;
  onPortal?: (portal: Portal, sourceMapId: string) => void;
  onInteraction?: (interaction: MapInteraction, objectId: string) => void;
  onAmbientSoundChange?: (sound?: NearbyAmbientSound) => void;
}) {
  const { t } = useLanguage();
  const labels = useMemo<CampusSceneLabels>(
    () => ({
      self: t("people.participant.self"),
      stage: t("editor.inspector.kind.stage"),
      unregisteredSpace: t("world.canvas.asset.unregisteredSpace"),
      space: t("world.canvas.asset.space"),
    }),
    [t],
  );
  const host = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const tRef = useRef(t);
  const labelsRef = useRef(labels);
  const onPortalRef = useRef(onPortal);
  const onInteractionRef = useRef(onInteraction);
  const onAmbientSoundChangeRef = useRef(onAmbientSoundChange);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  useEffect(() => {
    labelsRef.current = labels;
    sceneRef.current?.updateLabels(labels);
  }, [labels, sceneRef]);
  useEffect(() => {
    onPortalRef.current = onPortal;
  }, [onPortal]);
  useEffect(() => {
    onInteractionRef.current = onInteraction;
  }, [onInteraction]);
  useEffect(() => {
    onAmbientSoundChangeRef.current = onAmbientSoundChange;
  }, [onAmbientSoundChange]);
  useEffect(() => {
    if (import.meta.env.DEV && window.__hufsRtcCapacityHeadless === true) {
      sceneRef.current = null;
      window.__hufsRtcCapacityHeadlessApplied = true;
      return;
    }

    let disposed = false;
    let game: import("phaser").Game | undefined;
    let observer: ResizeObserver | undefined;
    setLoadError("");
    Promise.all([import("phaser"), import("./CampusScene")])
      .then(([{ default: Phaser }, { CampusScene }]) => {
        if (disposed || !host.current) return;
        const scene = new CampusScene(
          map,
          connection,
          (portal) => onPortalRef.current?.(portal, map.id),
          (interaction, objectId) =>
            onInteractionRef.current?.(interaction, objectId),
          (assetName) => {
            if (!disposed)
              setLoadError(
                tRef.current("world.canvas.error.asset", { name: assetName }),
              );
          },
          (sound) => onAmbientSoundChangeRef.current?.(sound),
          labelsRef.current,
        );
        sceneRef.current = scene;
        game = new Phaser.Game({
          type: Phaser.AUTO,
          parent: host.current,
          width: host.current.clientWidth,
          height: host.current.clientHeight,
          pixelArt: true,
          roundPixels: true,
          antialias: false,
          backgroundColor: "#c4d79a",
          fps: { limit: worldFpsLimit(renderMode) },
          scene: [scene],
          audio: { noAudio: true },
          input: { keyboard: false },
          scale: { mode: Phaser.Scale.RESIZE },
        });
        observer = new ResizeObserver(() => {
          if (host.current)
            game?.scale.resize(
              host.current.clientWidth,
              host.current.clientHeight,
            );
        });
        observer.observe(host.current);
      })
      .catch(() => {
        if (!disposed) setLoadError(tRef.current("world.canvas.error.load"));
      });
    return () => {
      disposed = true;
      observer?.disconnect();
      game?.destroy(true);
      sceneRef.current = null;
    };
  }, [map, connection, sceneRef, renderMode, retryKey]);
  return (
    <div
      ref={host}
      className="world-canvas"
      data-testid="world-canvas"
      role="application"
      tabIndex={0}
      aria-label={t("world.canvas.aria", { name: map.name })}
      aria-describedby="world-controls-description"
      onPointerDown={() => host.current?.focus({ preventScroll: true })}
    >
      {loadError && (
        <div className="world-asset-error" role="alert">
          <strong>{t("world.canvas.error.title")}</strong>
          <span>{loadError}</span>
          <small>{t("world.canvas.error.network")}</small>
          <button
            type="button"
            onClick={() => {
              setLoadError("");
              setRetryKey((current) => current + 1);
            }}
          >
            {t("world.canvas.retry")}
          </button>
        </div>
      )}
    </div>
  );
}
