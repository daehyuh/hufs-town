package town.hufs.domain;

import town.hufs.protocol.MapDefinition;
import town.hufs.protocol.Rect;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public final class Movement {
    public static final double RADIUS = .22;
    private static final int MAX_GRID_DIMENSION = 96;
    private static final long MAX_BUCKET_REFERENCES = 200_000;

    public record Position(double x, double y) {}

    private record IndexedRect(Rect rect, int minX, int minY, int maxX, int maxY) {}

    @FunctionalInterface
    private interface StandCheck {
        boolean canStand(double x, double y);
    }

    /**
     * Immutable, map-sized spatial index for the movement hot path. Player
     * coordinates remain continuous; this grid only narrows the collider
     * candidates which can overlap the player's collision circle.
     */
    public static final class CollisionGrid {
        private final double width;
        private final double height;
        private final int columns;
        private final Map<Integer, List<Rect>> collidersByTile;
        private final List<Rect> linearFallback;

        public CollisionGrid(MapDefinition map) {
            Objects.requireNonNull(map, "map");
            if (map.width() < 1 || map.width() > MAX_GRID_DIMENSION
                || map.height() < 1 || map.height() > MAX_GRID_DIMENSION) {
                throw new IllegalArgumentException("Map dimensions are outside the collision-grid limit");
            }
            width = map.width();
            height = map.height();
            columns = Math.toIntExact(map.width());
            int rows = Math.toIntExact(map.height());
            List<Rect> collisions = List.copyOf(Objects.requireNonNull(map.collisions(), "map.collisions"));

            List<IndexedRect> indexed = new ArrayList<>(collisions.size());
            long bucketReferences = 0;
            for (Rect rect : collisions) {
                if (rect == null || !Double.isFinite(rect.x()) || !Double.isFinite(rect.y())
                    || !Double.isFinite(rect.width()) || !Double.isFinite(rect.height())
                    || rect.width() < 0 || rect.height() < 0) {
                    throw new IllegalArgumentException("Map collision rectangle is invalid");
                }
                int minX = tileAt(rect.x() - RADIUS, columns);
                int minY = tileAt(rect.y() - RADIUS, rows);
                int maxX = tileAt(rect.x() + rect.width() + RADIUS, columns);
                int maxY = tileAt(rect.y() + rect.height() + RADIUS, rows);
                long references = (long) (maxX - minX + 1) * (maxY - minY + 1);
                bucketReferences += references;
                if (bucketReferences > MAX_BUCKET_REFERENCES) {
                    collidersByTile = Map.of();
                    linearFallback = collisions;
                    return;
                }
                indexed.add(new IndexedRect(rect, minX, minY, maxX, maxY));
            }

            Map<Integer, List<Rect>> mutableBuckets = new HashMap<>();
            for (IndexedRect entry : indexed) {
                for (int y = entry.minY(); y <= entry.maxY(); y++) {
                    for (int x = entry.minX(); x <= entry.maxX(); x++) {
                        mutableBuckets.computeIfAbsent(y * columns + x, ignored -> new ArrayList<>())
                            .add(entry.rect());
                    }
                }
            }
            Map<Integer, List<Rect>> immutableBuckets = new HashMap<>(mutableBuckets.size());
            mutableBuckets.forEach((key, value) -> immutableBuckets.put(key, List.copyOf(value)));
            collidersByTile = Map.copyOf(immutableBuckets);
            linearFallback = List.of();
        }

        public boolean canStand(double x, double y) {
            if (!insideWorld(width, height, x, y)) return false;
            if (!linearFallback.isEmpty()) return collisionClear(linearFallback, x, y);
            List<Rect> candidates = collidersByTile.get((int) Math.floor(y) * columns + (int) Math.floor(x));
            return candidates == null || collisionClear(candidates, x, y);
        }

        private static int tileAt(double coordinate, int limit) {
            if (coordinate <= 0) return 0;
            if (coordinate >= limit) return limit - 1;
            return (int) Math.floor(coordinate);
        }
    }

    private Movement() {}

    public static Position step(MapDefinition map, double x, double y, double dx, double dy,
                                boolean running, double seconds) {
        Objects.requireNonNull(map, "map");
        return step((px, py) -> canStand(map, px, py), x, y, dx, dy, running, seconds);
    }

    public static Position step(CollisionGrid grid, double x, double y, double dx, double dy,
                                boolean running, double seconds) {
        Objects.requireNonNull(grid, "grid");
        return step(grid::canStand, x, y, dx, dy, running, seconds);
    }

    private static Position step(StandCheck canStand, double x, double y, double dx, double dy,
                                 boolean running, double seconds) {
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) throw new IllegalArgumentException("Invalid direction");
        double length = Math.hypot(dx, dy);
        if (length == 0) return new Position(x, y);
        double distance = (running ? 5 : 3) * Math.clamp(seconds, 0, .05);
        double nx = x + dx / length * distance;
        double ny = y + dy / length * distance;
        // Keep safe diagonal motion continuous around collider corners. Axis
        // first resolution otherwise makes a clear diagonal visibly zigzag.
        if (canStand.canStand(nx, ny)) return new Position(nx, ny);
        if (canStand.canStand(nx, y)) x = nx;
        if (canStand.canStand(x, ny)) y = ny;
        return new Position(x, y);
    }

    public static boolean canStand(MapDefinition map, double x, double y) {
        Objects.requireNonNull(map, "map");
        return insideWorld(map.width(), map.height(), x, y) && collisionClear(map.collisions(), x, y);
    }

    private static boolean insideWorld(double width, double height, double x, double y) {
        return Double.isFinite(x) && Double.isFinite(y)
            && x >= RADIUS && y >= RADIUS
            && x <= width - RADIUS && y <= height - RADIUS;
    }

    private static boolean collisionClear(Iterable<Rect> collisions, double x, double y) {
        for (Rect rect : collisions) {
            double cx = Math.clamp(x, rect.x(), rect.x() + rect.width());
            double cy = Math.clamp(y, rect.y(), rect.y() + rect.height());
            if (Math.hypot(x - cx, y - cy) < RADIUS) return false;
        }
        return true;
    }

    public static String zoneAt(MapDefinition map, double x, double y) {
        for (var zone : map.zones())
            if (inside(zone.bounds(), x, y)) return zone.id();
        return "";
    }

    public static boolean inside(Rect r, double x, double y) {
        return x >= r.x() && x < r.x() + r.width() && y >= r.y() && y < r.y() + r.height();
    }
}
