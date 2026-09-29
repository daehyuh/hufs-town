package town.hufs.world;

import org.junit.jupiter.api.Test;
import town.hufs.protocol.MapDefinition;
import town.hufs.protocol.Rect;
import town.hufs.protocol.Zone;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class WorldSpawnTest {
    @Test void admissionSpawnMustBeWalkableAndOutsidePrivateRooms() {
        var map = new MapDefinition(2, "test", "revision", "Test", 20, 20, 2, 2,
            List.of(new Rect(4, 4, 2, 2)), List.of(),
            List.of(new Zone("meeting", "Meeting", "PRIVATE", new Rect(8, 8, 4, 4), 6L)),
            List.of(), List.of(), List.of(), List.of());

        assertThat(WorldHandler.safeAdmissionSpawn(map, 3, 3)).isTrue();
        assertThat(WorldHandler.safeAdmissionSpawn(map, 5, 5)).isFalse();
        assertThat(WorldHandler.safeAdmissionSpawn(map, 9, 9)).isFalse();
    }
}
