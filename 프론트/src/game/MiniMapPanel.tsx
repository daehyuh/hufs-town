import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import type {
  MapDefinition,
  PlayerView,
  RoomView,
} from "../generated/protocol";
import { formatNumber, useLanguage } from "../i18n/language";
import {
  buildNavigationField,
  buildNavigationGraph,
  navigationPathFrom,
} from "./navigation";

const floorColors: Record<string, string> = {
  OAK: "#dfc997",
  WOOD: "#c99c69",
  CARPET_BLUE: "#8daeb4",
  CARPET_SAGE: "#9cac86",
  TILE: "#d8ddd2",
  CONCRETE: "#aeb6ae",
};
const zoneColors = {
  PRIVATE: "#bd9cde",
  SILENT: "#91b9d0",
  PUBLIC: "#a8c58e",
  STAGE: "#e2b84b",
};

export function MiniMapPanel({
  map,
  players,
  selfId,
  selfZoneId,
  rooms,
  onFocus,
}: {
  map: MapDefinition;
  players: PlayerView[];
  selfId: string;
  selfZoneId: string;
  rooms: RoomView[];
  onFocus: (x: number, y: number) => void;
}) {
  const { language, t } = useLanguage();
  const self = players.find((player) => player.id === selfId);
  const currentZone = map.zones.find((zone) => zone.id === selfZoneId);
  const [zoom, setZoom] = useState(1);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const targetZone = map.zones.find((zone) => zone.id === selectedZoneId);
  const targetRoom = rooms.find((room) => room.zoneId === selectedZoneId);
  const needsRoomEntry = Boolean(
    targetZone?.kind === "PRIVATE" &&
    targetRoom &&
    (targetRoom.locked || targetRoom.occupants >= targetRoom.capacity) &&
    selfZoneId !== targetZone.id,
  );
  const blockedZoneKey = rooms
    .filter(
      (room) =>
        (room.locked || room.occupants >= room.capacity) &&
        room.zoneId !== selfZoneId,
    )
    .map((room) => room.zoneId)
    .sort()
    .join("\u0000");
  const navigationGraph = useMemo(
    () =>
      targetZone
        ? buildNavigationGraph(
            map,
            new Set(blockedZoneKey ? blockedZoneKey.split("\u0000") : []),
          )
        : null,
    [blockedZoneKey, map, targetZone],
  );
  const navigationField = useMemo(
    () =>
      targetZone && navigationGraph
        ? buildNavigationField(navigationGraph, targetZone, needsRoomEntry)
        : null,
    [needsRoomEntry, navigationGraph, targetZone],
  );
  const route = useMemo(
    () =>
      self && navigationGraph && navigationField
        ? navigationPathFrom(navigationGraph, navigationField, self.x, self.y)
        : null,
    [navigationField, navigationGraph, self?.x, self?.y],
  );
  const viewBox = useMemo(() => {
    const width = map.width / zoom;
    const height = map.height / zoom;
    const targetX = targetZone
      ? targetZone.bounds.x + targetZone.bounds.width / 2
      : undefined;
    const targetY = targetZone
      ? targetZone.bounds.y + targetZone.bounds.height / 2
      : undefined;
    const centerX =
      zoom === 1
        ? map.width / 2
        : targetX === undefined
          ? (self?.x ?? map.width / 2)
          : ((self?.x ?? targetX) + targetX) / 2;
    const centerY =
      zoom === 1
        ? map.height / 2
        : targetY === undefined
          ? (self?.y ?? map.height / 2)
          : ((self?.y ?? targetY) + targetY) / 2;
    return {
      x: Math.max(0, Math.min(map.width - width, centerX - width / 2)),
      y: Math.max(0, Math.min(map.height - height, centerY - height / 2)),
      width,
      height,
    };
  }, [map.height, map.width, self?.x, self?.y, targetZone, zoom]);
  const routePoints = route?.points
    .map((point) => `${point.x},${point.y}`)
    .join(" ");
  const locate = (clientX: number, clientY: number, element: SVGSVGElement) => {
    const bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    onFocus(
      Math.max(
        0,
        Math.min(
          map.width,
          viewBox.x + ((clientX - bounds.left) / bounds.width) * viewBox.width,
        ),
      ),
      Math.max(
        0,
        Math.min(
          map.height,
          viewBox.y + ((clientY - bounds.top) / bounds.height) * viewBox.height,
        ),
      ),
    );
  };
  const handleMapClick = (event: MouseEvent<SVGSVGElement>) =>
    locate(event.clientX, event.clientY, event.currentTarget);
  const handleMapKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onFocus(self?.x ?? map.width / 2, self?.y ?? map.height / 2);
  };

  return (
    <div className="mini-map-panel">
      <div className="mini-map-current" aria-live="polite">
        <span
          className={`mini-map-zone-dot ${currentZone?.kind.toLowerCase() ?? "public"}`}
        />
        <div>
          <strong>{currentZone?.name ?? t("map.publicSpace")}</strong>
          <small>
            {self
              ? t("map.currentPosition", {
                  x: formatNumber(language, Math.round(self.x * 10) / 10),
                  y: formatNumber(language, Math.round(self.y * 10) / 10),
                })
              : t("map.waitingPosition")}
          </small>
        </div>
      </div>
      <div className="mini-map-toolbar">
        <span>
          {selectedZoneId
            ? t("map.target", {
                name:
                  map.zones.find((zone) => zone.id === selectedZoneId)?.name ??
                  t("map.unknownZone"),
              })
            : t("map.wholeSpace")}
        </span>
        <div className="mini-map-zoom" aria-label={t("map.zoom")}>
          <button
            type="button"
            aria-label={t("map.zoomOut")}
            disabled={zoom <= 1}
            onClick={() => setZoom((value) => Math.max(1, value - 0.5))}
          >
            −
          </button>
          <small>{formatNumber(language, Math.round(zoom * 100))}%</small>
          <button
            type="button"
            aria-label={t("map.zoomIn")}
            disabled={zoom >= 3}
            onClick={() => setZoom((value) => Math.min(3, value + 0.5))}
          >
            +
          </button>
        </div>
      </div>
      <svg
        className="mini-map-canvas"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        preserveAspectRatio="none"
        role="button"
        tabIndex={0}
        aria-label={t("map.canvasLabel")}
        onClick={handleMapClick}
        onKeyDown={handleMapKey}
        style={{ aspectRatio: `${viewBox.width} / ${viewBox.height}` }}
      >
        <rect width={map.width} height={map.height} fill="#e9eee2" />
        {map.floors.map((floor) => (
          <rect
            key={`floor-${floor.id}`}
            x={floor.bounds.x}
            y={floor.bounds.y}
            width={floor.bounds.width}
            height={floor.bounds.height}
            fill={floorColors[floor.material] ?? "#d8ddd2"}
          />
        ))}
        {map.zones.map((zone) => (
          <g key={`zone-${zone.id}`}>
            <rect
              x={zone.bounds.x}
              y={zone.bounds.y}
              width={zone.bounds.width}
              height={zone.bounds.height}
              fill={zoneColors[zone.kind]}
              fillOpacity=".28"
              stroke={zoneColors[zone.kind]}
              strokeWidth=".22"
              strokeDasharray={zone.kind === "PRIVATE" ? ".65 .4" : undefined}
            />
            {zone.id === selectedZoneId && (
              <rect
                x={zone.bounds.x}
                y={zone.bounds.y}
                width={zone.bounds.width}
                height={zone.bounds.height}
                fill="none"
                stroke="#405e37"
                strokeWidth=".45"
              />
            )}
          </g>
        ))}
        {map.objects.map((object) => (
          <rect
            key={`object-${object.id}`}
            x={object.x - 0.22 * object.scale}
            y={object.y - 0.22 * object.scale}
            width={0.44 * object.scale}
            height={0.44 * object.scale}
            rx=".08"
            fill="#687b5a"
            stroke="#f8f7ed"
            strokeWidth=".08"
          />
        ))}
        {map.walls.map((wall) => (
          <rect
            key={`wall-${wall.id}`}
            x={wall.bounds.x}
            y={wall.bounds.y}
            width={wall.bounds.width}
            height={wall.bounds.height}
            fill={
              wall.material === "GLASS"
                ? "#83b7b7"
                : wall.material === "SAGE"
                  ? "#869b70"
                  : "#a79578"
            }
            stroke="#52624c"
            strokeWidth=".1"
          />
        ))}
        {routePoints && route && route.points.length > 1 && (
          <>
            <polyline
              points={routePoints}
              fill="none"
              stroke="#fffaf2"
              strokeWidth=".42"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <polyline
              points={routePoints}
              fill="none"
              stroke="#d96d4f"
              strokeWidth=".2"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray=".38 .24"
            />
            <circle
              cx={route.points.at(-1)!.x}
              cy={route.points.at(-1)!.y}
              r=".42"
              fill="#fffaf2"
              stroke="#d96d4f"
              strokeWidth=".18"
            />
          </>
        )}
        {map.labels.map((label) => (
          <circle
            key={`label-${label.id}`}
            cx={label.x}
            cy={label.y}
            r=".18"
            fill="#607650"
          />
        ))}
        {[...players]
          .sort((a, b) => Number(a.id === selfId) - Number(b.id === selfId))
          .map((player) => (
            <g key={`player-${player.id}`}>
              {player.id === selfId && (
                <circle
                  cx={player.x}
                  cy={player.y}
                  r=".65"
                  fill="#fff"
                  fillOpacity=".85"
                />
              )}
              <circle
                cx={player.x}
                cy={player.y}
                r={player.id === selfId ? ".4" : ".27"}
                fill={player.id === selfId ? "#527c44" : "#4c86a0"}
                stroke="#fff"
                strokeWidth=".12"
              >
                <title>
                  {player.id === selfId ? t("map.you") : player.name}
                </title>
              </circle>
            </g>
          ))}
      </svg>
      <p className="mini-map-hint">{t("map.hint")}</p>
      {selectedZoneId && (
        <p className="mini-map-route" aria-live="polite">
          {!targetZone
            ? t("map.route.missingZone")
            : selfZoneId === targetZone.id
              ? t("map.route.alreadyThere", { name: targetZone.name })
              : !route
                ? t("map.route.notFound", { name: targetZone.name })
                : t(
                    needsRoomEntry
                      ? "map.route.toRoomBoundary"
                      : "map.route.toZone",
                    {
                      name: targetZone.name,
                      distance: formatNumber(
                        language,
                        Math.max(1, Math.ceil(route.distance)),
                      ),
                    },
                  )}
        </p>
      )}
      <div className="mini-map-legend" aria-label={t("map.legend")}>
        <span>
          <i className="private" />
          {t("map.legend.meetingRoom")}
        </span>
        <span>
          <i className="silent" />
          {t("map.legend.quietArea")}
        </span>
        <span>
          <i className="stage" />
          {t("map.legend.stage")}
        </span>
        <span>
          <i className="public" />
          {t("map.legend.public")}
        </span>
      </div>
      <ul className="mini-map-zones" aria-label={t("map.zones")}>
        {map.zones.map((zone) => {
          const room = rooms.find((item) => item.zoneId === zone.id);
          const occupants = players.filter(
            (player) => player.zoneId === zone.id,
          ).length;
          return (
            <li key={`zone-info-${zone.id}`}>
              <button
                type="button"
                className={zone.id === selectedZoneId ? "selected" : ""}
                aria-pressed={zone.id === selectedZoneId}
                onClick={() => {
                  const nextZoneId =
                    selectedZoneId === zone.id ? null : zone.id;
                  setSelectedZoneId(nextZoneId);
                  if (nextZoneId)
                    onFocus(
                      zone.bounds.x + zone.bounds.width / 2,
                      zone.bounds.y + zone.bounds.height / 2,
                    );
                }}
              >
                <span
                  className={`mini-map-zone-dot ${zone.kind.toLowerCase()}`}
                />
                <strong>{zone.name}</strong>
                <small>
                  {room
                    ? `${t("map.roomOccupants", {
                        occupants: formatNumber(language, room.occupants),
                        capacity: formatNumber(language, room.capacity),
                      })}${room.locked ? t("map.locked") : ""}`
                    : t("map.occupants", {
                        count: formatNumber(language, occupants),
                      })}
                </small>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
