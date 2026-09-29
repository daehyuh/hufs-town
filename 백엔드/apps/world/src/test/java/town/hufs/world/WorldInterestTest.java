package town.hufs.world;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;

import static org.assertj.core.api.Assertions.assertThat;

class WorldInterestTest {
    @Test void includesTheCurrentAndAdjacentSnapshotCells() {
        assertThat(WorldInterest.visible(8, 8, 8, 8)).isTrue();
        assertThat(WorldInterest.visible(8, 8, 24, 24)).isTrue();
        assertThat(WorldInterest.visible(8, 8, 24, -8)).isTrue();
    }

    @Test void removesPlayersBeyondTheThreeByThreeCellArea() {
        assertThat(WorldInterest.visible(8, 8, 40, 8)).isFalse();
        assertThat(WorldInterest.visible(8, 8, 8, 40)).isFalse();
    }

    @Test void usesFloorCellsForNegativeCoordinates() {
        assertThat(WorldInterest.visible(-0.1, -0.1, 0.1, 0.1)).isTrue();
        assertThat(WorldInterest.visible(-0.1, -0.1, 32.1, 0.1)).isFalse();
    }

    @Test void indexedQueriesMatchTheOriginalVisibilityRuleAndKeepPlayerOrder() {
        var index = new WorldInterest.Index<Integer>();
        var positions = new ArrayList<double[]>();
        for (int player = 0; player < 100; player++) {
            double x = (player % 10) * 19 - 73.25;
            double y = (player / 10) * 21 - 42.5;
            positions.add(new double[]{x, y});
            index.add(x, y, player);
        }

        for (double viewerX = -80; viewerX <= 100; viewerX += 7.5) {
            for (double viewerY = -50; viewerY <= 150; viewerY += 11.25) {
                var expected = new ArrayList<Integer>();
                for (int player = 0; player < positions.size(); player++) {
                    double[] position = positions.get(player);
                    if (WorldInterest.visible(viewerX, viewerY, position[0], position[1])) expected.add(player);
                }
                assertThat(index.visibleTo(viewerX, viewerY)).containsExactlyElementsOf(expected);
            }
        }
    }

    @Test void reusesTheImmutableCandidateListForViewersInTheSameCell() {
        var index = new WorldInterest.Index<String>();
        index.add(1, 1, "first");
        index.add(20, 1, "second");

        var first = index.visibleTo(2, 2);

        assertThat(index.visibleTo(15, 15)).isSameAs(first);
    }
}
