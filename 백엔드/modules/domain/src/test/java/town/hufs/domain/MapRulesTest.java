package town.hufs.domain;

import org.junit.jupiter.api.Test;
import town.hufs.protocol.*;
import java.util.*;
import static org.assertj.core.api.Assertions.*;

class MapRulesTest {
    MapDefinition map(List<Wall> walls, List<MapObject> objects, List<Zone> zones) {
        return new MapDefinition(2,"client-id","client-revision","Office",20,20,3,3,
            List.of(new Rect(0,0,20,20)),objects,zones,
            List.of(new FloorPatch("floor","OAK",new Rect(0,0,20,20))),walls,List.of(),List.of());
    }

    @Test void collisionsComeFromCatalogAndWallsAndIdentityComesFromServer() {
        var m = MapRules.normalize(map(List.of(new Wall("wall","GLASS",new Rect(9,0,.5,10))),
            List.of(new MapObject("desk","desk-monitor",6,7,2,null,null)),List.of()),"space","revision");
        assertThat(m.id()).isEqualTo("space");
        assertThat(m.revision()).isEqualTo("revision");
        assertThat(m.collisions()).hasSize(2);
        assertThat(Movement.canStand(m,3,3)).isTrue();
        assertThat(Movement.canStand(m,9.2,5)).isFalse();
    }

    @Test void rotatedFurnitureKeepsItsRenderedBoundsAndCollisionFootprintInSync() {
        var rotated = MapRules.normalize(map(List.of(),
            List.of(new MapObject("board", "whiteboard", 8, 8, 2, "right", null)), List.of()), "s", "r");
        var board = rotated.objects().getFirst();
        assertThat(board.direction()).isEqualTo("right");
        var collision = rotated.collisions().getFirst();
        assertThat(collision.x()).isCloseTo(6.5, within(0.000001));
        assertThat(collision.y()).isCloseTo(4.625, within(0.000001));
        assertThat(collision.width()).isCloseTo(0.4, within(0.000001));
        assertThat(collision.height()).isCloseTo(3.75, within(0.000001));

        var legacy = MapRules.normalize(map(List.of(),
            List.of(new MapObject("desk", "desk-monitor", 6, 7, 2, null, null)), List.of()), "s", "r");
        assertThat(legacy.objects().getFirst().direction()).isEqualTo("down");
        assertThatThrownBy(() -> MapRules.normalize(map(List.of(),
            List.of(new MapObject("bad", "desk-monitor", 6, 7, 2, "diagonal", null)), List.of()), "s", "r"))
            .isInstanceOf(MapRules.Invalid.class);
        assertThatThrownBy(() -> MapRules.normalize(map(List.of(),
            List.of(new MapObject("edge", "plant-small", .7, 2, 2, "right", null)), List.of()), "s", "r"))
            .isInstanceOf(MapRules.Invalid.class);
    }

    @Test void invalidAssetsAndDuplicateIdsAndOverlappingZonesAreRejected() {
        assertThatThrownBy(() -> MapRules.normalize(map(List.of(),
            List.of(new MapObject("unknown","not-in-catalog",6,7,2,null,null)),List.of()),"s","r"))
            .isInstanceOf(MapRules.Invalid.class);
        assertThatThrownBy(() -> MapRules.normalize(map(List.of(new Wall("floor","CREAM",new Rect(4,4,1,1))),
            List.of(),List.of()),"s","r")).isInstanceOf(MapRules.Invalid.class);
        assertThatThrownBy(() -> MapRules.normalize(map(List.of(),List.of(),List.of(
            new Zone("a","A","PRIVATE",new Rect(1,1,5,5),null),
            new Zone("b","B","PRIVATE",new Rect(4,4,5,5),null))),"s","r"))
            .isInstanceOf(MapRules.Invalid.class);
    }

    @Test void blockedSpawnAndSealedMeetingRoomCanBeDraftedButNotPublished() {
        var spawn = MapRules.normalize(map(List.of(new Wall("wall","CREAM",new Rect(2,2,2,2))),
            List.of(),List.of()),"s","r");
        assertThat(MapRules.issues(spawn)).anyMatch(s -> s.contains("시작 위치"));
        var separated = MapRules.normalize(map(List.of(new Wall("wall","CREAM",new Rect(9,0,1,20))),
            List.of(),List.of(new Zone("room","Meeting","PRIVATE",new Rect(12,2,5,5),null))),"s","r");
        assertThat(MapRules.issues(separated)).anyMatch(s -> s.contains("Meeting"));
        var door = MapRules.normalize(map(List.of(new Wall("wall","CREAM",new Rect(9,0,1,10))),
            List.of(),List.of(new Zone("room","Meeting","PRIVATE",new Rect(12,2,5,5),null))),"s","r");
        assertThat(MapRules.issues(door)).isEmpty();
        var rounded = MapRules.normalize(map(List.of(new Wall("wall","CREAM",new Rect(3.25,0,.5,20))),
            List.of(),List.of(new Zone("room","Blocked","PRIVATE",new Rect(3.2,3.2,.15,.15),null))),"s","r");
        assertThat(Movement.canStand(rounded,3,3)).isTrue();
        assertThat(MapRules.issues(rounded)).anyMatch(s -> s.contains("Blocked"));
    }

    @Test void furnitureCannotExtendBeyondMapEvenWhenItsFootprintFits() {
        assertThatThrownBy(() -> MapRules.normalize(map(List.of(),
            List.of(new MapObject("shelf","bookshelf",1,1,3,null,null)),List.of()),"s","r"))
            .isInstanceOf(MapRules.Invalid.class);
    }

    @Test void privateZoneCapacityDefaultsForLegacyMapsAndIsValidated() {
        var legacy = MapRules.normalize(map(List.of(),List.of(),List.of(
            new Zone("room","Meeting","PRIVATE",new Rect(2,2,5,5),null))),"s","r");
        assertThat(legacy.zones().getFirst().capacity()).isEqualTo(12);
        var configured = MapRules.normalize(map(List.of(),List.of(),List.of(
            new Zone("room","Meeting","PRIVATE",new Rect(2,2,5,5),8L))),"s","r");
        assertThat(configured.zones().getFirst().capacity()).isEqualTo(8);
        for (long capacity : new long[] {0, 1, 101}) {
            assertThatThrownBy(() -> MapRules.normalize(map(List.of(),List.of(),List.of(
                new Zone("room","Meeting","PRIVATE",new Rect(2,2,5,5),capacity))),"s","r"))
                .isInstanceOf(MapRules.Invalid.class);
        }
    }

    @Test void stageZonesAreAcceptedOnlyAtUsableSizeAndWithoutRoomCapacity() {
        var stage = MapRules.normalize(map(List.of(),List.of(),List.of(
            new Zone("stage","발표 무대","STAGE",new Rect(2,2,4,3),null))),"s","r");
        assertThat(stage.zones().getFirst().kind()).isEqualTo("STAGE");
        assertThat(stage.zones().getFirst().capacity()).isNull();
        assertThatThrownBy(() -> MapRules.normalize(map(List.of(),List.of(),List.of(
            new Zone("stage","발표 무대","STAGE",new Rect(2,2,2.5,3),null))),"s","r"))
            .isInstanceOf(MapRules.Invalid.class);
        assertThatThrownBy(() -> MapRules.normalize(map(List.of(),List.of(),List.of(
            new Zone("stage","발표 무대","STAGE",new Rect(2,2,4,3),12L))),"s","r"))
            .isInstanceOf(MapRules.Invalid.class);
    }

    @Test void objectInteractionsAllowSafeLinksAndBoundedAmbientAudioOnly() {
        var link = new MapInteraction("LINK", "외부 안내", null, "https://example.test/info", null, 0, 0);
        var linked = MapRules.normalize(map(List.of(), List.of(new MapObject("link", "desk-monitor", 6, 7, 2, "down", link)), List.of()), "s", "r");
        assertThat(linked.objects().getFirst().interaction()).isEqualTo(link);

        var sound = new MapInteraction("SOUND", "라운지 음악", null, "https://cdn.example.test/lounge.ogg", null, 20, 100);
        var withSound = MapRules.normalize(map(List.of(), List.of(new MapObject("sound", "desk-monitor", 6, 7, 2, "down", sound)), List.of()), "s", "r");
        assertThat(withSound.objects().getFirst().interaction()).isEqualTo(sound);

        var unsafeLink = new MapInteraction("LINK", "외부 안내", null, "javascript:alert(1)", null, 0, 0);
        assertThatThrownBy(() -> MapRules.normalize(map(List.of(), List.of(new MapObject("link", "desk-monitor", 6, 7, 2, "down", unsafeLink)), List.of()), "s", "r"))
            .isInstanceOf(MapRules.Invalid.class);
        var insecureSound = new MapInteraction("SOUND", "라운지 음악", null, "http://cdn.example.test/lounge.ogg", null, 6, 50);
        assertThatThrownBy(() -> MapRules.normalize(map(List.of(), List.of(new MapObject("sound", "desk-monitor", 6, 7, 2, "down", insecureSound)), List.of()), "s", "r"))
            .isInstanceOf(MapRules.Invalid.class);
        var oversizedRadius = new MapInteraction("SOUND", "라운지 음악", null, "https://cdn.example.test/lounge.ogg", null, 21, 50);
        assertThatThrownBy(() -> MapRules.normalize(map(List.of(), List.of(new MapObject("sound", "desk-monitor", 6, 7, 2, "down", oversizedRadius)), List.of()), "s", "r"))
            .isInstanceOf(MapRules.Invalid.class);
    }

    @Test void scavengerItemCluesAllow280CharactersAndRejectLongerText() {
        String clue = "단".repeat(280);
        var validInteraction = new MapInteraction("SCAVENGER_ITEM", "캠퍼스 표식", clue,
            null, null, 0, 0);
        var valid = MapRules.normalize(map(List.of(), List.of(
            new MapObject("stamp", "desk-monitor", 6, 7, 2, "down", validInteraction)), List.of()), "s", "r");
        assertThat(valid.objects().getFirst().interaction().body()).isEqualTo(clue);

        var oversizedInteraction = new MapInteraction("SCAVENGER_ITEM", "캠퍼스 표식", clue + "단",
            null, null, 0, 0);
        assertThatThrownBy(() -> MapRules.normalize(map(List.of(), List.of(
            new MapObject("stamp", "desk-monitor", 6, 7, 2, "down", oversizedInteraction)), List.of()), "s", "r"))
            .isInstanceOf(MapRules.Invalid.class);
    }
}
