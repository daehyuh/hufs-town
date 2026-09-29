package town.hufs.world;

import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import town.hufs.auth.PublishedMaps;
import town.hufs.protocol.MapDefinition;
import town.hufs.protocol.MapInteraction;
import town.hufs.protocol.MapObject;
import town.hufs.protocol.Rect;
import town.hufs.protocol.Zone;

import static org.assertj.core.api.Assertions.assertThat;

class ScavengerObjectCountsCacheTest {
    @Test
    void countsOnlyPublicAndStageObjectsAndRecomputesForANewPublishedMapVersion() {
        var cache = new ScavengerObjectCountsCache();
        var roomId = "space-1|map-1";
        var original = new PublishedMaps.Published(1, map("revision-1", List.of(
            object("public-item", "SCAVENGER_ITEM", 2, 2),
            object("stage-item", "SCAVENGER_ITEM", 12, 2),
            object("private-item", "SCAVENGER_ITEM", 22, 2),
            object("unzoned-item", "SCAVENGER_ITEM", 2, 22),
            object("public-npc", "NPC", 3, 3),
            object("stage-npc", "NPC", 13, 3),
            object("private-npc", "NPC", 23, 3),
            object("unzoned-npc", "NPC", 3, 22))));

        var counts = cache.forMap(roomId, original);
        assertThat(counts.availableItems()).isEqualTo(2);
        assertThat(counts.availableNpcs()).isEqualTo(2);
        assertThat(cache.forMap(roomId, original)).isSameAs(counts);

        var revised = new PublishedMaps.Published(2, map("revision-2",
            List.of(object("replacement-item", "SCAVENGER_ITEM", 4, 4))));
        var revisedCounts = cache.forMap(roomId, revised);

        assertThat(revisedCounts.availableItems()).isEqualTo(1);
        assertThat(revisedCounts.availableNpcs()).isZero();
        assertThat(revisedCounts).isNotSameAs(counts);
    }

    @Test
    void dropsCountsForRoomsThatNoLongerHaveParticipants() {
        var cache = new ScavengerObjectCountsCache();
        var published = new PublishedMaps.Published(1, map("revision-1",
            List.of(object("item", "SCAVENGER_ITEM", 2, 2))));
        var first = cache.forMap("space-1|map-1", published);
        cache.forMap("space-2|map-2", published);

        cache.retainRooms(Set.of("space-2|map-2"));

        var retained = cache.forMap("space-2|map-2", published);
        var reloaded = cache.forMap("space-1|map-1", published);
        assertThat(retained).isNotNull();
        assertThat(reloaded).isNotSameAs(first);
    }

    private MapDefinition map(String revision, List<MapObject> objects) {
        return new MapDefinition(2, "map-1", revision, "test", 30, 30, 5, 5,
            List.of(), objects, List.of(
                new Zone("public", "public", "PUBLIC", new Rect(0, 0, 10, 10), null),
                new Zone("stage", "stage", "STAGE", new Rect(10, 0, 10, 10), null),
                new Zone("private", "private", "PRIVATE", new Rect(20, 0, 10, 10), 12L)),
            List.of(), List.of(), List.of(), List.of());
    }

    private MapObject object(String id, String kind, double x, double y) {
        return new MapObject(id, "desk-monitor", x, y, 1, "down",
            new MapInteraction(kind, id, "body", null, null, 0, 0));
    }
}
