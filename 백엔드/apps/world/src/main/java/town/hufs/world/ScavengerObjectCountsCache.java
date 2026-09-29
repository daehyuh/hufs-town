package town.hufs.world;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import town.hufs.domain.Movement;
import town.hufs.auth.PublishedMaps;
import town.hufs.protocol.MapDefinition;
import town.hufs.protocol.MapObject;

/** Actor-owned cache for the immutable map counts shown in manager engagement state. */
final class ScavengerObjectCountsCache {
    private final Map<String, CachedCounts> byRoom = new HashMap<>();

    Counts forMap(String worldRoomId, PublishedMaps.Published published) {
        MapDefinition map = published.map();
        CachedCounts cached = byRoom.get(worldRoomId);
        if (cached != null && cached.sequence == published.sequence()
            && cached.revision.equals(map.revision())) return cached.counts;

        Counts counts = new Counts(
            Math.min(100, scavengerObjects(map, "SCAVENGER_ITEM").size()),
            Math.min(100, scavengerObjects(map, "NPC").size()));
        byRoom.put(worldRoomId, new CachedCounts(published.sequence(), map.revision(), counts));
        return counts;
    }

    void retainRooms(Set<String> activeRoomIds) {
        byRoom.keySet().removeIf(roomId -> !activeRoomIds.contains(roomId));
    }

    static List<MapObject> scavengerObjects(MapDefinition map, String kind) {
        if (map.objects() == null) return List.of();
        return map.objects().stream().filter(item -> item.interaction() != null
            && kind.equals(item.interaction().kind()) && isInScavengerZone(map, item)).toList();
    }

    private static boolean isInScavengerZone(MapDefinition map, MapObject item) {
        if (map.zones() == null || map.zones().isEmpty()) return false;
        String zoneId = Movement.zoneAt(map, item.x(), item.y());
        return map.zones().stream().anyMatch(zone -> zone.id().equals(zoneId)
            && ("PUBLIC".equals(zone.kind()) || "STAGE".equals(zone.kind())));
    }

    record Counts(int availableItems, int availableNpcs) {}

    private record CachedCounts(long sequence, String revision, Counts counts) {}
}
