package town.hufs.domain;
import org.junit.jupiter.api.Test;
import town.hufs.protocol.*;
import java.util.List;
import static org.assertj.core.api.Assertions.*;
class MovementTest {
    final MapDefinition map = new MapDefinition(2, "test", "1", "test", 30, 30, 3, 3, List.of(new Rect(5, 0, 1, 30)), List.of(), List.of(), List.of(), List.of(), List.of(), List.of());
    @Test void normalizesDiagonalSpeedAndCapsElapsedTime() {
        var straight = Movement.step(map, 2, 2, 1, 0, false, .05);
        var diagonal = Movement.step(map, 2, 2, 1, 1, false, .05);
        assertThat(Math.hypot(diagonal.x()-2, diagonal.y()-2)).isCloseTo(straight.x()-2, within(.00001));
        assertThat(Movement.step(map, 2, 2, 1, 0, false, 50).x()).isEqualTo(straight.x());
    }
    @Test void preservesShallowFractionalMovementDirection() {
        var moved = Movement.step(map, 2, 2, 0.97, 0.24, false, .05);
        assertThat((moved.y() - 2) / (moved.x() - 2)).isCloseTo(0.24 / 0.97, within(.00001));
    }
    @Test void preservesSafeDiagonalMovementAroundColliderCorners() {
        var corner = new MapDefinition(2, "corner", "1", "corner", 10, 10, 4, 4,
            List.of(new Rect(5, 5, 1, 1)), List.of(), List.of(), List.of(), List.of(), List.of(), List.of());

        var moved = Movement.step(corner, 4.8, 4.8, 1, -1, false, .05);

        assertThat(moved.x()).isGreaterThan(4.8);
        assertThat(moved.y()).isLessThan(4.8);
        assertThat((moved.y() - 4.8) / (moved.x() - 4.8)).isCloseTo(-1, within(.00001));
    }
    @Test void runningCannotCrossWallAndCanSlideAlongIt() {
        double x = 4.7, y = 2;
        for (int i = 0; i < 100; i++) { var p = Movement.step(map, x, y, 1, 1, true, .05); x = p.x(); y = p.y(); }
        assertThat(x).isLessThan(5 - Movement.RADIUS);
        assertThat(y).isGreaterThan(10);
    }
    @Test void pointsOutsideCollisionRadiusRemainWalkableButInteriorDoesNot() {
        var wall = new MapDefinition(2, "wall", "1", "wall", 10, 10, 1, 1,
            List.of(new Rect(5, 2, 1, 6)), List.of(), List.of(), List.of(), List.of(), List.of(), List.of());
        assertThat(Movement.canStand(wall, 5 - Movement.RADIUS - 0.000001, 5)).isTrue();
        assertThat(Movement.canStand(wall, 5 - Movement.RADIUS + 0.000001, 5)).isFalse();
    }
    @Test void collisionGridMatchesContinuousCollisionAtFractionalCoordinates() {
        var map = new MapDefinition(2, "fractional", "1", "fractional", 16, 16, 2, 2,
            List.of(new Rect(4.13, 2.17, .63, 6.25), new Rect(9.4, 8.35, 2.15, 1.7),
                new Rect(0, 0, .5, .5)), List.of(), List.of(), List.of(), List.of(), List.of(), List.of());
        var grid = new Movement.CollisionGrid(map);

        for (double y = .11; y < map.height(); y += .137) {
            for (double x = .07; x < map.width(); x += .119) {
                assertThat(grid.canStand(x, y)).isEqualTo(Movement.canStand(map, x, y));
            }
        }

        var plain = new Movement.Position(4.7, 2);
        var indexed = plain;
        for (int i = 0; i < 100; i++) {
            plain = Movement.step(map, plain.x(), plain.y(), 1, 1, true, .05);
            indexed = Movement.step(grid, indexed.x(), indexed.y(), 1, 1, true, .05);
            assertThat(indexed).isEqualTo(plain);
        }
    }
    @Test void collisionGridFallsBackToLinearScanWhenMapsHaveHugeColliderCoverage() {
        var broadWalls = java.util.stream.IntStream.range(0, 35)
            .mapToObj(ignored -> new Rect(0, 0, 60, 96)).toList();
        var map = new MapDefinition(2, "broad-walls", "1", "broad-walls", 96, 96, 70, 70,
            broadWalls, List.of(), List.of(), List.of(), List.of(), List.of(), List.of());
        var grid = new Movement.CollisionGrid(map);

        for (double x : new double[] {.3, 50, 60.1, 61, 70, 95.7}) {
            for (double y : new double[] {.3, 30.4, 70, 95.7}) {
                assertThat(grid.canStand(x, y)).isEqualTo(Movement.canStand(map, x, y));
            }
        }
    }
    @Test void sampleSpawnAndZonesAreValid() {
        var campus = MapLoader.campus();
        assertThat(Movement.canStand(campus, campus.spawnX(), campus.spawnY())).isTrue();
        assertThat(Movement.zoneAt(campus, 6, 7)).isEqualTo("meeting-a");
        assertThat(Movement.zoneAt(campus, 20, 22)).isEmpty();
        assertThat(MapRules.issues(MapRules.normalize(campus,"office","test"))).isEmpty();
    }
    @Test void overlappingZoneLookupKeepsDefinitionOrder() {
        var overlapping = new MapDefinition(2, "overlap", "1", "overlap", 30, 30, 3, 3,
            List.of(), List.of(), List.of(
                new Zone("first", "첫 구역", "PUBLIC", new Rect(2, 2, 4, 4), null),
                new Zone("second", "두 번째 구역", "PRIVATE", new Rect(3, 3, 4, 4), 12L)),
            List.of(), List.of(), List.of(), List.of());
        assertThat(Movement.zoneAt(overlapping, 3.5, 3.5)).isEqualTo("first");
    }
}
