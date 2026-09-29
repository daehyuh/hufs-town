import Phaser from "phaser";
import type {
  ChatEvent,
  MapDefinition,
  MapInteraction,
  MapObject,
  Portal,
  PokeEvent,
  EmoteEvent,
  PlayerView,
  Snapshot,
} from "../generated/protocol";
import type { WorldConnection } from "./WorldConnection";
import {
  buildMovementCollisionGrid,
  movementFacingDirection,
  step,
  type MovementCollisionGrid,
} from "./movement";
import { avatarFrame } from "./avatarFrames";
import { ASSETS_BY_ID, objectBounds } from "./officeAssets";
import {
  TILE,
  mapRenderChunks,
  paintFloor,
  paintLabels,
  paintPortals,
  paintStageZoneLabels,
  paintStageZones,
  paintWall,
  type MapRenderChunk,
} from "./renderMap";
import { ASSET_GROUPS } from "../generated/assetGroups";
import {
  buildNavigationGraph,
  navigationFollowTarget,
  navigationPathTo,
  type NavigationGraph,
} from "./navigation";
import { AvatarTextureReferences } from "./avatarTextureReferences";
import { findPokeTarget } from "./pokeTarget";
import { emoteForShortcut } from "./emoteOptions";

const CLICK_MOVEMENT_UPDATE_MS = 24;
const MANUAL_MOVEMENT_UPDATE_MS = 50;

const emoji: Record<string, string> = {
  wave: "👋",
  heart: "💚",
  clap: "👏",
  sparkles: "✨",
  laugh: "😄",
  thumbsup: "👍",
  sad: "😢",
  sit: "🪑",
  party: "🎉",
  thinking: "🤔",
  hands: "🙌",
  wow: "😮",
  fire: "🔥",
};
interface Avatar {
  root: Phaser.GameObjects.Container;
  seat: Phaser.GameObjects.Graphics;
  layers: Phaser.GameObjects.Sprite[];
  textureKeys: string[];
  nameLabel: Phaser.GameObjects.Text;
  microphoneBadge: Phaser.GameObjects.Graphics;
  microphoneOn: boolean | null;
  bubble: Phaser.GameObjects.Text;
  chatBubble: Phaser.GameObjects.Container;
  chatBubbleBackground: Phaser.GameObjects.Graphics;
  chatBubbleText: Phaser.GameObjects.Text;
  chatBubbleUntil: number;
  chatBubbleMessageId: string;
  pokeStartedAt: number;
  pokeUntil: number;
  pokeEmojiUntil: number;
  lastPokeRequestId: string;
  state: PlayerView;
  sittingVisual: boolean;
  targetX: number;
  targetY: number;
  walkTime: number;
}
interface PendingMovementInput {
  seq: number;
  dx: number;
  dy: number;
  running: boolean;
  sentAt: number;
}
export interface NearbyAmbientSound {
  objectId: string;
  title: string;
  url: string;
  volume: number;
}
export interface CampusSceneLabels {
  self: string;
  stage: string;
  unregisteredSpace: string;
  space: string;
}
export class CampusScene extends Phaser.Scene {
  private movementGrid: MovementCollisionGrid;
  private avatars = new Map<string, Avatar>();
  private avatarTextureReferences = new AvatarTextureReferences();
  private loadingAvatarTextures = new Set<string>();
  private failedAvatarTextures = new Set<string>();
  private mapAssetIds = new Set<string>();
  private keys = new Set<string>();
  private touchVector = { x: 0, y: 0 };
  private touchRunning = false;
  private clickPath: Array<{ x: number; y: number }> = [];
  private clickPathSegment = 0;
  private clickNavigationGraph?: NavigationGraph;
  private clickZoneId = "";
  private cameraFocusTarget?: { x: number; y: number };
  private pendingObjectInteraction?: MapObject;
  private ambientSoundObjectId = "";
  private ambientSoundVolume = -1;
  private clickMarker?: Phaser.GameObjects.Arc;
  private stageLabelLayers: Array<{
    chunk: MapRenderChunk;
    texture: Phaser.Textures.CanvasTexture;
  }> = [];
  private stopSnapshots?: () => void;
  private stopChatEvents?: () => void;
  private stopPokeEvents?: () => void;
  private stopEmoteEvents?: () => void;
  private pendingChat = new Map<
    string,
    { event: ChatEvent; expiresAt: number }
  >();
  private pendingPokes = new Map<
    string,
    { event: PokeEvent; expiresAt: number }
  >();
  private pendingEmotes = new Map<
    string,
    Array<{ event: EmoteEvent; expiresAt: number }>
  >();
  private floatingEmotes = new Set<Phaser.GameObjects.Text>();
  private emoteVisualSequence = 0;
  private lastInput = 0;
  private lastDirection = "";
  private lastMovementAck = -1;
  private pendingMovementInputs: PendingMovementInput[] = [];
  private focus = true;
  private zoomLevel = 1;
  private ready = false;
  constructor(
    private map: MapDefinition,
    private connection: WorldConnection,
    private onPortal?: (portal: Portal) => void,
    private onInteraction?: (
      interaction: MapInteraction,
      objectId: string,
    ) => void,
    private onAssetError?: (assetName: string) => void,
    private onAmbientSoundChange?: (sound?: NearbyAmbientSound) => void,
    private labels: CampusSceneLabels = {
      self: "나",
      stage: "무대",
      unregisteredSpace: "등록되지 않은 공간",
      space: "공간",
    },
  ) {
    super("campus");
    this.movementGrid = buildMovementCollisionGrid(map);
  }
  private canRenderObjects() {
    const factory = this.add as unknown as { displayList?: unknown } | null;
    return this.ready && factory?.displayList != null;
  }
  updateLabels(labels: CampusSceneLabels) {
    const stageChanged = this.labels.stage !== labels.stage;
    const selfChanged = this.labels.self !== labels.self;
    this.labels = labels;
    if (!this.ready) return;
    if (stageChanged) this.repaintStageLabelLayers();
    if (selfChanged) {
      const selfId = this.connection.getSnapshot().selfId;
      for (const [id, avatar] of this.avatars) {
        avatar.nameLabel.setText(
          `${avatar.state.name}${id === selfId ? ` · ${this.labels.self}` : ""}`,
        );
        this.layoutNameTag(avatar);
      }
    }
  }
  private createStageLabelLayers() {
    if (!this.map.zones.some((zone) => zone.kind === "STAGE")) return;
    for (const chunk of mapRenderChunks(this.map.width, this.map.height)) {
      const width = chunk.width * TILE;
      const height = chunk.height * TILE;
      const texture = this.textures.createCanvas(
        `office-stage-labels-${chunk.x}-${chunk.y}`,
        width,
        height,
      );
      if (!texture) continue;
      this.stageLabelLayers.push({ chunk, texture });
      this.add
        .image(chunk.x * TILE, chunk.y * TILE, texture.key)
        .setOrigin(0)
        .setDepth(-9);
      this.paintStageLabelLayer(chunk, texture);
    }
  }
  private repaintStageLabelLayers() {
    for (const { chunk, texture } of this.stageLabelLayers)
      this.paintStageLabelLayer(chunk, texture);
  }
  private paintStageLabelLayer(
    chunk: MapRenderChunk,
    texture: Phaser.Textures.CanvasTexture,
  ) {
    const context = texture.getContext();
    context.clearRect(0, 0, texture.width, texture.height);
    context.save();
    context.beginPath();
    context.rect(0, 0, texture.width, texture.height);
    context.clip();
    context.translate(-chunk.x * TILE, -chunk.y * TILE);
    paintStageZoneLabels(context, this.map, this.labels.stage);
    context.restore();
    texture.refresh();
  }
  private hasClickRoute() {
    return (
      this.clickPath.length > 1 &&
      this.clickPathSegment < this.clickPath.length - 1
    );
  }
  private clearClickRoute() {
    this.clickPath = [];
    this.clickPathSegment = 0;
    this.clickNavigationGraph = undefined;
    this.clickMarker?.setVisible(false);
  }
  preload() {
    this.load.on("loaderror", this.onMapAssetFailed);
    for (const asset of ASSET_GROUPS.avatarSheets)
      this.load.spritesheet(asset.id, asset.url, {
        frameWidth: asset.frameWidth,
        frameHeight: asset.frameHeight,
      });
    const assetIds = new Set(this.map.objects.map((object) => object.asset));
    for (const id of assetIds) {
      this.mapAssetIds.add(id);
      const asset = ASSETS_BY_ID.get(id);
      if (!asset) {
        this.onAssetError?.(this.labels.unregisteredSpace);
        continue;
      }
      if (asset.url.endsWith(".svg"))
        this.load.svg(asset.id, asset.url, {
          width: asset.width * 2,
          height: asset.height * 2,
        });
      else this.load.image(asset.id, asset.url);
    }
  }
  create() {
    this.paintWorld();
    this.cameras.main.setZoom(this.zoomLevel);
    this.cameras.main.setBounds(
      0,
      0,
      this.map.width * TILE,
      this.map.height * TILE,
    );
    this.cameras.main.centerOn(
      this.map.spawnX * TILE,
      this.map.spawnY * TILE - 90,
    );
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onScaleResize);
    this.cameras.main.setBackgroundColor("#67796e");
    this.ready = true;
    this.stopSnapshots = this.connection.onSnapshot((s) => this.receive(s));
    this.stopChatEvents = this.connection.onChatEvent((event) =>
      this.receiveChat(event),
    );
    this.stopPokeEvents = this.connection.onPokeEvent((event) =>
      this.receivePoke(event),
    );
    this.stopEmoteEvents = this.connection.onEmoteEvent((event) =>
      this.receiveEmote(event),
    );
    this.load.on("filecomplete", this.onAvatarTextureLoaded);
    this.load.on("loaderror", this.onAvatarTextureFailed);
    this.receive({
      type: "snapshot",
      tick: 0,
      serverTime: 0,
      full: true,
      baseTick: -1,
      inputAckSeq: -1,
      mapRevision: this.map.revision,
      players: this.connection.getSnapshot().players,
      removedPlayerIds: [],
      rooms: this.connection.getSnapshot().rooms,
    });
    this.input.on("pointerdown", this.pointerDown);
    this.input.on("pointermove", this.pointerMove);
    window.addEventListener("keydown", this.keyDown);
    window.addEventListener("keyup", this.keyUp);
    window.addEventListener("blur", this.clearKeys);
    document.addEventListener("visibilitychange", this.visibility);
    this.events.once("shutdown", () => {
      this.ready = false;
      this.onAmbientSoundChange?.(undefined);
      this.stopSnapshots?.();
      this.stopChatEvents?.();
      this.stopPokeEvents?.();
      this.stopEmoteEvents?.();
      this.scale.off(Phaser.Scale.Events.RESIZE, this.onScaleResize);
      this.load.off("filecomplete", this.onAvatarTextureLoaded);
      this.load.off("loaderror", this.onAvatarTextureFailed);
      this.load.off("loaderror", this.onMapAssetFailed);
      this.input.off("pointerdown", this.pointerDown);
      this.input.off("pointermove", this.pointerMove);
      for (const avatar of this.avatars.values()) avatar.root.destroy(true);
      this.avatars.clear();
      this.floatingEmotes.forEach((text) => text.destroy());
      this.floatingEmotes.clear();
      this.pendingEmotes.clear();
      for (const key of this.avatarTextureReferences.releaseAll())
        this.releaseAvatarTexture(key);
      this.loadingAvatarTextures.clear();
      this.failedAvatarTextures.clear();
      this.clickMarker?.destroy();
      window.removeEventListener("keydown", this.keyDown);
      window.removeEventListener("keyup", this.keyUp);
      window.removeEventListener("blur", this.clearKeys);
      document.removeEventListener("visibilitychange", this.visibility);
    });
  }
  private keyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || this.keyboardInputBlocked())
      return;
    const emote = emoteForShortcut(
      e.code,
      this.connection.getSnapshot().worldFeatures,
    );
    if (emote) {
      if (e.repeat) return;
      const snapshot = this.connection.getSnapshot();
      if (
        !snapshot.players.some((player) => player.id === snapshot.selfId) ||
        snapshot.status !== "online" ||
        snapshot.media?.transitioning
      )
        return;
      e.preventDefault();
      this.connection.emote(emote);
      return;
    }
    if (e.code === "KeyZ") {
      if (e.repeat) return;
      e.preventDefault();
      const snapshot = this.connection.getSnapshot();
      const self = snapshot.players.find(
        (player) => player.id === snapshot.selfId,
      );
      if (
        !self ||
        snapshot.status !== "online" ||
        snapshot.media?.transitioning
      )
        return;
      const dx =
        Number(this.keys.has("ArrowRight") || this.keys.has("KeyD")) -
        Number(this.keys.has("ArrowLeft") || this.keys.has("KeyA"));
      const dy =
        Number(this.keys.has("ArrowDown") || this.keys.has("KeyS")) -
        Number(this.keys.has("ArrowUp") || this.keys.has("KeyW"));
      const facing = movementFacingDirection(dx, dy, self.direction);
      const actor = { ...self, direction: facing };
      const target = findPokeTarget(actor, snapshot.players);
      if (target && this.connection.poke(target.id))
        this.showPokeProjectile(actor, target);
      return;
    }
    if (e.code === "KeyE") {
      if (e.repeat) return;
      const snapshot = this.connection.getSnapshot();
      const self = snapshot.players.find(
        (player) => player.id === snapshot.selfId,
      );
      if (
        !self ||
        snapshot.status !== "online" ||
        snapshot.media?.transitioning
      )
        return;
      const nearby = this.map.objects
        .filter((object) => object.interaction)
        .map((object) => ({
          object,
          distance: this.distanceToObject(self.x, self.y, object),
        }))
        .filter(({ distance }) => distance <= 1.25)
        .sort(
          (a, b) =>
            a.distance - b.distance ||
            b.object.y - a.object.y ||
            a.object.id.localeCompare(b.object.id),
        )[0]?.object;
      if (nearby?.interaction) {
        e.preventDefault();
        this.onInteraction?.(nearby.interaction, nearby.id);
      }
      return;
    }
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "KeyW",
        "KeyA",
        "KeyS",
        "KeyD",
        "ShiftLeft",
        "ShiftRight",
      ].includes(e.code)
    ) {
      e.preventDefault();
      this.keys.add(e.code);
    }
  };
  private keyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  private clearKeys = () => {
    const hadMovementIntent =
      this.keys.size > 0 ||
      this.touchVector.x !== 0 ||
      this.touchVector.y !== 0 ||
      this.touchRunning ||
      this.hasClickRoute() ||
      this.lastDirection !== "0,0,false";
    this.keys.clear();
    this.touchVector = { x: 0, y: 0 };
    this.touchRunning = false;
    this.clearClickRoute();
    this.pendingObjectInteraction = undefined;
    if (hadMovementIntent) {
      this.sendMovement(0, 0, false);
      this.lastDirection = "0,0,false";
      this.lastInput = performance.now();
    }
  };
  private pointerDown = (pointer: Phaser.Input.Pointer) => {
    if (pointer.button !== 0 || this.inputBlocked()) return;
    const clickedX = Phaser.Math.Clamp(
      pointer.worldX / TILE,
      0,
      this.map.width,
    );
    const clickedY = Phaser.Math.Clamp(
      pointer.worldY / TILE,
      0,
      this.map.height,
    );
    const portal = (this.map.portals ?? []).find(
      (item) =>
        clickedX >= item.bounds.x &&
        clickedX <= item.bounds.x + item.bounds.width &&
        clickedY >= item.bounds.y &&
        clickedY <= item.bounds.y + item.bounds.height,
    );
    if (portal) {
      this.pendingObjectInteraction = undefined;
      this.onPortal?.(portal);
      return;
    }
    const interactiveObject = [...this.map.objects]
      .sort((a, b) => b.y - a.y)
      .find((object) => {
        if (!object.interaction) return false;
        const bounds = objectBounds(object);
        return (
          clickedX >= bounds.x &&
          clickedX <= bounds.x + bounds.width &&
          clickedY >= bounds.y &&
          clickedY <= bounds.y + bounds.height
        );
      });
    if (interactiveObject?.interaction) {
      this.beginObjectInteraction(interactiveObject);
      return;
    }
    const label = this.map.labels.find(
      (item) =>
        Math.abs(item.x - clickedX) < 2 && Math.abs(item.y - clickedY) < 0.55,
    );
    if (label?.link && /^https?:\/\/[^\s]+$/i.test(label.link)) {
      this.pendingObjectInteraction = undefined;
      window.open(label.link, "_blank", "noopener,noreferrer");
      return;
    }
    this.pendingObjectInteraction = undefined;
    this.clearClickRoute();
    const snapshot = this.connection.getSnapshot();
    const self = snapshot.players.find(
      (player) => player.id === snapshot.selfId,
    );
    if (!self || snapshot.status !== "online" || snapshot.media?.transitioning)
      return;
    const blockedZoneIds = new Set(
      snapshot.rooms
        .filter(
          (room) =>
            (room.locked || room.occupants >= room.capacity) &&
            room.zoneId !== self.zoneId,
        )
        .map((room) => room.zoneId),
    );
    const graph = buildNavigationGraph(this.map, blockedZoneIds);
    const start = this.localPredictedPosition(self);
    const path = navigationPathTo(graph, start.x, start.y, clickedX, clickedY);
    if (!path || path.points.length < 2) return;
    this.clickPath = path.points;
    this.clickPathSegment = 0;
    this.clickNavigationGraph = graph;
    this.clickZoneId = self.zoneId;
    if (!this.clickMarker)
      this.clickMarker = this.add
        .circle(0, 0, 6, 0x4285f4, 0.18)
        .setStrokeStyle(2, 0x4285f4, 0.8)
        .setDepth(-1);
    this.clickMarker.setPosition(
      this.clickPath.at(-1)!.x * TILE,
      this.clickPath.at(-1)!.y * TILE,
    );
    this.clickMarker.setVisible(true);
  };
  private localPredictedPosition(player: PlayerView) {
    const avatar = this.avatars.get(player.id);
    return avatar
      ? { x: avatar.root.x / TILE, y: avatar.root.y / TILE }
      : { x: player.x, y: player.y };
  }
  private distanceToObject(x: number, y: number, object: MapObject) {
    const bounds = objectBounds(object);
    const dx = Math.max(bounds.x - x, 0, x - (bounds.x + bounds.width));
    const dy = Math.max(bounds.y - y, 0, y - (bounds.y + bounds.height));
    return Math.hypot(dx, dy);
  }
  private updateAmbientSound(player?: PlayerView) {
    let selected: NearbyAmbientSound | undefined;
    let nearestRatio = Number.POSITIVE_INFINITY;
    if (player) {
      for (const object of this.map.objects) {
        const interaction = object.interaction;
        if (interaction?.kind !== "SOUND" || !interaction.url) continue;
        const radius = interaction.radius ?? 6;
        const distance = this.distanceToObject(player.x, player.y, object);
        if (distance >= radius) continue;
        const ratio = distance / radius;
        if (ratio >= nearestRatio) continue;
        nearestRatio = ratio;
        selected = {
          objectId: object.id,
          title: interaction.title,
          url: interaction.url,
          volume: Math.round((interaction.volume ?? 50) * (1 - ratio)) / 100,
        };
      }
    }
    const nextId = selected?.objectId ?? "";
    const nextVolume = Math.round((selected?.volume ?? 0) * 100);
    if (
      nextId === this.ambientSoundObjectId &&
      nextVolume === this.ambientSoundVolume
    )
      return;
    this.ambientSoundObjectId = nextId;
    this.ambientSoundVolume = nextVolume;
    this.onAmbientSoundChange?.(
      selected ? { ...selected, volume: nextVolume / 100 } : undefined,
    );
  }
  private beginObjectInteraction(object: MapObject) {
    const snapshot = this.connection.getSnapshot();
    const self = snapshot.players.find(
      (player) => player.id === snapshot.selfId,
    );
    if (!self || snapshot.status !== "online" || snapshot.media?.transitioning)
      return;
    this.clearClickRoute();
    this.pendingObjectInteraction = undefined;
    if (this.distanceToObject(self.x, self.y, object) <= 1.25) {
      if (object.interaction)
        this.onInteraction?.(object.interaction, object.id);
      return;
    }

    const blockedZoneIds = new Set(
      snapshot.rooms
        .filter(
          (room) =>
            (room.locked || room.occupants >= room.capacity) &&
            room.zoneId !== self.zoneId,
        )
        .map((room) => room.zoneId),
    );
    const graph = buildNavigationGraph(this.map, blockedZoneIds);
    const bounds = objectBounds(object);
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const offset = 0.5;
    const candidates = [
      { x: centerX, y: bounds.y - offset },
      { x: centerX, y: bounds.y + bounds.height + offset },
      { x: bounds.x - offset, y: centerY },
      { x: bounds.x + bounds.width + offset, y: centerY },
      { x: bounds.x - offset, y: bounds.y - offset },
      { x: bounds.x + bounds.width + offset, y: bounds.y - offset },
      { x: bounds.x - offset, y: bounds.y + bounds.height + offset },
      {
        x: bounds.x + bounds.width + offset,
        y: bounds.y + bounds.height + offset,
      },
    ];
    const start = this.localPredictedPosition(self);
    let best:
      | { points: Array<{ x: number; y: number }>; distance: number }
      | undefined;
    for (const candidate of candidates) {
      const path = navigationPathTo(
        graph,
        start.x,
        start.y,
        candidate.x,
        candidate.y,
      );
      if (
        !path ||
        this.distanceToObject(
          path.points.at(-1)!.x,
          path.points.at(-1)!.y,
          object,
        ) > 1.25
      )
        continue;
      if (!best || path.distance < best.distance) best = path;
    }
    if (!best) return;
    this.pendingObjectInteraction = object;
    this.clickPath = best.points;
    this.clickPathSegment = 0;
    this.clickNavigationGraph = graph;
    this.clickZoneId = self.zoneId;
    const target = best.points.at(-1)!;
    if (!this.clickMarker)
      this.clickMarker = this.add
        .circle(0, 0, 6, 0x4285f4, 0.18)
        .setStrokeStyle(2, 0x4285f4, 0.8)
        .setDepth(-1);
    this.clickMarker
      .setPosition(target.x * TILE, target.y * TILE)
      .setVisible(true);
  }
  private pointerMove = (pointer: Phaser.Input.Pointer) => {
    const x = Phaser.Math.Clamp(pointer.worldX / TILE, 0, this.map.width);
    const y = Phaser.Math.Clamp(pointer.worldY / TILE, 0, this.map.height);
    const portal = (this.map.portals ?? []).some(
      (item) =>
        x >= item.bounds.x &&
        x <= item.bounds.x + item.bounds.width &&
        y >= item.bounds.y &&
        y <= item.bounds.y + item.bounds.height,
    );
    const link = this.map.labels.some(
      (item) =>
        item.link && Math.abs(item.x - x) < 2 && Math.abs(item.y - y) < 0.55,
    );
    const interactiveObject = this.map.objects.some((object) => {
      if (!object.interaction) return false;
      const bounds = objectBounds(object);
      return (
        x >= bounds.x &&
        x <= bounds.x + bounds.width &&
        y >= bounds.y &&
        y <= bounds.y + bounds.height
      );
    });
    if (this.game.canvas)
      this.game.canvas.style.cursor =
        portal || link || interactiveObject ? "pointer" : "default";
  };
  private sendMovement(dx: number, dy: number, running: boolean) {
    const seq = this.connection.move(dx, dy, running);
    if (seq === undefined) return;
    this.pendingMovementInputs.push({
      seq,
      dx,
      dy,
      running,
      sentAt: performance.now(),
    });
    // The server treats movement as a replaceable held-input state. Keep only a
    // bounded history so packet loss/reconnects cannot grow this queue forever.
    if (this.pendingMovementInputs.length > 64)
      this.pendingMovementInputs.splice(
        0,
        this.pendingMovementInputs.length - 64,
      );
  }
  setTouchVector(dx: number, dy: number, running: boolean) {
    if (dx !== 0 || dy !== 0) {
      this.clearClickRoute();
      this.pendingObjectInteraction = undefined;
    }
    const length = Math.hypot(dx, dy);
    const scale = Math.max(1, length);
    this.touchVector = { x: dx / scale, y: dy / scale };
    this.touchRunning = running && length > 0;
  }
  clearTouchInput() {
    this.touchVector = { x: 0, y: 0 };
    this.touchRunning = false;
    this.sendMovement(0, 0, false);
  }
  private visibility = () => {
    if (document.hidden) this.clearKeys();
  };
  private inputBlocked() {
    return (
      !!document.activeElement?.closest(
        "input, textarea, select, [contenteditable=true], [role=dialog]",
      ) || document.hidden
    );
  }
  private keyboardInputBlocked() {
    const activeElement = document.activeElement;
    const worldHasFocus = Boolean(activeElement?.closest(".world-canvas"));
    const pageHasNeutralFocus =
      activeElement === document.body ||
      activeElement === document.documentElement;
    return this.inputBlocked() || (!worldHasFocus && !pageHasNeutralFocus);
  }
  setZoom(delta: number) {
    if (!this.canRenderObjects()) return;
    this.zoomLevel = Phaser.Math.Clamp(this.zoomLevel + delta, 0.6, 1.5);
    this.cameras.main.setZoom(this.zoomLevel);
  }
  recenter() {
    this.focus = true;
    this.cameraFocusTarget = undefined;
  }
  focusAt(x: number, y: number) {
    if (!this.canRenderObjects()) return;
    this.focus = false;
    this.cameraFocusTarget = { x, y };
    this.cameras.main.centerOn(x * TILE, y * TILE);
  }
  private onScaleResize = () => {
    if (!this.focus && this.cameraFocusTarget)
      this.cameras.main.centerOn(
        this.cameraFocusTarget.x * TILE,
        this.cameraFocusTarget.y * TILE,
      );
  };
  private paintWorld() {
    for (const chunk of mapRenderChunks(this.map.width, this.map.height)) {
      const width = chunk.width * TILE;
      const height = chunk.height * TILE;
      const key = `office-floor-${chunk.x}-${chunk.y}`;
      const texture = this.textures.createCanvas(key, width, height)!;
      const context = texture.getContext();
      context.save();
      context.beginPath();
      context.rect(0, 0, width, height);
      context.clip();
      context.translate(-chunk.x * TILE, -chunk.y * TILE);
      paintFloor(context, this.map, chunk);
      paintStageZones(context, this.map, this.labels.stage, false);
      paintLabels(context, this.map);
      paintPortals(context, this.map);
      context.restore();
      texture.refresh();
      this.add
        .image(chunk.x * TILE, chunk.y * TILE, key)
        .setOrigin(0)
        .setDepth(-10);
    }
    for (const wall of this.map.walls) {
      const b = wall.bounds,
        width = Math.ceil(b.width * TILE + 10),
        height = Math.ceil(b.height * TILE + 32);
      const key = `wall-${wall.id}`;
      const t = this.textures.createCanvas(key, width, height)!;
      paintWall(t.getContext(), wall, b.x * TILE, b.y * TILE - 16);
      t.refresh();
      this.add
        .image(b.x * TILE, b.y * TILE - 16, key)
        .setOrigin(0)
        .setDepth((b.y + b.height) * TILE);
    }
    for (const o of this.map.objects) {
      const asset = ASSETS_BY_ID.get(o.asset);
      if (!asset) continue;
      this.add
        .image(o.x * TILE, o.y * TILE, o.asset)
        .setOrigin(0.5, 1)
        .setDisplaySize(asset.width * o.scale, asset.height * o.scale)
        .setDepth(asset.layer === "GROUND" ? -5 : o.y * TILE);
      if (o.interaction) {
        const b = objectBounds(o);
        const x = (b.x + b.width - 0.2) * TILE;
        const y = (b.y + 0.2) * TILE;
        const color =
          o.interaction.kind === "NOTICE"
            ? 0x8a6a31
            : o.interaction.kind === "VIDEO"
              ? 0x7c4e78
              : o.interaction.kind === "IMAGE"
                ? 0xa15c36
                : o.interaction.kind === "BOARD"
                  ? 0x47754b
                  : o.interaction.kind === "NPC"
                    ? 0x4c6a9a
                    : o.interaction.kind === "SOUND"
                      ? 0x8a5a95
                      : 0x2b7185;
        const depth = (asset.layer === "GROUND" ? -5 : o.y * TILE) + 2;
        this.add
          .circle(x, y, 8, 0xfffdf0, 0.95)
          .setStrokeStyle(2, color, 1)
          .setDepth(depth);
        this.add
          .text(
            x,
            y,
            o.interaction.kind === "NOTICE"
              ? "i"
              : o.interaction.kind === "VIDEO"
                ? "▶"
                : o.interaction.kind === "IMAGE"
                  ? "▧"
                  : o.interaction.kind === "BOARD"
                    ? "≡"
                    : o.interaction.kind === "NPC"
                      ? "N"
                      : o.interaction.kind === "SOUND"
                        ? "♫"
                        : "↗",
            {
              fontSize: "10px",
              fontFamily: "Arial, sans-serif",
              color: `#${color.toString(16).padStart(6, "0")}`,
              fontStyle: "bold",
            },
          )
          .setOrigin(0.5)
          .setDepth(depth + 1);
      }
    }
    this.createStageLabelLayers();
  }
  private receive(s: Snapshot) {
    if (!this.canRenderObjects()) return;
    const selfId = this.connection.getSnapshot().selfId;
    const self = s.players.find((player) => player.id === selfId);
    if (self) {
      // Sequence numbers restart with a new connection epoch. A regressing ACK
      // therefore marks a reconnect and invalidates the prior input history.
      if (s.inputAckSeq < this.lastMovementAck) this.pendingMovementInputs = [];
      this.lastMovementAck = s.inputAckSeq;
      const cutoff = performance.now() - 1500;
      this.pendingMovementInputs = this.pendingMovementInputs.filter(
        (input) => input.seq > s.inputAckSeq && input.sentAt >= cutoff,
      );
    }
    const alive = new Set(s.players.map((p) => p.id));
    for (const [id, a] of this.avatars)
      if (!alive.has(id)) {
        a.root.destroy(true);
        this.avatars.delete(id);
        const { released } = this.avatarTextureReferences.removePlayer(id);
        released.forEach((key) => this.releaseAvatarTexture(key));
      }
    for (const p of s.players) {
      let a = this.avatars.get(p.id);
      if (!a) {
        const isMe = p.id === this.connection.getSnapshot().selfId;
        const shadow = this.add.ellipse(0, -3, 25, 10, 0x344c32, 0.22);
        const ring = this.add
          .ellipse(0, -3, 31, 15)
          .setStrokeStyle(2, isMe ? 0x4285f4 : 0xffffff, 0.8);
        const seat = this.add.graphics().setVisible(false);
        seat.fillStyle(0x56391f, 1);
        seat.fillRect(-8, -18, 3, 11);
        seat.fillRect(5, -18, 3, 11);
        seat.fillStyle(0x9c6832, 1);
        seat.fillRect(-9, -10, 18, 3);
        seat.fillStyle(0xc18a48, 1);
        seat.fillRect(-9, -11, 18, 2);
        seat.fillStyle(0x56391f, 1);
        seat.fillRect(-7, -7, 3, 7);
        seat.fillRect(4, -7, 3, 7);
        const layers = [0, 1, 2].map((l) =>
          this.add
            .sprite(0, 0, `avatar-${p.avatar}-${l}`, 1)
            .setOrigin(0.5, 1)
            .setScale(2),
        );
        const label = this.add
          .text(0, 9, `${p.name}${isMe ? ` · ${this.labels.self}` : ""}`, {
            fontSize: "11px",
            fontFamily: "Segoe UI, Malgun Gothic, sans-serif",
            color: isMe ? "#2a4a82" : "#344232",
            backgroundColor: isMe ? "#e9f1ff" : "#fffffff0",
            padding: { x: 7, y: 4 },
          })
          .setOrigin(0.5, 0);
        const microphoneBadge = this.add.graphics();
        const bubble = this.add
          .text(0, -58, "", { fontSize: "26px" })
          .setOrigin(0.5);
        const chatBubbleBackground = this.add.graphics();
        const chatBubbleText = this.add
          .text(0, 0, "", {
            fontSize: "12px",
            fontFamily: "Segoe UI, Malgun Gothic, sans-serif",
            color: "#263228",
            align: "center",
            padding: { x: 10, y: 6 },
          })
          .setOrigin(0.5, 1);
        const chatBubble = this.add
          .container(0, -67, [chatBubbleBackground, chatBubbleText])
          .setVisible(false);
        const root = this.add.container(p.x * TILE, p.y * TILE, [
          shadow,
          ring,
          seat,
          ...layers,
          label,
          microphoneBadge,
          chatBubble,
          bubble,
        ]);
        a = {
          root,
          seat,
          layers,
          textureKeys: [],
          nameLabel: label,
          microphoneBadge,
          microphoneOn: null,
          bubble,
          chatBubble,
          chatBubbleBackground,
          chatBubbleText,
          chatBubbleUntil: 0,
          chatBubbleMessageId: "",
          pokeStartedAt: 0,
          pokeUntil: 0,
          pokeEmojiUntil: 0,
          lastPokeRequestId: "",
          state: p,
          sittingVisual: false,
          targetX: p.x,
          targetY: p.y,
          walkTime: 0,
        };
        this.avatars.set(p.id, a);
      }
      a.state = p;
      this.setAvatarPose(a, p.sitting);
      a.nameLabel.setText(
        `${p.name}${p.id === selfId ? ` · ${this.labels.self}` : ""}`,
      );
      this.setAvatarMicrophone(a, p.microphoneOn);
      this.layoutNameTag(a);
      this.updateAvatarTextures(a, p);
      a.targetX = p.x;
      a.targetY = p.y;
      a.bubble.setText(this.avatarBubbleEmoji(a, this.time.now));
      const pendingChat = this.pendingChat.get(p.id);
      if (
        pendingChat &&
        pendingChat.expiresAt > this.time.now &&
        a.chatBubbleMessageId !== pendingChat.event.clientMessageId
      )
        this.showChatBubble(a, pendingChat.event, pendingChat.expiresAt);
      const pendingPoke = this.pendingPokes.get(p.id);
      if (
        pendingPoke &&
        pendingPoke.expiresAt > this.time.now &&
        a.lastPokeRequestId !== pendingPoke.event.requestId
      )
        this.showPoke(a, pendingPoke.event);
      const pendingEmotes = this.pendingEmotes.get(p.id);
      if (pendingEmotes) {
        this.pendingEmotes.delete(p.id);
        for (const pending of pendingEmotes)
          if (pending.expiresAt > this.time.now)
            this.showEmote(a, pending.event);
      }
    }
  }
  private layoutNameTag(avatar: Avatar) {
    const badgeSize = 18;
    const gap = 4;
    const hasMicrophoneStatus = avatar.microphoneOn !== null;
    const totalWidth =
      avatar.nameLabel.width + (hasMicrophoneStatus ? gap + badgeSize : 0);
    const left = -totalWidth / 2;
    avatar.nameLabel.setPosition(left + avatar.nameLabel.width / 2, 9);
    if (hasMicrophoneStatus)
      avatar.microphoneBadge.setPosition(
        left + avatar.nameLabel.width + gap + badgeSize / 2,
        9 + avatar.nameLabel.height / 2,
      );
  }
  private setAvatarMicrophone(
    avatar: Avatar,
    microphoneOn: boolean | undefined,
  ) {
    if (microphoneOn === undefined) {
      if (avatar.microphoneOn === null) return;
      avatar.microphoneOn = null;
      avatar.microphoneBadge.setVisible(false);
      return;
    }
    if (avatar.microphoneOn === microphoneOn) return;
    avatar.microphoneOn = microphoneOn;
    const graphics = avatar.microphoneBadge;
    graphics.setVisible(true);
    const color = microphoneOn ? 0x28794b : 0x727d76;
    graphics.clear();
    graphics.fillStyle(color, 1).fillCircle(0, 0, 9);
    graphics.fillStyle(0xffffff, 1).fillRoundedRect(-2, -5, 4, 7, 2);
    graphics.lineStyle(1.4, 0xffffff, 1);
    graphics.lineBetween(-4, -1, -4, 1);
    graphics.lineBetween(-4, 1, -3, 3);
    graphics.lineBetween(-3, 3, 3, 3);
    graphics.lineBetween(3, 3, 4, 1);
    graphics.lineBetween(4, 1, 4, -1);
    graphics.lineBetween(0, 3, 0, 5);
    graphics.lineBetween(-2, 5, 2, 5);
    if (!microphoneOn) {
      graphics.lineStyle(2, 0xffd4d4, 1);
      graphics.lineBetween(-5, 5, 5, -5);
    }
  }
  private avatarTextureEntries(player: PlayerView) {
    const body =
      (["average", "dainty", "heavy"] as const)[player.avatar] ?? "average";
    const parts = [
      [
        `town-avatar-body-${body}-${player.skin}`,
        `/assets/avatar-parts/body-${body}-${player.skin}.png`,
      ],
      [
        `town-avatar-clothing-${body}-${player.clothing}`,
        `/assets/avatar-parts/clothing-${body}-${player.clothing}.png`,
      ],
      [
        `town-avatar-hair-${body}-${player.hair}`,
        `/assets/avatar-parts/hair-${body}-${player.hair}.png`,
      ],
    ] as const;
    return parts;
  }
  private ensureAvatarTexture(key: string, url: string) {
    if (
      this.textures.exists(key) ||
      this.loadingAvatarTextures.has(key) ||
      this.failedAvatarTextures.has(key)
    )
      return;
    this.loadingAvatarTextures.add(key);
    this.load.spritesheet(key, url, { frameWidth: 16, frameHeight: 16 });
    if (!this.load.isLoading()) this.load.start();
  }
  private releaseAvatarTexture(key: string) {
    if (this.avatarTextureReferences.hasUsers(key)) return;
    this.failedAvatarTextures.delete(key);
    if (this.textures.exists(key)) this.textures.remove(key);
  }
  private onAvatarTextureLoaded = (key: string) => {
    this.loadingAvatarTextures.delete(key);
    if (!this.avatarTextureReferences.hasUsers(key)) {
      this.releaseAvatarTexture(key);
      return;
    }
    this.refreshAvatarTextures();
  };
  private onAvatarTextureFailed = (file: { key: string }) => {
    this.loadingAvatarTextures.delete(file.key);
    if (this.avatarTextureReferences.hasUsers(file.key))
      this.failedAvatarTextures.add(file.key);
    else this.failedAvatarTextures.delete(file.key);
  };
  private onMapAssetFailed = (file: { key: string }) => {
    if (!this.mapAssetIds.has(file.key)) return;
    const asset = ASSETS_BY_ID.get(file.key);
    this.onAssetError?.(asset?.name ?? this.labels.space);
  };
  private refreshAvatarTextures() {
    if (!this.canRenderObjects()) return;
    for (const avatar of this.avatars.values())
      this.updateAvatarTextures(avatar);
  }
  private updateAvatarTextures(avatar: Avatar, player = avatar.state) {
    const entries = this.avatarTextureEntries(player);
    const keys = entries.map(([key]) => key);
    const previous = avatar.textureKeys;
    const changes = this.avatarTextureReferences.sync(avatar.state.id, keys);
    for (const key of changes.released) {
      const layerIndex = previous.indexOf(key);
      if (layerIndex >= 0 && avatar.layers[layerIndex]?.texture.key === key)
        avatar.layers[layerIndex].setTexture(
          `avatar-${player.avatar}-${layerIndex}`,
        );
      this.releaseAvatarTexture(key);
    }
    for (const key of changes.acquired) {
      const entry = entries.find(([entryKey]) => entryKey === key);
      if (entry) this.ensureAvatarTexture(entry[0], entry[1]);
    }
    avatar.textureKeys = keys;
    if (!keys.every((key) => this.textures.exists(key))) return;
    avatar.layers.forEach((layer, index) => {
      if (layer.texture.key !== keys[index]) layer.setTexture(keys[index]);
    });
  }
  private setAvatarPose(avatar: Avatar, sitting: boolean) {
    if (avatar.sittingVisual === sitting) return;
    avatar.sittingVisual = sitting;
    avatar.seat.setVisible(sitting);
    avatar.layers.forEach((layer) => layer.setScale(2, sitting ? 1.25 : 2));
  }
  private avatarBubbleEmoji(avatar: Avatar, now: number) {
    if (avatar.pokeEmojiUntil > now) return "👉";
    if (avatar.state.sitting) return emoji.sit;
    return "";
  }
  private receiveChat(event: ChatEvent) {
    if (!this.canRenderObjects()) return;
    if (event.channel === "dm") return;
    const expiresAt = this.time.now + 5200;
    this.pendingChat.set(event.senderId, { event, expiresAt });
    const avatar = this.avatars.get(event.senderId);
    if (avatar) this.showChatBubble(avatar, event, expiresAt);
  }
  private showChatBubble(avatar: Avatar, event: ChatEvent, expiresAt: number) {
    const characters = Array.from(event.text.replace(/\s+/g, " ").trim());
    const visible =
      characters.length > 54 ? [...characters.slice(0, 53), "…"] : characters;
    const lines: string[] = [];
    for (let index = 0; index < visible.length; index += 16)
      lines.push(visible.slice(index, index + 16).join(""));
    avatar.chatBubbleText.setText(lines.join("\n"));
    const width = avatar.chatBubbleText.width + 12;
    const height = avatar.chatBubbleText.height + 8;
    const background = avatar.chatBubbleBackground;
    background.clear();
    background.fillStyle(0xfffbed, 0.98);
    background.lineStyle(1, 0x586e52, 0.85);
    background.fillRoundedRect(-width / 2, -height - 4, width, height, 6);
    background.strokeRoundedRect(-width / 2, -height - 4, width, height, 6);
    background.fillTriangle(-5, -4, 5, -4, 0, 2);
    background.strokeTriangle(-5, -4, 5, -4, 0, 2);
    avatar.chatBubbleMessageId = event.clientMessageId;
    avatar.chatBubbleUntil = expiresAt;
    avatar.chatBubble.setAlpha(1).setVisible(true);
  }
  private receivePoke(event: PokeEvent) {
    if (!this.canRenderObjects()) return;
    const expiresAt = this.time.now + 1200;
    this.pendingPokes.set(event.targetId, { event, expiresAt });
    const avatar = this.avatars.get(event.targetId);
    if (avatar) this.showPoke(avatar, event);
  }
  private receiveEmote(event: EmoteEvent) {
    if (!this.canRenderObjects() || !emoji[event.emoji]) return;
    const avatar = this.avatars.get(event.playerId);
    if (avatar) {
      this.showEmote(avatar, event);
      return;
    }
    const pending = this.pendingEmotes.get(event.playerId) ?? [];
    pending.push({ event, expiresAt: this.time.now + 2500 });
    if (pending.length > 16) pending.shift();
    this.pendingEmotes.set(event.playerId, pending);
  }
  private showEmote(avatar: Avatar, event: EmoteEvent) {
    const icon = emoji[event.emoji];
    if (!icon) return;
    const sequence = this.emoteVisualSequence++;
    const horizontalOffsets = [-20, 20, -8, 8, 0];
    const x =
      avatar.root.x + horizontalOffsets[sequence % horizontalOffsets.length];
    const y = avatar.root.y - 58 - (sequence % 3) * 5;
    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const text = this.add
      .text(x, y, icon, { fontSize: "32px", fontFamily: "Arial, sans-serif" })
      .setOrigin(0.5)
      .setDepth(100_000);
    this.floatingEmotes.add(text);
    this.tweens.add({
      targets: text,
      y: y - (reduceMotion ? 20 : 68),
      alpha: 0,
      scale: reduceMotion ? 0.95 : 1.12,
      duration: reduceMotion ? 800 : 2200,
      ease: "Sine.Out",
      onComplete: () => {
        this.floatingEmotes.delete(text);
        text.destroy();
      },
    });
  }
  private showPoke(avatar: Avatar, event: PokeEvent) {
    if (avatar.lastPokeRequestId === event.requestId) return;
    avatar.lastPokeRequestId = event.requestId;
    avatar.pokeStartedAt = this.time.now;
    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    avatar.pokeUntil = reduceMotion ? this.time.now : this.time.now + 520;
    avatar.pokeEmojiUntil = this.time.now + 1200;
    avatar.bubble.setText("👉");
  }
  private showPokeProjectile(
    sender: PlayerView,
    target: Pick<PlayerView, "id" | "x" | "y">,
  ) {
    if (
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
      false
    )
      return;
    const source = this.avatars.get(sender.id);
    if (!source) return;
    const vector = {
      down: { x: 0, y: 1, angle: Math.PI / 2 },
      left: { x: -1, y: 0, angle: Math.PI },
      right: { x: 1, y: 0, angle: 0 },
      up: { x: 0, y: -1, angle: -Math.PI / 2 },
    }[sender.direction];
    const destination = this.avatars.get(target.id);
    const projectile = this.add
      .text(
        source.root.x + vector.x * 16,
        source.root.y - 28 + vector.y * 16,
        "👉",
        { fontSize: "23px" },
      )
      .setOrigin(0.5)
      .setRotation(vector.angle)
      .setDepth(Math.max(source.root.depth, destination?.root.depth ?? 0) + 2);
    this.tweens.add({
      targets: projectile,
      x: destination?.root.x ?? target.x * TILE,
      y: (destination?.root.y ?? target.y * TILE) - 22,
      duration: 240,
      ease: "Cubic.easeOut",
      onComplete: () => projectile.destroy(),
    });
  }
  update(time: number, delta: number) {
    if (!this.canRenderObjects()) return;
    if (this.inputBlocked() || this.keyboardInputBlocked()) {
      if (
        this.keys.size > 0 ||
        this.touchVector.x !== 0 ||
        this.touchVector.y !== 0 ||
        this.touchRunning ||
        this.hasClickRoute() ||
        this.lastDirection !== "0,0,false"
      )
        this.clearKeys();
    }
    const snapshot = this.connection.getSnapshot();
    const online =
      snapshot.status === "online" && !snapshot.media?.transitioning;
    const manualDx = online
      ? Math.max(
          -1,
          Math.min(
            1,
            Number(this.keys.has("ArrowRight") || this.keys.has("KeyD")) -
              Number(this.keys.has("ArrowLeft") || this.keys.has("KeyA")) +
              this.touchVector.x,
          ),
        )
      : 0;
    const manualDy = online
      ? Math.max(
          -1,
          Math.min(
            1,
            Number(this.keys.has("ArrowDown") || this.keys.has("KeyS")) -
              Number(this.keys.has("ArrowUp") || this.keys.has("KeyW")) +
              this.touchVector.y,
          ),
        )
      : 0;
    const manualActive = manualDx !== 0 || manualDy !== 0;
    if (manualActive) {
      this.clearClickRoute();
      this.pendingObjectInteraction = undefined;
    }
    const selfState = snapshot.players.find(
      (player) => player.id === snapshot.selfId,
    );
    const selfAvatar = selfState ? this.avatars.get(selfState.id) : undefined;
    // Steer click routes from the locally predicted sprite position. The server
    // snapshot can trail by several movement ticks; steering from it makes the
    // avatar keep correcting toward stale coordinates at every waypoint.
    const steeringX = selfAvatar ? selfAvatar.root.x / TILE : selfState?.x;
    const steeringY = selfAvatar ? selfAvatar.root.y / TILE : selfState?.y;
    this.updateAmbientSound(online ? selfState : undefined);
    const currentRoom = selfState
      ? snapshot.rooms.find((room) => room.zoneId === selfState.zoneId)
      : undefined;
    const enteredBlockedRoom =
      selfState &&
      selfState.zoneId !== this.clickZoneId &&
      currentRoom &&
      (currentRoom.locked || currentRoom.occupants >= currentRoom.capacity);
    if (enteredBlockedRoom) {
      this.clearClickRoute();
      this.pendingObjectInteraction = undefined;
    }
    if (!online || !selfState) {
      this.clearClickRoute();
      this.pendingObjectInteraction = undefined;
    }
    let clickTarget: { x: number; y: number } | undefined;
    if (
      this.hasClickRoute() &&
      steeringX !== undefined &&
      steeringY !== undefined &&
      this.clickNavigationGraph
    ) {
      let following = navigationFollowTarget(
        this.clickNavigationGraph,
        this.clickPath,
        { x: steeringX, y: steeringY },
        this.clickPathSegment,
      );
      if (!following) {
        const destination = this.clickPath.at(-1);
        const replanned = destination
          ? navigationPathTo(
              this.clickNavigationGraph,
              steeringX,
              steeringY,
              destination.x,
              destination.y,
            )
          : null;
        if (replanned && replanned.points.length > 1) {
          this.clickPath = replanned.points;
          this.clickPathSegment = 0;
          following = navigationFollowTarget(
            this.clickNavigationGraph,
            this.clickPath,
            { x: steeringX, y: steeringY },
          );
        }
      }
      if (following?.reached) this.clearClickRoute();
      else if (following) {
        this.clickPathSegment = following.segmentIndex;
        clickTarget = following.target;
      } else {
        this.clearClickRoute();
        this.pendingObjectInteraction = undefined;
      }
    }
    if (this.pendingObjectInteraction && selfState) {
      if (
        this.distanceToObject(
          selfState.x,
          selfState.y,
          this.pendingObjectInteraction,
        ) <= 1.25
      ) {
        const object = this.pendingObjectInteraction;
        this.pendingObjectInteraction = undefined;
        this.clearClickRoute();
        if (object.interaction)
          this.onInteraction?.(object.interaction, object.id);
      } else if (!this.hasClickRoute()) {
        this.pendingObjectInteraction = undefined;
      }
    }
    if (!this.hasClickRoute()) this.clickMarker?.setVisible(false);
    const targetDx = clickTarget ? clickTarget.x - (steeringX ?? 0) : 0;
    const targetDy = clickTarget ? clickTarget.y - (steeringY ?? 0) : 0;
    const targetLength = Math.hypot(targetDx, targetDy);
    const clickDx = targetLength > 0 ? targetDx / targetLength : 0;
    const clickDy = targetLength > 0 ? targetDy / targetLength : 0;
    const dx = manualActive ? manualDx : clickDx;
    const dy = manualActive ? manualDy : clickDy;
    const running =
      manualActive &&
      (this.keys.has("ShiftLeft") ||
        this.keys.has("ShiftRight") ||
        this.touchRunning);
    const signature = `${dx.toFixed(1)},${dy.toFixed(1)},${running}`;
    const movementActive = dx !== 0 || dy !== 0;
    // Click-route vectors are refreshed faster than manual held keys so the
    // short path-following lookahead stays ahead of the authoritative world tick.
    const movementUpdateInterval = this.hasClickRoute()
      ? CLICK_MOVEMENT_UPDATE_MS
      : MANUAL_MOVEMENT_UPDATE_MS;
    if (
      (signature !== this.lastDirection && time - this.lastInput >= 16) ||
      (movementActive && time - this.lastInput >= movementUpdateInterval)
    ) {
      this.sendMovement(dx, dy, running);
      this.lastInput = time;
      this.lastDirection = signature;
    }
    const selfId = this.connection.getSnapshot().selfId;
    for (const [playerId, pending] of this.pendingChat)
      if (pending.expiresAt <= time) this.pendingChat.delete(playerId);
    for (const [playerId, pending] of this.pendingPokes)
      if (pending.expiresAt <= time) this.pendingPokes.delete(playerId);
    for (const [playerId, pending] of this.pendingEmotes) {
      const active = pending.filter((event) => event.expiresAt > time);
      if (active.length) this.pendingEmotes.set(playerId, active);
      else this.pendingEmotes.delete(playerId);
    }
    for (const [id, a] of this.avatars) {
      const chatRemaining = a.chatBubbleUntil - time;
      if (chatRemaining <= 0 && a.chatBubbleUntil > 0) {
        a.chatBubbleUntil = 0;
        a.chatBubble.setVisible(false);
      } else if (chatRemaining < 700) {
        a.chatBubble.setAlpha(Math.max(0, chatRemaining / 700));
      }
      const pendingPoke = this.pendingPokes.get(id);
      if (
        pendingPoke &&
        pendingPoke.expiresAt > time &&
        a.lastPokeRequestId !== pendingPoke.event.requestId
      )
        this.showPoke(a, pendingPoke.event);
      if (a.pokeUntil > time) {
        const progress = (time - a.pokeStartedAt) / 520;
        const intensity = 1 - progress;
        const shake = Math.sin(progress * Math.PI * 10) * intensity * 7;
        const bounce =
          -Math.abs(Math.sin(progress * Math.PI * 10)) * intensity * 2.5;
        a.layers.forEach((layer) => layer.setPosition(shake, bounce));
      } else a.layers.forEach((layer) => layer.setPosition(0, 0));
      if (a.pokeEmojiUntil <= time && a.bubble.text === "👉")
        a.bubble.setText(this.avatarBubbleEmoji(a, time));
      const self = id === selfId;
      let direction = a.state.direction,
        moving = a.state.moving && online;
      if (self && online) {
        const previousX = a.root.x / TILE,
          previousY = a.root.y / TILE;
        const current = step(
          this.map,
          a.root.x / TILE,
          a.root.y / TILE,
          dx,
          dy,
          running,
          Math.min(delta / 1000, 0.05),
          this.movementGrid,
        );
        const error = Math.hypot(a.targetX - current.x, a.targetY - current.y);
        const correction = error > 1.5 ? 1 : Math.min(delta / 160, 1);
        // Replay the newest unacknowledged held-input state from the authoritative
        // snapshot. This prevents a delayed ACK from pulling local prediction back
        // when a direction change is already in flight.
        const pending = this.pendingMovementInputs.at(-1);
        const replayDx = pending?.dx ?? dx;
        const replayDy = pending?.dy ?? dy;
        const replayRunning = pending?.running ?? running;
        const lead = replayDx || replayDy ? 0.08 : 0;
        const target = step(
          this.map,
          a.targetX,
          a.targetY,
          replayDx,
          replayDy,
          replayRunning,
          lead,
          this.movementGrid,
        );
        a.root.setPosition(
          (current.x + (target.x - current.x) * correction) * TILE,
          (current.y + (target.y - current.y) * correction) * TILE,
        );
        moving =
          Math.hypot(current.x - previousX, current.y - previousY) > 0.002 &&
          !!(dx || dy);
        direction = movementFacingDirection(dx, dy, direction);
      } else {
        const alpha = Math.min(delta / 90, 1);
        a.root.x += (a.targetX * TILE - a.root.x) * alpha;
        a.root.y += (a.targetY * TILE - a.root.y) * alpha;
      }
      a.walkTime = moving ? a.walkTime + delta : 0;
      const frame = avatarFrame(direction, a.walkTime, moving, self && running);
      a.layers.forEach((l) => l.setFrame(frame));
      a.root.setDepth(a.root.y + 1);
      if (self && this.focus) {
        const camera = this.cameras.main;
        const targetX = a.root.x - camera.width / 2;
        const targetY = a.root.y - camera.height / 2 - 110;
        camera.scrollX += (targetX - camera.scrollX) * Math.min(delta / 120, 1);
        camera.scrollY += (targetY - camera.scrollY) * Math.min(delta / 120, 1);
      }
    }
  }
}
