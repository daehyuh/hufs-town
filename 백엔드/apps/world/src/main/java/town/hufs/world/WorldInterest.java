package town.hufs.world;

import java.util.ArrayList;
import java.util.BitSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Grid-based area of interest for world snapshots, recalculated at the snapshot cadence. */
final class WorldInterest {
    static final int CELL_SIZE_TILES = 16;
    private static final int VISIBLE_CELL_RADIUS = 1;

    private WorldInterest() {}

    static boolean visible(double viewerX, double viewerY, double playerX, double playerY) {
        return Math.abs((long)cell(viewerX) - cell(playerX)) <= VISIBLE_CELL_RADIUS
            && Math.abs((long)cell(viewerY) - cell(playerY)) <= VISIBLE_CELL_RADIUS;
    }

    /**
     * Indexes an immutable tick's player views so each viewer examines only players in the
     * surrounding 3x3 cells. Results are memoized by viewer cell, which also lets snapshot
     * encoding reuse the same player array for viewers with the same interest area.
     */
    static final class Index<T> {
        private final List<T> values = new ArrayList<>();
        private final Map<Long, List<Integer>> byCell = new HashMap<>();
        private final Map<Long, List<T>> visibleByViewerCell = new HashMap<>();

        void add(double x, double y, T value) {
            int index = values.size();
            values.add(value);
            byCell.computeIfAbsent(key(cell(x), cell(y)), ignored -> new ArrayList<>()).add(index);
        }

        List<T> visibleTo(double x, double y) {
            int viewerCellX = cell(x), viewerCellY = cell(y);
            return visibleByViewerCell.computeIfAbsent(key(viewerCellX, viewerCellY), ignored -> {
                var matches = new BitSet(values.size());
                for (int cellY = -VISIBLE_CELL_RADIUS; cellY <= VISIBLE_CELL_RADIUS; cellY++) {
                    for (int cellX = -VISIBLE_CELL_RADIUS; cellX <= VISIBLE_CELL_RADIUS; cellX++) {
                        long candidateX = (long)viewerCellX + cellX;
                        long candidateY = (long)viewerCellY + cellY;
                        if (candidateX < Integer.MIN_VALUE || candidateX > Integer.MAX_VALUE
                            || candidateY < Integer.MIN_VALUE || candidateY > Integer.MAX_VALUE) continue;
                        List<Integer> indices = byCell.get(key((int)candidateX, (int)candidateY));
                        if (indices != null) indices.forEach(matches::set);
                    }
                }
                var result = new ArrayList<T>(matches.cardinality());
                for (int index = matches.nextSetBit(0); index >= 0; index = matches.nextSetBit(index + 1))
                    result.add(values.get(index));
                return List.copyOf(result);
            });
        }
    }

    private static int cell(double coordinate) { return (int)Math.floor(coordinate / CELL_SIZE_TILES); }
    private static long key(int x, int y) { return ((long)x << 32) | (y & 0xffff_ffffL); }
}
