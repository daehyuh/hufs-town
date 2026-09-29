import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createUuid } from "../ids";
import {
  ArrowLeft,
  MousePointer2,
  Armchair,
  Layers,
  BrickWall,
  Paintbrush,
  PaintBucket,
  Scan,
  MapPin,
  Type,
  Eraser,
  Undo2,
  Redo2,
  Copy,
  Trash2,
  Save,
  Upload,
  Download,
  History,
  Grid2X2,
  Magnet,
  ZoomIn,
  ZoomOut,
  Check,
  LockKeyhole,
  ArrowUp,
  ArrowDown,
  UsersRound,
} from "lucide-react";
import type { MapDefinition, MapObject, Zone } from "../generated/protocol";
import type { Space } from "../spaces/client";
import {
  allOfficeAssets,
  registerCustomAssets,
  replaceCustomAssets,
  unregisterCustomAsset,
  ASSETS_BY_ID,
  OBJECT_DIRECTIONS,
  objectBounds,
} from "../game/officeAssets";
import { FLOOR_LABELS, WALL_LABELS } from "../game/renderMap";
import { Dialog } from "../components/Dialog";
import { useLanguage, type TranslationKey } from "../i18n/language";
import {
  EditorCanvas,
  type Selection,
  type RemoteSelection,
  type Tool,
  type EditorOptions,
} from "./EditorCanvas";
import { useMapEditor } from "./useMapEditor";
import {
  cloneMap as cloneMapApi,
  createMap,
  deleteMap as deleteMapApi,
  history as loadHistory,
  listMaps,
  reorderMaps,
  setEntryMap,
  collaborativePresence,
  removeCollaborativePresence,
  updateCollaborativePresence,
  type MapEditParticipant,
  type MapSummary,
  type Revision,
} from "./client";
import { importMap, MapImportError } from "./importMap";
import { EDITOR_GRID_STEP } from "./grid";
import { localizedAssetName } from "./assetLabels";
import {
  approveSpaceAsset,
  deleteSpaceAsset,
  listPendingSpaceAssets,
  listSpaceAssets,
  rejectSpaceAsset,
  uploadSpaceAsset,
  type PendingSpaceAsset,
} from "./assetsClient";
import "./editor.css";

const presenceColors = ["#7b61ff", "#d3547e", "#00897b", "#e67e22", "#2878c7"];
function presenceColor(userId: string) {
  let hash = 0;
  for (let index = 0; index < userId.length; index++)
    hash = (hash * 31 + userId.charCodeAt(index)) | 0;
  return presenceColors[Math.abs(hash) % presenceColors.length];
}

const tools = [
  { id: "select", label: "editor.tool.select", key: "V", icon: MousePointer2 },
  { id: "object", label: "editor.tool.object", key: "O", icon: Armchair },
  { id: "floor", label: "editor.tool.floor", key: "F", icon: Layers },
  { id: "brush", label: "editor.tool.brush", key: "R", icon: Paintbrush },
  { id: "fill", label: "editor.tool.fill", key: "B", icon: PaintBucket },
  { id: "wall", label: "editor.tool.wall", key: "W", icon: BrickWall },
  { id: "zone", label: "editor.tool.zone", key: "Z", icon: Scan },
  { id: "portal", label: "editor.tool.portal", key: "P", icon: MapPin },
  { id: "spawn", label: "editor.tool.spawn", key: "S", icon: MapPin },
  { id: "label", label: "editor.tool.label", key: "T", icon: Type },
  { id: "erase", label: "editor.tool.erase", key: "E", icon: Eraser },
] as const;
const tips: Record<Tool, TranslationKey> = {
  select: "editor.tip.select",
  object: "editor.tip.object",
  floor: "editor.tip.floor",
  brush: "editor.tip.brush",
  fill: "editor.tip.fill",
  wall: "editor.tip.wall",
  zone: "editor.tip.zone",
  portal: "editor.tip.portal",
  spawn: "editor.tip.spawn",
  label: "editor.tip.label",
  erase: "editor.tip.erase",
};
const floorLabelKeys: Record<keyof typeof FLOOR_LABELS, TranslationKey> = {
  OAK: "editor.material.floor.oak",
  WOOD: "editor.material.floor.wood",
  CARPET_BLUE: "editor.material.floor.carpetBlue",
  CARPET_SAGE: "editor.material.floor.carpetSage",
  TILE: "editor.material.floor.tile",
  CONCRETE: "editor.material.floor.concrete",
  GRASS: "editor.material.floor.grass",
  PAVERS: "editor.material.floor.pavers",
};
const wallLabelKeys: Record<keyof typeof WALL_LABELS, TranslationKey> = {
  CREAM: "editor.material.wall.cream",
  SAGE: "editor.material.wall.sage",
  GLASS: "editor.material.wall.glass",
};
const ALL_ASSET_CATEGORIES = "__all__";
type EditorActionDialog =
  | {
      kind: "confirm";
      message: string;
      resolve: (value: boolean) => void;
    }
  | {
      kind: "prompt";
      message: string;
      resolve: (value: string | undefined) => void;
    };
const assetCategoryKeys: Record<string, TranslationKey> = {
  업무: "editor.asset.category.work",
  좌석: "editor.asset.category.seating",
  회의: "editor.asset.category.meeting",
  라운지: "editor.asset.category.lounge",
  수납: "editor.asset.category.storage",
  식물: "editor.asset.category.plants",
  장식: "editor.asset.category.decor",
  "바닥 장식": "editor.asset.category.floorDecor",
  캠퍼스: "editor.asset.category.campus",
};
export function MapEditor({
  space,
  user,
  close,
}: {
  space: Space;
  user: string;
  close: () => void;
}) {
  const { language, t } = useLanguage();
  const locale = language === "en" ? "en-US" : "ko-KR";
  const formatCoordinate = (value: number) =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  const formatCount = (value: number) =>
    new Intl.NumberFormat(locale).format(value);
  const [mapId, setMapId] = useState(space.id);
  const [mapCatalog, setMapCatalog] = useState<MapSummary[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [catalogBusy, setCatalogBusy] = useState(true);
  const editor = useMapEditor(space.id, user, mapId);
  const [options, setOptions] = useState<EditorOptions>({
    tool: "select",
    asset: "desk-monitor",
    direction: "down",
    floor: "OAK",
    wall: "CREAM",
    zoom: 0.65,
    grid: true,
    snapToGrid: true,
    collisions: false,
    zones: false,
    lockedLayers: {
      objects: false,
      floors: false,
      walls: false,
      zones: false,
      labels: false,
      portals: false,
    },
  });
  const [selected, select] = useState<Selection[]>([]),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(ALL_ASSET_CATEGORIES);
  const [collaborators, setCollaborators] = useState<MapEditParticipant[]>([]);
  const selectionForPresence = useRef(selected);
  selectionForPresence.current = selected;
  const [revisions, setRevisions] = useState<Revision[]>(),
    [historyBusy, setHistoryBusy] = useState(false);
  const [assetsReady, setAssetsReady] = useState(false),
    [assetBusy, setAssetBusy] = useState(false);
  const [pendingAssets, setPendingAssets] = useState<PendingSpaceAsset[]>([]);
  const [assetNotice, setAssetNotice] = useState<
    | { key: TranslationKey; variables?: Record<string, string | number> }
    | undefined
  >();
  const [reviewBusy, setReviewBusy] = useState(false);
  const [assetRevision, setAssetRevision] = useState(0);
  const [actionDialog, setActionDialog] = useState<EditorActionDialog>();
  const [actionDialogValue, setActionDialogValue] = useState("");
  const clipboard = useRef<
      { map: MapDefinition; selected: Selection[] } | undefined
    >(undefined),
    file = useRef<HTMLInputElement>(null);
  const actionDialogRef = useRef<EditorActionDialog | undefined>(undefined);
  const actionDialogInput = useRef<HTMLInputElement>(null);
  const editorRoot = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLElement>(null);
  const map = editor.map,
    writable = editor.writable && !editor.busy;
  const remoteSelections: RemoteSelection[] = collaborators.map(
    (participant) => ({
      userId: participant.userId,
      displayName: participant.displayName,
      color: presenceColor(participant.userId),
      selection: participant.selection.map((item) => ({
        kind: item.collection,
        id: item.entityId,
      })),
    }),
  );
  const assets = allOfficeAssets();
  function completeActionDialog(value: boolean | string | undefined) {
    const request = actionDialogRef.current;
    actionDialogRef.current = undefined;
    setActionDialog(undefined);
    if (!request) return;
    if (request.kind === "confirm") request.resolve(value === true);
    else request.resolve(typeof value === "string" ? value : undefined);
  }
  function confirmAction(message: string) {
    return new Promise<boolean>((resolve) => {
      const request: EditorActionDialog = {
        kind: "confirm",
        message,
        resolve,
      };
      actionDialogRef.current = request;
      setActionDialog(request);
    });
  }
  function promptAction(message: string, initialValue = "") {
    setActionDialogValue(initialValue);
    return new Promise<string | undefined>((resolve) => {
      const request: EditorActionDialog = {
        kind: "prompt",
        message,
        resolve,
      };
      actionDialogRef.current = request;
      setActionDialog(request);
    });
  }
  function cancelActionDialog() {
    completeActionDialog(undefined);
  }
  useEffect(
    () => () => {
      const request = actionDialogRef.current;
      actionDialogRef.current = undefined;
      if (request?.kind === "confirm") request.resolve(false);
      else if (request) request.resolve(undefined);
    },
    [],
  );
  const uploadedAssets = assets.filter((asset) => asset.source === "uploaded");
  const assetLabel = (assetId: string, fallback?: string) => {
    const originalName = fallback ?? ASSETS_BY_ID.get(assetId)?.name ?? assetId;
    return localizedAssetName(assetId, originalName, t);
  };
  useEffect(() => {
    let live = true;
    setCatalogBusy(true);
    setCatalogError("");
    listMaps(space.id)
      .then((items) => {
        if (!live) return;
        setMapCatalog(items);
      })
      .catch(() => {
        if (live) setCatalogError(t("editor.catalog.error.load"));
      })
      .finally(() => {
        if (live) setCatalogBusy(false);
      });
    return () => {
      live = false;
    };
  }, [space.id, t]);
  useEffect(() => {
    if (editor.editMode !== "COLLABORATIVE" || !editor.writable) {
      setCollaborators([]);
      return;
    }
    let live = true;
    const publish = () =>
      void updateCollaborativePresence(
        space.id,
        mapId,
        editor.clientId,
        selectionForPresence.current.map((item) => ({
          collection: item.kind,
          entityId: item.id,
        })),
      ).catch(() => {});
    const refresh = () =>
      void collaborativePresence(space.id, mapId, editor.clientId)
        .then((snapshot) => {
          if (live) setCollaborators(snapshot.participants);
        })
        .catch(() => {});
    const remove = () =>
      void removeCollaborativePresence(space.id, mapId, editor.clientId).catch(
        () => {},
      );
    publish();
    refresh();
    const heartbeat = setInterval(() => {
      publish();
      refresh();
    }, 2000);
    window.addEventListener("pagehide", remove);
    return () => {
      live = false;
      clearInterval(heartbeat);
      window.removeEventListener("pagehide", remove);
      remove();
    };
  }, [space.id, mapId, editor.editMode, editor.writable, editor.clientId]);
  useEffect(() => {
    if (editor.editMode !== "COLLABORATIVE" || !editor.writable) return;
    void updateCollaborativePresence(
      space.id,
      mapId,
      editor.clientId,
      selected.map((item) => ({ collection: item.kind, entityId: item.id })),
    ).catch(() => {});
  }, [
    space.id,
    mapId,
    editor.editMode,
    editor.writable,
    editor.clientId,
    selected,
  ]);
  async function switchMap(nextId: string) {
    if (nextId === mapId || catalogBusy || editor.busy || editor.saving) return;
    if (editor.dirty) {
      if (!(await confirmAction(t("editor.dialog.switchUnsaved")))) return;
      try {
        await editor.save();
      } catch {
        return;
      }
    }
    setMapId(nextId);
  }
  async function addMap() {
    if (editor.busy || editor.saving) return;
    const name = await promptAction(t("editor.dialog.createPrompt"));
    if (!name?.trim()) return;
    if (editor.dirty) {
      if (!(await confirmAction(t("editor.dialog.createSave")))) return;
      try {
        await editor.save();
      } catch {
        return;
      }
    }
    setCatalogBusy(true);
    setCatalogError("");
    try {
      const created = await createMap(
        space.id,
        name.trim(),
        space.templateId || "OFFICE",
      );
      const items = await listMaps(space.id);
      setMapCatalog(items);
      setMapId(created.mapId);
    } catch {
      setCatalogError(t("editor.catalog.error.create"));
    } finally {
      setCatalogBusy(false);
    }
  }
  async function moveMap(direction: -1 | 1) {
    const index = mapCatalog.findIndex((item) => item.mapId === mapId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= mapCatalog.length) return;
    const ids = mapCatalog.map((item) => item.mapId);
    [ids[index], ids[next]] = [ids[next], ids[index]];
    setCatalogBusy(true);
    setCatalogError("");
    try {
      setMapCatalog(await reorderMaps(space.id, ids));
    } catch {
      setCatalogError(t("editor.catalog.error.reorder"));
    } finally {
      setCatalogBusy(false);
    }
  }
  async function makeEntryMap() {
    if (mapCatalog.find((item) => item.mapId === mapId)?.entry) return;
    setCatalogBusy(true);
    setCatalogError("");
    try {
      setMapCatalog(await setEntryMap(space.id, mapId));
    } catch {
      setCatalogError(t("editor.catalog.error.entry"));
    } finally {
      setCatalogBusy(false);
    }
  }
  async function cloneCurrentMap() {
    const current = mapCatalog.find((item) => item.mapId === mapId);
    const name = await promptAction(
      t("editor.dialog.clonePrompt"),
      current
        ? `${current.name} ${t("editor.dialog.cloneSuffix")}`
        : t("editor.dialog.cloneSuffix"),
    );
    if (!name?.trim()) return;
    if (editor.dirty) {
      if (!(await confirmAction(t("editor.dialog.cloneSave")))) return;
      try {
        await editor.save();
      } catch {
        return;
      }
    }
    setCatalogBusy(true);
    setCatalogError("");
    try {
      const created = await cloneMapApi(space.id, mapId, name.trim());
      setMapCatalog(await listMaps(space.id));
      setMapId(created.mapId);
    } catch {
      setCatalogError(t("editor.catalog.error.clone"));
    } finally {
      setCatalogBusy(false);
    }
  }
  async function removeCurrentMap() {
    const current = mapCatalog.find((item) => item.mapId === mapId);
    if (!current || current.entry || mapId === space.id) return;
    const hasDraft = editor.dirty;
    if (
      !(await confirmAction(
        `${t("editor.dialog.deleteConfirm", { name: current.name })}${hasDraft ? ` ${t("editor.dialog.deleteUnsaved")}` : ""}`,
      ))
    )
      return;
    setCatalogBusy(true);
    setCatalogError("");
    try {
      await deleteMapApi(space.id, mapId);
      const items = await listMaps(space.id);
      setMapCatalog(items);
      if (mapId === current.mapId)
        setMapId(
          items.find((item) => item.entry)?.mapId ??
            items[0]?.mapId ??
            space.id,
        );
    } catch {
      setCatalogError(t("editor.catalog.error.delete"));
    } finally {
      setCatalogBusy(false);
    }
  }
  const mapEntries = map
    ? [
        ...map.objects.map((item) => ({
          key: `objects:${item.id}`,
          selection: { kind: "objects" as const, id: item.id },
          label: t("editor.list.object", {
            name: assetLabel(item.asset),
            x: formatCoordinate(item.x),
            y: formatCoordinate(item.y),
          }),
        })),
        ...map.walls.map((item) => ({
          key: `walls:${item.id}`,
          selection: { kind: "walls" as const, id: item.id },
          label: t("editor.list.wall", {
            x: formatCoordinate(item.bounds.x),
            y: formatCoordinate(item.bounds.y),
          }),
        })),
        ...map.floors.map((item) => ({
          key: `floors:${item.id}`,
          selection: { kind: "floors" as const, id: item.id },
          label: t("editor.list.floor", {
            name: t(floorLabelKeys[item.material]),
            x: formatCoordinate(item.bounds.x),
            y: formatCoordinate(item.bounds.y),
          }),
        })),
        ...map.zones.map((item) => {
          const kind =
            item.kind === "PRIVATE"
              ? `${t("editor.inspector.zone.private")} · ${formatCount(item.capacity ?? 12)}`
              : t(
                  item.kind === "SILENT"
                    ? "editor.inspector.zone.silent"
                    : item.kind === "STAGE"
                      ? "editor.inspector.zone.stage"
                      : "editor.inspector.zone.public",
                );
          return {
            key: `zones:${item.id}`,
            selection: { kind: "zones" as const, id: item.id },
            label: t("editor.list.zone", { name: item.name, kind }),
          };
        }),
        ...map.labels.map((item) => ({
          key: `labels:${item.id}`,
          selection: { kind: "labels" as const, id: item.id },
          label: t("editor.list.label", { name: item.text }),
        })),
        ...(map.portals ?? []).map((item) => ({
          key: `portals:${item.id}`,
          selection: { kind: "portals" as const, id: item.id },
          label: t("editor.list.portal", { name: item.name }),
        })),
      ]
    : [];
  useEffect(() => {
    select([]);
  }, [mapId]);
  useEffect(() => {
    let live = true;
    replaceCustomAssets([]);
    setAssetRevision((revision) => revision + 1);
    listSpaceAssets(space.id)
      .then((items) => {
        if (!live) return;
        replaceCustomAssets(items);
        setAssetRevision((revision) => revision + 1);
        setAssetsReady(true);
      })
      .catch((error) => {
        if (!live) return;
        replaceCustomAssets([]);
        setAssetRevision((revision) => revision + 1);
        editor.setError(t("editor.asset.error.load"));
        setAssetsReady(true);
      });
    if (space.role === "OWNER") {
      listPendingSpaceAssets(space.id)
        .then((items) => {
          if (live) setPendingAssets(items);
        })
        .catch((error) => {
          if (live) editor.setError(t("editor.asset.error.pending"));
        });
    } else {
      setPendingAssets([]);
    }
    return () => {
      live = false;
    };
  }, [space.id, t]);

  async function refreshApprovedAssets() {
    const items = await listSpaceAssets(space.id);
    replaceCustomAssets(items);
    setAssetRevision((revision) => revision + 1);
  }

  async function refreshPendingAssets() {
    if (space.role !== "OWNER") return;
    setPendingAssets(await listPendingSpaceAssets(space.id));
  }

  async function uploadAsset(file: File) {
    if (!writable || assetBusy) return;
    setAssetBusy(true);
    try {
      const item = await uploadSpaceAsset(space.id, file);
      if (item.status === "READY") {
        registerCustomAssets([item]);
        setAssetRevision((revision) => revision + 1);
        option("asset", item.id);
        option("tool", "object");
        setAssetNotice({ key: "editor.asset.notice.alreadyReady" });
      } else {
        setAssetNotice({ key: "editor.asset.notice.pending" });
        await refreshPendingAssets();
      }
    } catch (error) {
      editor.setError(t("editor.asset.error.upload"));
    } finally {
      setAssetBusy(false);
    }
  }

  async function approveAsset(asset: PendingSpaceAsset) {
    if (reviewBusy || space.role !== "OWNER") return;
    setReviewBusy(true);
    try {
      const approved = await approveSpaceAsset(space.id, asset.id);
      await Promise.all([refreshApprovedAssets(), refreshPendingAssets()]);
      setAssetNotice({
        key: "editor.asset.notice.approved",
        variables: { name: approved.name },
      });
    } catch (error) {
      editor.setError(t("editor.asset.error.approve"));
    } finally {
      setReviewBusy(false);
    }
  }

  async function rejectAsset(asset: PendingSpaceAsset) {
    if (reviewBusy || space.role !== "OWNER") return;
    if (
      !(await confirmAction(
        t("editor.asset.confirm.reject", { name: asset.name }),
      ))
    )
      return;
    setReviewBusy(true);
    try {
      await rejectSpaceAsset(space.id, asset.id);
      await refreshPendingAssets();
      setAssetNotice({
        key: "editor.asset.notice.rejected",
        variables: { name: asset.name },
      });
    } catch (error) {
      editor.setError(t("editor.asset.error.reject"));
    } finally {
      setReviewBusy(false);
    }
  }
  async function removeAsset(assetId: string) {
    if (!writable || assetBusy || !assetId.startsWith("custom_")) return;
    if (!(await confirmAction(t("editor.asset.confirm.delete")))) return;
    setAssetBusy(true);
    try {
      await deleteSpaceAsset(space.id, assetId);
      unregisterCustomAsset(assetId);
      setAssetRevision((revision) => revision + 1);
      if (options.asset === assetId) option("asset", "desk-monitor");
    } catch (error) {
      editor.setError(t("editor.asset.error.delete"));
    } finally {
      setAssetBusy(false);
    }
  }
  const option = <K extends keyof EditorOptions>(
    key: K,
    value: EditorOptions[K],
  ) => setOptions((o) => ({ ...o, [key]: value }));
  function fit() {
    if (!map || !workspace.current) return;
    option(
      "zoom",
      Math.max(
        0.15,
        Math.min(
          1,
          (workspace.current.clientWidth - 80) / (map.width * 32),
          (workspace.current.clientHeight - 145) / (map.height * 32),
        ),
      ),
    );
  }
  useEffect(() => {
    fit();
  }, [map?.id, map?.width, map?.height]);
  function remove() {
    if (!map || !writable) return;
    const removable = selected.filter(
      (selection) => !options.lockedLayers[selection.kind],
    );
    if (!removable.length) {
      editor.setError(t("editor.error.layerLocked"));
      return;
    }
    if (
      map.floors.every((f) =>
        removable.some((s) => s.kind === "floors" && s.id === f.id),
      )
    ) {
      editor.setError(t("editor.error.floorRequired"));
      return;
    }
    editor.edit((m) => {
      for (const kind of [
        "objects",
        "walls",
        "floors",
        "zones",
        "labels",
        "portals",
      ] as const) {
        // Each layer keeps its own type; filtering does not change the layer's element shape.
        Object.assign(m, {
          [kind]: (m[kind] ?? []).filter(
            (item) =>
              !removable.some((s) => s.kind === kind && s.id === item.id),
          ),
        });
      }
      return m;
    });
    select([]);
  }
  function copy() {
    if (map && selected.length)
      clipboard.current = {
        map: structuredClone(map),
        selected: [...selected],
      };
  }
  function reorder(direction: "front" | "back") {
    if (!map || !writable || selected.length !== 1) return;
    const target = selected[0];
    if (options.lockedLayers[target.kind]) {
      editor.setError(t("editor.error.orderLocked"));
      return;
    }
    const items = map[target.kind] ?? [];
    const index = items.findIndex((item) => item.id === target.id);
    if (index < 0) return;
    const nextIndex = direction === "front" ? index + 1 : index - 1;
    if (nextIndex < 0 || nextIndex >= items.length) return;
    editor.edit((m) => {
      const layer = [...(m[target.kind] ?? [])];
      const [item] = layer.splice(index, 1);
      layer.splice(nextIndex, 0, item);
      Object.assign(m, { [target.kind]: layer });
      return m;
    });
  }
  function paste() {
    const source = clipboard.current;
    if (!source || !writable) return;
    const next: Selection[] = [];
    editor.edit((m) => {
      for (const kind of [
        "objects",
        "walls",
        "floors",
        "zones",
        "labels",
        "portals",
      ] as const) {
        if (options.lockedLayers[kind]) continue;
        const copies = (source.map[kind] ?? [])
          .filter((item) =>
            source.selected.some((s) => s.kind === kind && s.id === item.id),
          )
          .map((item) => {
            const id = createUuid();
            next.push({ kind, id });
            return "bounds" in item
              ? {
                  ...item,
                  id,
                  bounds: {
                    ...item.bounds,
                    x: item.bounds.x + 0.5,
                    y: item.bounds.y + 0.5,
                  },
                }
              : { ...item, id, x: item.x + 0.5, y: item.y + 0.5 };
          });
        Object.assign(m, { [kind]: [...(m[kind] ?? []), ...copies] });
      }
      return m;
    });
    select(next);
    option("tool", "select");
  }
  async function leave() {
    if (editor.busy) return;
    if (editor.dirty) {
      if (!editor.writable) {
        if (await confirmAction(t("editor.dialog.leavePrompt"))) close();
        return;
      }
      try {
        await editor.save();
      } catch {
        if (!(await confirmAction(t("editor.dialog.leaveRecovery")))) return;
      }
    }
    close();
  }
  async function openHistory() {
    setHistoryBusy(true);
    try {
      setRevisions(await loadHistory(space.id, mapId));
    } catch {
      editor.setError(t("editor.history.error"));
    } finally {
      setHistoryBusy(false);
    }
  }
  async function restoreRevision(revision: Revision) {
    const message = t(
      editor.editMode === "COLLABORATIVE"
        ? "editor.dialog.collaborativeRestoreConfirm"
        : "editor.dialog.restoreConfirm",
    );
    if (!(await confirmAction(message))) return;
    setRevisions(undefined);
    void editor.publish(revision.id);
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target;
      if (
        !(target instanceof HTMLElement) ||
        !editorRoot.current?.contains(target) ||
        target.closest(
          "input,textarea,select,[contenteditable=true],dialog,button,a,summary,[role=button]",
        )
      )
        return;
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (["z", "y", "c", "v", "s"].includes(k)) e.preventDefault();
        if (k === "s") void editor.save().catch(() => {});
        if (k === "c") copy();
        if (k === "v") paste();
        if (writable && k === "z") e.shiftKey ? editor.redo() : editor.undo();
        if (writable && k === "y") editor.redo();
      } else {
        const tool = tools.find(
          (t) => t.key.toLowerCase() === e.key.toLowerCase(),
        );
        if (tool) {
          e.preventDefault();
          option("tool", tool.id);
          if (tool.id === "zone") option("zones", true);
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          remove();
        }
        if (e.key === "Escape") {
          select([]);
          option("tool", "select");
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const primary = selected.length === 1 ? selected[0] : undefined;
  const item =
    primary &&
    (map?.[primary.kind] ?? []).find((item) => item.id === primary.id);
  const primaryItems = primary && map ? (map[primary.kind] ?? []) : [];
  function property(key: string, value: string | number) {
    if (!primary || options.lockedLayers[primary.kind]) return;
    editor.edit((m) => {
      const target = (m[primary.kind] ?? []).find((i) => i.id === primary.id);
      if (target) {
        if ("bounds" in target && ["x", "y", "width", "height"].includes(key))
          Object.assign(target.bounds, { [key]: value });
        else Object.assign(target, { [key]: value });
      }
      return m;
    });
  }
  function setInteraction(value: MapObject["interaction"]) {
    if (!primary || primary.kind !== "objects" || options.lockedLayers.objects)
      return;
    editor.edit((m) => {
      const target = m.objects.find((object) => object.id === primary.id);
      if (!target) return m;
      if (value) target.interaction = value;
      else delete target.interaction;
      return m;
    });
  }
  function setObjectDirection(direction: NonNullable<MapObject["direction"]>) {
    if (!primary || primary.kind !== "objects" || !map) return;
    const object = map.objects.find((candidate) => candidate.id === primary.id);
    if (!object) return;
    const bounds = objectBounds({ ...object, direction });
    if (
      bounds.x < 0 ||
      bounds.y < 0 ||
      bounds.x + bounds.width > map.width ||
      bounds.y + bounds.height > map.height
    ) {
      editor.setError(t("editor.error.rotateBounds"));
      return;
    }
    property("direction", direction);
  }
  const number = (label: string, key: string, value: number, max = 96) => (
    <label className="editor-field" key={key}>
      {label}
      <input
        type="number"
        step={options.snapToGrid ? EDITOR_GRID_STEP : 0.1}
        min="0"
        max={max}
        value={value}
        onChange={(e) => {
          if (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber))
            property(key, e.target.valueAsNumber);
        }}
      />
    </label>
  );
  return (
    <div className="map-editor" ref={editorRoot}>
      <header className="editor-header">
        <div className="editor-heading">
          <button
            className="editor-icon"
            aria-label={t("editor.back")}
            onClick={() => void leave()}
            disabled={editor.busy}
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <span className="editor-eyebrow">{t("editor.brand")}</span>
            <h1>{space.name}</h1>
          </div>
        </div>
        <div className="editor-status" role="status">
          {editor.editMode === "COLLABORATIVE" ? (
            <>
              <UsersRound size={14} /> {t("editor.collaborative.active")}
            </>
          ) : editor.saving ? (
            t("editor.status.saving")
          ) : editor.dirty ? (
            t("editor.status.unsaved")
          ) : map ? (
            <>
              <Check size={14} /> {t("editor.status.saved")}
            </>
          ) : (
            t("editor.status.loading")
          )}
        </div>
        <div className="editor-actions">
          <button
            className="editor-icon"
            aria-label={t("editor.action.undo")}
            title={t("editor.action.undoShortcut")}
            onClick={editor.undo}
            disabled={!writable || !editor.canUndo}
          >
            <Undo2 size={18} />
          </button>
          <button
            className="editor-icon"
            aria-label={t("editor.action.redo")}
            title={t("editor.action.redoShortcut")}
            onClick={editor.redo}
            disabled={!writable || !editor.canRedo}
          >
            <Redo2 size={18} />
          </button>
          <span className="editor-divider" />
          <button
            className="editor-button"
            onClick={() => void openHistory()}
            disabled={historyBusy || !map}
          >
            <History size={16} />
            <span>{t("editor.action.history")}</span>
          </button>
          <button
            className="editor-button"
            onClick={() => void editor.save().catch(() => {})}
            disabled={!writable || editor.saving || !editor.dirty}
          >
            <Save size={16} />
            <span>{t("editor.action.save")}</span>
          </button>
          {editor.editMode === "LEGACY" && editor.writable && (
            <button
              className="editor-button"
              onClick={() => void editor.enableCollaborativeEditing()}
              disabled={editor.busy || editor.saving}
              title={t("editor.collaborative.enableHelp")}
            >
              <UsersRound size={16} />
              <span>{t("editor.collaborative.enable")}</span>
            </button>
          )}
          <button
            className="editor-publish"
            onClick={() => void editor.publish()}
            disabled={!writable || !map || editor.saving}
          >
            <Upload size={16} />
            {editor.busy
              ? t("editor.action.processing")
              : t("editor.action.publish")}
          </button>
        </div>
      </header>
      <div className="editor-map-catalog">
        <label>
          <span>{t("editor.catalog.label")}</span>
          <select
            aria-label={t("editor.catalog.select")}
            value={mapId}
            disabled={catalogBusy || editor.busy || editor.saving}
            onChange={(event) => void switchMap(event.target.value)}
          >
            {mapCatalog.map((item) => (
              <option key={item.mapId} value={item.mapId}>
                {item.name}
                {item.entry ? t("editor.catalog.entry") : ""}
              </option>
            ))}
          </select>
        </label>
        {!catalogBusy && !catalogError && mapCatalog.length === 0 && (
          <span className="editor-map-empty" role="status">
            {t("editor.catalog.empty")}
          </span>
        )}
        <button
          className="editor-button"
          aria-label={t("editor.catalog.moveUp")}
          title={t("editor.catalog.moveUpTitle")}
          disabled={
            catalogBusy ||
            mapCatalog.findIndex((item) => item.mapId === mapId) <= 0
          }
          onClick={() => void moveMap(-1)}
        >
          <ArrowUp size={15} />
        </button>
        <button
          className="editor-button"
          aria-label={t("editor.catalog.moveDown")}
          title={t("editor.catalog.moveDownTitle")}
          disabled={
            catalogBusy ||
            mapCatalog.findIndex((item) => item.mapId === mapId) < 0 ||
            mapCatalog.findIndex((item) => item.mapId === mapId) >=
              mapCatalog.length - 1
          }
          onClick={() => void moveMap(1)}
        >
          <ArrowDown size={15} />
        </button>
        <button
          className="editor-button"
          disabled={
            catalogBusy ||
            mapCatalog.find((item) => item.mapId === mapId)?.entry
          }
          onClick={() => void makeEntryMap()}
        >
          {t("editor.catalog.setEntry")}
        </button>
        <button
          className="editor-button"
          aria-label={t("editor.catalog.cloneMap")}
          disabled={catalogBusy || !map}
          onClick={() => void cloneCurrentMap()}
        >
          <Copy size={15} />
          <span>{t("editor.catalog.clone")}</span>
        </button>
        <button
          className="editor-button"
          aria-label={t("editor.catalog.deleteMap")}
          disabled={
            catalogBusy ||
            mapId === space.id ||
            mapCatalog.find((item) => item.mapId === mapId)?.entry
          }
          onClick={() => void removeCurrentMap()}
        >
          <Trash2 size={15} />
          <span>{t("editor.catalog.delete")}</span>
        </button>
        <button
          className="editor-button"
          disabled={catalogBusy || editor.busy || editor.saving}
          onClick={() => void addMap()}
        >
          <span>{t("editor.catalog.new")}</span>
        </button>
        {catalogError && (
          <span className="editor-map-error" role="status">
            {catalogError}
          </span>
        )}
      </div>
      {editor.error && (
        <div className="editor-alert" role="alert">
          {editor.error}
          <button
            aria-label={t("editor.alert.close")}
            onClick={() => editor.setError("")}
          >
            ×
          </button>
        </div>
      )}
      {editor.collaborativeConflict && (
        <div className="editor-banner" role="alert">
          <span>{t("editor.collaborative.recovery")}</span>
          <button onClick={editor.discardCollaborativeConflict}>
            {t("editor.collaborative.useLatest")}
          </button>
        </div>
      )}
      {!editor.writable && map && (
        <div className="editor-banner">
          <LockKeyhole size={16} />
          <span>{t("editor.readOnly")}</span>
          <button onClick={editor.takeover} disabled={editor.busy}>
            {t("editor.takeover")}
          </button>
        </div>
      )}
      {editor.recovery && (
        <div className="editor-banner">
          <span>{t("editor.recovery.available")}</span>
          <button onClick={editor.recover} disabled={!writable}>
            {t("editor.recovery.load")}
          </button>
        </div>
      )}
      {editor.notice && (
        <div className="editor-notice" role="status">
          {editor.notice}
        </div>
      )}
      {editor.editMode === "COLLABORATIVE" && collaborators.length > 0 && (
        <div className="editor-collaborators" role="status">
          <UsersRound size={15} />
          <span>{t("editor.collaborative.presence")}</span>
          {collaborators.map((participant) => (
            <span
              className="editor-collaborator"
              key={participant.clientId}
              style={
                {
                  "--presence-color": presenceColor(participant.userId),
                } as CSSProperties
              }
              title={t("editor.collaborative.selectionCount", {
                name: participant.displayName,
                count: participant.selection.length,
              })}
            >
              <i aria-hidden="true" />
              {participant.displayName}
            </span>
          ))}
        </div>
      )}
      <div className="editor-body">
        <nav className="editor-tools" aria-label={t("editor.tools")}>
          {tools.map((tool) => (
            <button
              key={tool.id}
              className={options.tool === tool.id ? "active" : ""}
              aria-pressed={options.tool === tool.id}
              aria-label={t("editor.tool.aria", { tool: t(tool.label) })}
              title={t("editor.tool.shortcut", {
                tool: t(tool.label),
                key: tool.key,
              })}
              onClick={() => {
                option("tool", tool.id);
                if (tool.id === "zone") option("zones", true);
              }}
            >
              <tool.icon size={21} />
              <span>{t(tool.label)}</span>
              <kbd>{tool.key}</kbd>
            </button>
          ))}
        </nav>
        <aside className="editor-library">
          <div className="editor-panel-title">
            <span>{t("editor.library.title")}</span>
            <small>
              {t("editor.library.assetCount", { count: assets.length })}
            </small>
          </div>
          <p className="editor-tool-tip">{t(tips[options.tool])}</p>
          {(options.tool === "floor" ||
            options.tool === "brush" ||
            options.tool === "fill") && (
            <label className="editor-field">
              {t("editor.asset.floorMaterial")}
              <select
                aria-label={t("editor.asset.floorMaterial")}
                value={options.floor}
                onChange={(e) =>
                  option("floor", e.target.value as EditorOptions["floor"])
                }
              >
                {Object.keys(FLOOR_LABELS).map((key) => (
                  <option key={key} value={key}>
                    {t(floorLabelKeys[key as keyof typeof FLOOR_LABELS])}
                  </option>
                ))}
              </select>
            </label>
          )}
          {options.tool === "wall" && (
            <label className="editor-field">
              {t("editor.asset.wallMaterial")}
              <select
                aria-label={t("editor.asset.wallMaterial")}
                value={options.wall}
                onChange={(e) =>
                  option("wall", e.target.value as EditorOptions["wall"])
                }
              >
                {Object.keys(WALL_LABELS).map((key) => (
                  <option key={key} value={key}>
                    {t(wallLabelKeys[key as keyof typeof WALL_LABELS])}
                  </option>
                ))}
              </select>
            </label>
          )}
          {options.tool === "object" && (
            <label className="editor-field">
              {t("editor.asset.direction")}
              <select
                aria-label={t("editor.asset.direction")}
                value={options.direction}
                onChange={(event) =>
                  option(
                    "direction",
                    event.target.value as EditorOptions["direction"],
                  )
                }
              >
                {OBJECT_DIRECTIONS.map((direction) => (
                  <option key={direction} value={direction}>
                    {t(
                      (
                        {
                          down: "editor.asset.direction.down",
                          left: "editor.asset.direction.left",
                          up: "editor.asset.direction.up",
                          right: "editor.asset.direction.right",
                        } as const
                      )[direction],
                    )}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="editor-search">
            <input
              aria-label={t("editor.asset.search")}
              placeholder={t("editor.asset.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="editor-upload-asset">
            <span>
              {assetBusy
                ? t("editor.asset.uploading")
                : t("editor.asset.upload")}
            </span>
            <input
              type="file"
              accept="image/png,image/jpeg"
              disabled={!writable || assetBusy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void uploadAsset(file);
              }}
            />
          </label>
          {assetNotice && (
            <p className="editor-asset-notice" role="status">
              {t(assetNotice.key, assetNotice.variables)}
            </p>
          )}
          {space.role === "OWNER" && pendingAssets.length > 0 && (
            <section
              className="editor-asset-review"
              aria-label={t("editor.asset.pending")}
            >
              <h3>
                {t("editor.asset.pendingCount", {
                  count: pendingAssets.length,
                })}
              </h3>
              {pendingAssets.map((asset) => (
                <article className="editor-asset-review-item" key={asset.id}>
                  <img
                    src={asset.reviewContentUrl}
                    alt={t("editor.asset.preview", { name: asset.name })}
                  />
                  <div className="editor-asset-review-details">
                    <strong title={asset.name}>
                      {assetLabel(asset.id, asset.name)}
                    </strong>
                    <small>
                      {asset.uploadedBy} · {asset.width}×{asset.height}px
                    </small>
                    <div>
                      <button
                        type="button"
                        disabled={reviewBusy}
                        onClick={() => void approveAsset(asset)}
                      >
                        {t("editor.asset.approve")}
                      </button>
                      <button
                        type="button"
                        disabled={reviewBusy}
                        onClick={() => void rejectAsset(asset)}
                      >
                        {t("editor.asset.reject")}
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </section>
          )}
          <div className="editor-categories">
            {[
              ALL_ASSET_CATEGORIES,
              ...new Set(assets.map((a) => a.category)),
            ].map((c) => (
              <button
                key={c}
                className={c === category ? "active" : ""}
                onClick={() => setCategory(c)}
              >
                {c === ALL_ASSET_CATEGORIES
                  ? t("editor.asset.category.all")
                  : assetCategoryKeys[c]
                    ? t(assetCategoryKeys[c])
                    : c}
              </button>
            ))}
          </div>
          <div className="editor-assets">
            {assets
              .filter(
                (a) =>
                  (category === ALL_ASSET_CATEGORIES ||
                    a.category === category) &&
                  [a.name, assetLabel(a.id, a.name)].some((name) =>
                    name
                      .toLocaleLowerCase(locale)
                      .includes(search.toLocaleLowerCase(locale)),
                  ),
              )
              .map((a) => (
                <div className="editor-asset-entry" key={a.id}>
                  <button
                    title={assetLabel(a.id, a.name)}
                    aria-label={t("editor.asset.place", {
                      name: assetLabel(a.id, a.name),
                    })}
                    aria-pressed={
                      options.tool === "object" && options.asset === a.id
                    }
                    className={
                      options.tool === "object" && options.asset === a.id
                        ? "active"
                        : ""
                    }
                    onClick={(event) => {
                      option("asset", a.id);
                      option("tool", "object");
                      if (event.detail === 0)
                        requestAnimationFrame(() =>
                          document.getElementById("map-editor-canvas")?.focus(),
                        );
                    }}
                  >
                    <div>
                      <img
                        src={a.thumbnailUrl ?? a.url}
                        alt=""
                        loading="lazy"
                      />
                    </div>
                    <span>{assetLabel(a.id, a.name)}</span>
                  </button>
                  {a.source === "uploaded" && (
                    <button
                      type="button"
                      className="editor-asset-delete"
                      aria-label={t("editor.asset.delete", { name: a.name })}
                      disabled={!writable || assetBusy}
                      onClick={() => void removeAsset(a.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
          </div>
          <div className="editor-library-footer">
            <button onClick={editor.download} disabled={!map}>
              <Download size={14} /> {t("editor.asset.export")}
            </button>
            <button onClick={() => file.current?.click()} disabled={!writable}>
              {t("editor.asset.import")}
            </button>
            <input
              hidden
              ref={file}
              type="file"
              accept=".json,application/json"
              aria-label={t("editor.asset.importLabel")}
              onChange={async (e) => {
                const picked = e.target.files?.[0];
                e.target.value = "";
                if (!picked) return;
                try {
                  if (picked.size > 512_000) {
                    editor.setError(t("editor.asset.importTooLarge"));
                    return;
                  }
                  const imported = importMap(JSON.parse(await picked.text()));
                  if (await confirmAction(t("editor.asset.importConfirm"))) {
                    editor.edit(() => imported);
                    select([]);
                  }
                } catch (cause) {
                  editor.setError(
                    cause instanceof MapImportError
                      ? t(cause.translationKey)
                      : t("editor.asset.error.import"),
                  );
                }
              }}
            />
          </div>
        </aside>
        <main className="editor-workspace" ref={workspace}>
          <div className="editor-view-options">
            <div>
              <button
                className={options.grid ? "active" : ""}
                onClick={() => option("grid", !options.grid)}
                aria-pressed={options.grid}
                title={t("editor.view.gridTitle")}
              >
                <Grid2X2 size={14} /> {t("editor.view.grid")}
              </button>
              <button
                className={options.snapToGrid ? "active" : ""}
                onClick={() => option("snapToGrid", !options.snapToGrid)}
                aria-label={
                  options.snapToGrid
                    ? t("editor.view.snapOff")
                    : t("editor.view.snapOn")
                }
                aria-pressed={options.snapToGrid}
                title={t("editor.view.snapTitle")}
              >
                <Magnet size={14} /> {t("editor.view.snap")}
              </button>
              <button
                className={options.collisions ? "active" : ""}
                onClick={() => option("collisions", !options.collisions)}
                aria-pressed={options.collisions}
              >
                {t("editor.view.collisions")}
              </button>
              <button
                className={options.zones ? "active" : ""}
                onClick={() => option("zones", !options.zones)}
                aria-pressed={options.zones}
              >
                {t("editor.view.zones")}
              </button>
            </div>
            <div>
              <button
                aria-label={t("editor.view.zoomOut")}
                onClick={() =>
                  option("zoom", Math.max(0.15, options.zoom - 0.1))
                }
              >
                <ZoomOut size={16} />
              </button>
              <span>{Math.round(options.zoom * 100)}%</span>
              <button onClick={fit}>{t("editor.view.fit")}</button>
              <button
                aria-label={t("editor.view.zoomIn")}
                onClick={() =>
                  option("zoom", Math.min(1.5, options.zoom + 0.1))
                }
              >
                <ZoomIn size={16} />
              </button>
            </div>
          </div>
          {map && assetsReady ? (
            <>
              {map.objects.length === 0 &&
                map.walls.length === 0 &&
                map.zones.length === 0 &&
                map.labels.length === 0 &&
                (map.portals ?? []).length === 0 && (
                  <div className="editor-empty-state" role="status">
                    {t("editor.emptyMap")}
                  </div>
                )}
              <EditorCanvas
                map={map}
                options={options}
                selected={selected}
                remoteSelections={remoteSelections}
                select={select}
                edit={editor.edit}
                writable={writable}
                assetRevision={assetRevision}
                onError={editor.setError}
              />
            </>
          ) : editor.error ? (
            <div
              className="editor-load-error"
              role="group"
              aria-label={t("editor.loadError.label")}
            >
              <span>{t("editor.loadError.message")}</span>
              <button onClick={editor.retry} disabled={editor.busy}>
                {t("editor.loadError.retry")}
              </button>
            </div>
          ) : (
            <div className="editor-loading" role="status">
              {editor.busy
                ? t("editor.loading.map")
                : t("editor.loading.assets")}
            </div>
          )}
        </main>
        <aside className="editor-properties">
          <div className="editor-panel-title">
            {t("editor.properties.title")}{" "}
            <small>
              {selected.length
                ? t("editor.properties.selected", { count: selected.length })
                : "MAP"}
            </small>
          </div>
          {map && (
            <>
              <fieldset className="editor-layer-locks" disabled={!writable}>
                <legend>
                  <LockKeyhole size={13} /> {t("editor.properties.lockTitle")}
                </legend>
                <p>{t("editor.properties.lockHelp")}</p>
                {(
                  [
                    ["objects", "editor.properties.layer.objects"],
                    ["floors", "editor.properties.layer.floors"],
                    ["walls", "editor.properties.layer.walls"],
                    ["zones", "editor.properties.layer.zones"],
                    ["labels", "editor.properties.layer.labels"],
                    ["portals", "editor.properties.layer.portals"],
                  ] as const
                ).map(([kind, label]) => (
                  <label key={kind}>
                    <input
                      type="checkbox"
                      checked={options.lockedLayers[kind]}
                      onChange={(event) => {
                        option("lockedLayers", {
                          ...options.lockedLayers,
                          [kind]: event.target.checked,
                        });
                        if (event.target.checked)
                          select(selected.filter((item) => item.kind !== kind));
                      }}
                    />
                    <span>{t(label)}</span>
                  </label>
                ))}
              </fieldset>
              <fieldset disabled={!writable}>
                <label className="editor-field">
                  {t("editor.properties.mapName")}
                  <input
                    aria-label={t("editor.properties.mapName")}
                    value={map.name}
                    maxLength={60}
                    onChange={(e) =>
                      editor.edit((m) => ({ ...m, name: e.target.value }))
                    }
                  />
                </label>
              </fieldset>
              {item && primary ? (
                <fieldset
                  disabled={!writable || !!options.lockedLayers[primary.kind]}
                  className="editor-item-properties"
                >
                  <h3>
                    {"asset" in item
                      ? assetLabel(item.asset)
                      : "text" in item
                        ? t("editor.inspector.kind.label")
                        : primary.kind === "portals"
                          ? t("editor.inspector.kind.portal")
                          : "kind" in item && item.kind === "STAGE"
                            ? t("editor.inspector.kind.stage")
                            : "name" in item
                              ? t("editor.inspector.kind.zone")
                              : primary.kind === "walls"
                                ? t("editor.inspector.kind.wall")
                                : t("editor.inspector.kind.floor")}
                  </h3>
                  {"text" in item && (
                    <label className="editor-field">
                      {t("editor.inspector.field.labelText")}
                      <input
                        value={item.text}
                        maxLength={40}
                        onChange={(e) => property("text", e.target.value)}
                      />
                    </label>
                  )}
                  {primary.kind === "labels" && "text" in item && (
                    <label className="editor-field">
                      {t("editor.inspector.field.linkOptional")}
                      <input
                        type="url"
                        placeholder="https://example.com"
                        value={"link" in item ? (item.link ?? "") : ""}
                        maxLength={2048}
                        onChange={(e) =>
                          property("link", e.target.value.trim())
                        }
                      />
                      <small className="editor-field-help">
                        {t("editor.inspector.help.labelLink")}
                      </small>
                    </label>
                  )}
                  {primary.kind === "objects" && "asset" in item && (
                    <>
                      <label className="editor-field">
                        {t("editor.inspector.field.direction")}
                        <select
                          aria-label={t("editor.inspector.field.direction")}
                          value={item.direction ?? "down"}
                          onChange={(event) =>
                            setObjectDirection(
                              event.target.value as NonNullable<
                                MapObject["direction"]
                              >,
                            )
                          }
                        >
                          {OBJECT_DIRECTIONS.map((direction) => (
                            <option key={direction} value={direction}>
                              {
                                {
                                  down: t("editor.inspector.direction.down"),
                                  left: t("editor.inspector.direction.left"),
                                  up: t("editor.inspector.direction.up"),
                                  right: t("editor.inspector.direction.right"),
                                }[direction]
                              }
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="editor-field">
                        {t("editor.inspector.field.interaction")}
                        <select
                          value={item.interaction?.kind ?? ""}
                          onChange={(event) => {
                            const kind = event.target.value as
                              | NonNullable<MapObject["interaction"]>["kind"]
                              | "";
                            if (!kind) {
                              setInteraction(undefined);
                              return;
                            }
                            if (kind === "IMAGE" && !uploadedAssets.length) {
                              editor.setError(
                                t("editor.asset.error.imageRequired"),
                              );
                              return;
                            }
                            const next: NonNullable<MapObject["interaction"]> =
                              {
                                kind,
                                title:
                                  item.interaction?.title ??
                                  (kind === "NOTICE"
                                    ? t("editor.inspector.default.title.notice")
                                    : kind === "IMAGE"
                                      ? t(
                                          "editor.inspector.default.title.image",
                                        )
                                      : kind === "BOARD"
                                        ? t(
                                            "editor.inspector.default.title.board",
                                          )
                                        : kind === "SOUND"
                                          ? t(
                                              "editor.inspector.default.title.sound",
                                            )
                                          : kind === "SCAVENGER_ITEM"
                                            ? t(
                                                "editor.inspector.default.title.stamp",
                                              )
                                            : t(
                                                "editor.inspector.default.title.link",
                                              )),
                                body:
                                  kind === "SOUND"
                                    ? ""
                                    : kind === "NPC"
                                      ? item.interaction?.kind === "NPC"
                                        ? (item.interaction.body ??
                                          t(
                                            "editor.inspector.default.body.npc",
                                          ))
                                        : t("editor.inspector.default.body.npc")
                                      : kind === "SCAVENGER_ITEM"
                                        ? item.interaction?.kind ===
                                          "SCAVENGER_ITEM"
                                          ? (item.interaction.body ?? "")
                                          : t(
                                              "editor.inspector.default.body.stamp",
                                            )
                                        : (item.interaction?.body ?? ""),
                              };
                            if (kind === "IMAGE") {
                              const assetId =
                                item.interaction?.assetId ??
                                uploadedAssets[0]?.id;
                              if (!assetId) return;
                              next.assetId = assetId;
                            } else if (kind === "LINK" || kind === "VIDEO")
                              next.url =
                                item.interaction?.kind === kind
                                  ? (item.interaction.url ?? "https://")
                                  : "https://";
                            else if (kind === "SOUND") {
                              next.url =
                                item.interaction?.kind === "SOUND"
                                  ? (item.interaction.url ?? "")
                                  : "";
                              next.radius =
                                item.interaction?.kind === "SOUND"
                                  ? (item.interaction.radius ?? 6)
                                  : 6;
                              next.volume =
                                item.interaction?.kind === "SOUND"
                                  ? (item.interaction.volume ?? 50)
                                  : 50;
                            }
                            setInteraction(next);
                          }}
                        >
                          <option value="">
                            {t("editor.inspector.interaction.none")}
                          </option>
                          <option value="NOTICE">
                            {t("editor.inspector.interaction.notice")}
                          </option>
                          <option value="LINK">
                            {t("editor.inspector.interaction.link")}
                          </option>
                          <option value="VIDEO">
                            {t("editor.inspector.interaction.video")}
                          </option>
                          <option
                            value="IMAGE"
                            disabled={!assetsReady || !uploadedAssets.length}
                          >
                            {t("editor.inspector.interaction.image")}
                          </option>
                          <option value="BOARD">
                            {t("editor.inspector.interaction.board")}
                          </option>
                          <option value="NPC">
                            {t("editor.inspector.interaction.npc")}
                          </option>
                          <option value="SCAVENGER_ITEM">
                            {t("editor.inspector.interaction.scavenger")}
                          </option>
                          <option value="SOUND">
                            {t("editor.inspector.interaction.sound")}
                          </option>
                        </select>
                        <small className="editor-field-help">
                          {t("editor.inspector.help.interaction")}
                        </small>
                      </label>
                      {item.interaction && (
                        <>
                          <label className="editor-field">
                            {t("editor.inspector.field.title")}
                            <input
                              maxLength={80}
                              value={item.interaction.title}
                              onChange={(event) =>
                                setInteraction({
                                  ...item.interaction!,
                                  title: event.target.value,
                                })
                              }
                            />
                          </label>
                          {item.interaction.kind === "IMAGE" && (
                            <>
                              <label className="editor-field">
                                {t("editor.inspector.field.image")}
                                <select
                                  aria-label={t("editor.inspector.field.image")}
                                  value={item.interaction.assetId ?? ""}
                                  onChange={(event) =>
                                    setInteraction({
                                      ...item.interaction!,
                                      assetId: event.target.value,
                                    })
                                  }
                                >
                                  {uploadedAssets.map((asset) => (
                                    <option key={asset.id} value={asset.id}>
                                      {asset.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              {uploadedAssets.find(
                                (asset) =>
                                  asset.id === item.interaction?.assetId,
                              ) && (
                                <img
                                  className="editor-interaction-image"
                                  src={
                                    uploadedAssets.find(
                                      (asset) =>
                                        asset.id === item.interaction?.assetId,
                                    )?.thumbnailUrl ??
                                    uploadedAssets.find(
                                      (asset) =>
                                        asset.id === item.interaction?.assetId,
                                    )?.url
                                  }
                                  alt={t("editor.inspector.alt.imagePreview")}
                                />
                              )}
                            </>
                          )}
                          {item.interaction.kind === "NOTICE" ||
                          item.interaction.kind === "IMAGE" ||
                          item.interaction.kind === "BOARD" ||
                          item.interaction.kind === "NPC" ||
                          item.interaction.kind === "SCAVENGER_ITEM" ? (
                            <label className="editor-field">
                              {item.interaction.kind === "NOTICE"
                                ? t("editor.inspector.field.noticeBody")
                                : item.interaction.kind === "IMAGE"
                                  ? t("editor.inspector.field.imageDescription")
                                  : item.interaction.kind === "BOARD"
                                    ? t("editor.inspector.field.boardHint")
                                    : item.interaction.kind === "NPC"
                                      ? t("editor.inspector.field.npcLines")
                                      : t(
                                          "editor.inspector.field.scavengerClue",
                                        )}
                              <textarea
                                rows={5}
                                maxLength={
                                  item.interaction.kind === "SCAVENGER_ITEM"
                                    ? 280
                                    : 2000
                                }
                                value={item.interaction.body ?? ""}
                                onChange={(event) =>
                                  setInteraction({
                                    ...item.interaction!,
                                    body: event.target.value,
                                  })
                                }
                              />
                            </label>
                          ) : (
                            <label className="editor-field">
                              {t("editor.inspector.field.url")}
                              <input
                                type="url"
                                placeholder={
                                  item.interaction.kind === "SOUND"
                                    ? "https://example.com/ambience.mp3"
                                    : "https://example.com"
                                }
                                maxLength={2048}
                                value={item.interaction.url ?? ""}
                                onChange={(event) =>
                                  setInteraction({
                                    ...item.interaction!,
                                    url: event.target.value.trim(),
                                  })
                                }
                              />
                              <small className="editor-field-help">
                                {item.interaction.kind === "SOUND"
                                  ? t("editor.inspector.help.audioUrl")
                                  : t("editor.inspector.help.webUrl")}
                              </small>
                            </label>
                          )}
                          {item.interaction.kind === "SOUND" && (
                            <>
                              <label className="editor-field">
                                {t("editor.inspector.field.soundRadius", {
                                  radius: formatCount(
                                    item.interaction.radius ?? 6,
                                  ),
                                })}
                                <input
                                  type="range"
                                  min={1}
                                  max={20}
                                  step={1}
                                  value={item.interaction.radius ?? 6}
                                  onChange={(event) =>
                                    setInteraction({
                                      ...item.interaction!,
                                      radius: Number(event.target.value),
                                    })
                                  }
                                />
                              </label>
                              <label className="editor-field">
                                {t("editor.inspector.field.soundVolume", {
                                  volume: formatCount(
                                    item.interaction.volume ?? 50,
                                  ),
                                })}
                                <input
                                  type="range"
                                  min={1}
                                  max={100}
                                  step={1}
                                  value={item.interaction.volume ?? 50}
                                  onChange={(event) =>
                                    setInteraction({
                                      ...item.interaction!,
                                      volume: Number(event.target.value),
                                    })
                                  }
                                />
                              </label>
                            </>
                          )}
                        </>
                      )}
                    </>
                  )}
                  {primary.kind === "zones" &&
                    "name" in item &&
                    "kind" in item && (
                      <>
                        <label className="editor-field">
                          {t("editor.inspector.field.zoneName")}
                          <input
                            value={item.name}
                            maxLength={40}
                            onChange={(e) => property("name", e.target.value)}
                          />
                        </label>
                        <label className="editor-field">
                          {t("editor.inspector.field.zoneKind")}
                          <select
                            value={item.kind}
                            onChange={(e) => {
                              const kind = e.target.value as Zone["kind"];
                              editor.edit((m) => {
                                const zone = m.zones.find(
                                  (candidate) => candidate.id === item.id,
                                );
                                if (zone) {
                                  zone.kind = kind;
                                  if (kind === "PRIVATE") zone.capacity ??= 12;
                                  else delete zone.capacity;
                                }
                                return m;
                              });
                            }}
                          >
                            <option value="PRIVATE">
                              {t("editor.inspector.zone.private")}
                            </option>
                            <option value="PUBLIC">
                              {t("editor.inspector.zone.public")}
                            </option>
                            <option value="SILENT">
                              {t("editor.inspector.zone.silent")}
                            </option>
                            <option value="STAGE">
                              {t("editor.inspector.zone.stage")}
                            </option>
                          </select>
                          <small className="editor-field-help">
                            {item.kind === "PRIVATE"
                              ? t("editor.inspector.help.zonePrivate")
                              : item.kind === "SILENT"
                                ? t("editor.inspector.help.zoneSilent")
                                : item.kind === "STAGE"
                                  ? t("editor.inspector.help.zoneStage")
                                  : t("editor.inspector.help.zonePublic")}
                          </small>
                        </label>
                        {item.kind === "PRIVATE" && (
                          <label className="editor-field">
                            {t("editor.inspector.field.capacity", {
                              count: formatCount(item.capacity ?? 12),
                            })}
                            <input
                              type="number"
                              min={2}
                              max={100}
                              step={1}
                              value={item.capacity ?? 12}
                              onChange={(event) => {
                                const capacity =
                                  event.currentTarget.valueAsNumber;
                                if (Number.isFinite(capacity))
                                  property("capacity", capacity);
                              }}
                            />
                            <small className="editor-field-help">
                              {t("editor.inspector.help.capacity")}
                            </small>
                          </label>
                        )}
                      </>
                    )}
                  {primary.kind === "portals" && "targetSpaceId" in item && (
                    <>
                      <label className="editor-field">
                        {t("editor.inspector.field.portalName")}
                        <input
                          value={item.name}
                          maxLength={40}
                          onChange={(e) => property("name", e.target.value)}
                        />
                      </label>
                      <label className="editor-field">
                        {t("editor.inspector.field.targetSpace")}
                        <input
                          value={item.targetSpaceId}
                          maxLength={80}
                          pattern="[A-Za-z0-9_-]{1,80}"
                          onChange={(e) => {
                            property("targetSpaceId", e.target.value.trim());
                            if (e.target.value.trim() !== space.id)
                              property("targetMapId", "");
                          }}
                        />
                        <small className="editor-field-help">
                          {t("editor.inspector.help.targetSpace")}
                        </small>
                      </label>
                      <label className="editor-field">
                        {t("editor.inspector.field.targetMap")}
                        {item.targetSpaceId === space.id ? (
                          <select
                            value={item.targetMapId || ""}
                            onChange={(e) =>
                              property("targetMapId", e.target.value)
                            }
                          >
                            <option value="">
                              {t("editor.inspector.target.entryMap")}
                            </option>
                            {mapCatalog.map((entry) => (
                              <option key={entry.mapId} value={entry.mapId}>
                                {entry.name}
                                {entry.entry
                                  ? t("editor.inspector.target.entrySuffix")
                                  : ""}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            value={item.targetMapId ?? ""}
                            maxLength={36}
                            placeholder={t(
                              "editor.inspector.target.mapPlaceholder",
                            )}
                            onChange={(e) =>
                              property("targetMapId", e.target.value.trim())
                            }
                          />
                        )}
                        <small className="editor-field-help">
                          {t("editor.inspector.help.targetMap")}
                        </small>
                      </label>
                      <div className="editor-number-grid">
                        {number(
                          t("editor.inspector.field.arrivalX"),
                          "targetSpawnX",
                          item.targetSpawnX ?? 0,
                          96,
                        )}
                        {number(
                          t("editor.inspector.field.arrivalY"),
                          "targetSpawnY",
                          item.targetSpawnY ?? 0,
                          96,
                        )}
                      </div>
                    </>
                  )}
                  {"material" in item && (
                    <label className="editor-field">
                      {t("editor.inspector.field.material")}
                      <select
                        value={item.material}
                        onChange={(e) => property("material", e.target.value)}
                      >
                        {Object.entries(
                          primary.kind === "walls" ? WALL_LABELS : FLOOR_LABELS,
                        ).map(([k, v]) => (
                          <option key={k} value={k}>
                            {t(
                              primary.kind === "walls"
                                ? wallLabelKeys[k as keyof typeof WALL_LABELS]
                                : floorLabelKeys[
                                    k as keyof typeof FLOOR_LABELS
                                  ],
                            )}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="editor-number-grid">
                    {"bounds" in item ? (
                      <>
                        {number(
                          t("editor.inspector.field.x"),
                          "x",
                          item.bounds.x,
                          map.width,
                        )}
                        {number(
                          t("editor.inspector.field.y"),
                          "y",
                          item.bounds.y,
                          map.height,
                        )}
                        {number(
                          t("editor.inspector.field.width"),
                          "width",
                          item.bounds.width,
                          map.width,
                        )}
                        {number(
                          t("editor.inspector.field.height"),
                          "height",
                          item.bounds.height,
                          map.height,
                        )}
                      </>
                    ) : (
                      <>
                        {number(
                          t("editor.inspector.field.x"),
                          "x",
                          item.x,
                          map.width,
                        )}
                        {number(
                          t("editor.inspector.field.y"),
                          "y",
                          item.y,
                          map.height,
                        )}
                      </>
                    )}
                  </div>
                  {"scale" in item && (
                    <label className="editor-field">
                      {t("editor.inspector.field.scale")}
                      <select
                        value={item.scale}
                        onChange={(e) =>
                          property("scale", Number(e.target.value))
                        }
                      >
                        <option value={1}>
                          {t("editor.inspector.scale.small")}
                        </option>
                        <option value={2}>
                          {t("editor.inspector.scale.normal")}
                        </option>
                        <option value={3}>
                          {t("editor.inspector.scale.large")}
                        </option>
                      </select>
                    </label>
                  )}
                </fieldset>
              ) : (
                <p className="editor-tool-tip">
                  {selected.length
                    ? t("editor.properties.selectionHelp")
                    : t("editor.properties.emptyHelp")}
                </p>
              )}
              {selected.length > 0 && (
                <div className="editor-selection-actions">
                  <button
                    disabled={
                      !writable ||
                      selected.some(
                        (selection) => options.lockedLayers[selection.kind],
                      )
                    }
                    onClick={() => {
                      copy();
                      paste();
                    }}
                  >
                    <Copy size={15} /> {t("editor.properties.duplicate")}
                  </button>
                  <button disabled={!writable} onClick={remove}>
                    <Trash2 size={15} /> {t("editor.properties.delete")}
                  </button>
                </div>
              )}
              {selected.length === 1 && primary && map && (
                <div className="editor-layer-order">
                  <div>
                    <strong>{t("editor.properties.orderTitle")}</strong>
                    <span>
                      {primaryItems.findIndex(
                        (item) => item.id === primary.id,
                      ) + 1}
                      /{primaryItems.length}
                    </span>
                  </div>
                  <p>{t("editor.properties.orderHelp")}</p>
                  <div className="editor-order-actions">
                    <button
                      type="button"
                      aria-label={t("editor.properties.orderBack")}
                      title={t("editor.properties.orderBack")}
                      disabled={
                        !writable ||
                        !!options.lockedLayers[primary.kind] ||
                        primaryItems.findIndex(
                          (item) => item.id === primary.id,
                        ) <= 0
                      }
                      onClick={() => reorder("back")}
                    >
                      <ArrowDown size={14} /> {t("editor.properties.orderBack")}
                    </button>
                    <button
                      type="button"
                      aria-label={t("editor.properties.orderForward")}
                      title={t("editor.properties.orderForward")}
                      disabled={
                        !writable ||
                        !!options.lockedLayers[primary.kind] ||
                        primaryItems.findIndex(
                          (item) => item.id === primary.id,
                        ) >=
                          primaryItems.length - 1
                      }
                      onClick={() => reorder("front")}
                    >
                      <ArrowUp size={14} />{" "}
                      {t("editor.properties.orderForward")}
                    </button>
                  </div>
                </div>
              )}
              <details className="editor-items-list">
                <summary>
                  {t("editor.properties.itemList", {
                    count: formatCount(mapEntries.length),
                  })}
                </summary>
                {mapEntries.length ? (
                  <ul>
                    {mapEntries.map((entry) => {
                      const active = selected.some(
                        (item) =>
                          item.kind === entry.selection.kind &&
                          item.id === entry.selection.id,
                      );
                      return (
                        <li key={entry.key}>
                          <button
                            type="button"
                            aria-pressed={active}
                            onClick={(event) => {
                              select([entry.selection]);
                              option("tool", "select");
                              if (event.detail === 0)
                                requestAnimationFrame(() =>
                                  document
                                    .getElementById("map-editor-canvas")
                                    ?.focus(),
                                );
                            }}
                          >
                            {entry.label}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p>{t("editor.properties.itemsEmpty")}</p>
                )}
              </details>
              <div className="editor-map-info">
                <strong>{t("editor.properties.beforePublish")}</strong>
                <p>{t("editor.properties.publishHelp")}</p>
                <span>
                  {t("editor.properties.objectCount", {
                    count: formatCount(map.objects.length),
                    max: "500",
                  })}{" "}
                  ·{" "}
                  {t("editor.properties.zoneCount", {
                    count: formatCount(map.zones.length),
                    max: "32",
                  })}
                </span>
                <span>
                  {t("editor.properties.draftVersion", {
                    version: editor.version,
                  })}
                </span>
              </div>
              {editor.issues.length > 0 && (
                <div className="editor-issues">
                  <strong>{t("editor.properties.issuesTitle")}</strong>
                  <ul>
                    {editor.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </aside>
      </div>
      {actionDialog && (
        <Dialog
          title={
            actionDialog.kind === "prompt"
              ? actionDialog.message
              : t("editor.dialog.confirmTitle")
          }
          close={cancelActionDialog}
          closeLabel={t("editor.dialog.cancel")}
          initialFocusRef={
            actionDialog.kind === "prompt" ? actionDialogInput : undefined
          }
        >
          {actionDialog.kind === "prompt" ? (
            <form
              className="editor-action-dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                const value = actionDialogValue.trim();
                if (value) completeActionDialog(value);
              }}
            >
              <label className="editor-action-dialog-field">
                <span>{t("editor.dialog.nameLabel")}</span>
                <input
                  ref={actionDialogInput}
                  autoComplete="off"
                  autoFocus
                  maxLength={60}
                  required
                  value={actionDialogValue}
                  onChange={(event) => setActionDialogValue(event.target.value)}
                />
              </label>
              <div className="editor-action-dialog-actions">
                <button
                  type="button"
                  className="editor-dialog-secondary"
                  onClick={cancelActionDialog}
                >
                  {t("editor.dialog.cancel")}
                </button>
                <button
                  type="submit"
                  className="editor-dialog-primary"
                  disabled={!actionDialogValue.trim()}
                >
                  {t("editor.dialog.confirm")}
                </button>
              </div>
            </form>
          ) : (
            <div className="editor-action-dialog-form">
              <p>{actionDialog.message}</p>
              <div className="editor-action-dialog-actions">
                <button
                  type="button"
                  className="editor-dialog-secondary"
                  onClick={cancelActionDialog}
                >
                  {t("editor.dialog.cancel")}
                </button>
                <button
                  type="button"
                  className="editor-dialog-primary"
                  onClick={() => completeActionDialog(true)}
                >
                  {t("editor.dialog.confirm")}
                </button>
              </div>
            </div>
          )}
        </Dialog>
      )}
      {revisions && (
        <Dialog
          title={t("editor.history.title")}
          close={() => setRevisions(undefined)}
        >
          <p className="muted">{t("editor.history.help")}</p>
          <div className="editor-history">
            {revisions.map((revision, i) => (
              <div key={revision.id}>
                <span>
                  <strong>{revision.name}</strong>
                  <small>
                    #{revision.sequence} ·{" "}
                    {new Date(revision.createdAt).toLocaleString(locale)} ·{" "}
                    {revision.reason === "INITIAL"
                      ? t("editor.history.reason.initial")
                      : revision.reason === "ROLLBACK"
                        ? t("editor.history.reason.rollback")
                        : t("editor.history.reason.publish")}
                  </small>
                </span>
                <button
                  className="editor-button"
                  disabled={!writable || i === 0}
                  onClick={() => void restoreRevision(revision)}
                >
                  {i === 0
                    ? t("editor.history.current")
                    : t("editor.history.restore")}
                </button>
              </div>
            ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}
