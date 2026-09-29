package town.hufs.world;

import jakarta.annotation.PreDestroy;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class SpaceAccessStore {
    record Key(String userId, String spaceId) {}
    record Access(boolean ok, boolean allowed, boolean manager) {}
    record Batch(boolean ok, Map<Key, Access> access) {}

    private final JdbcTemplate db;
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(512), task -> {
            Thread thread = new Thread(task, "town-space-access-storage");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());

    SpaceAccessStore(JdbcTemplate db) { this.db = db; }

    boolean load(Key key, Consumer<Access> completed) {
        return loadMany(Set.of(key), result -> completed.accept(result.access().getOrDefault(key, new Access(false, false, false))));
    }

    boolean loadMany(Collection<Key> requestedKeys, Consumer<Batch> completed) {
        Set<Key> keys = Set.copyOf(requestedKeys);
        if (keys.isEmpty()) {
            completed.accept(new Batch(true, Map.of()));
            return true;
        }
        try {
            worker.execute(() -> {
                try {
                    String requested = String.join(" UNION ALL ", Collections.nCopies(keys.size(),
                        "SELECT ? AS user_id, ? AS space_id"));
                    List<Object> parameters = new ArrayList<>(keys.size() * 2);
                    for (Key key : keys) {
                        parameters.add(key.userId());
                        parameters.add(key.spaceId());
                    }
                    List<Map<String, Object>> rows = db.queryForList("""
                        SELECT requested.user_id,requested.space_id,member.role AS member_role,member.manager AS member_manager,
                            blocked.user_id AS blocked_user_id,active_space.id AS active_space_id
                        FROM (%s) requested
                        LEFT JOIN town_space active_space
                          ON active_space.id=requested.space_id AND active_space.archived_at IS NULL
                        LEFT JOIN space_member member
                          ON member.space_id=requested.space_id AND member.user_id=requested.user_id
                        LEFT JOIN space_access_block blocked
                          ON blocked.space_id=requested.space_id AND blocked.user_id=requested.user_id
                        """.formatted(requested), parameters.toArray());
                    Map<Key, Access> values = new HashMap<>();
                    for (Map<String, Object> row : rows) {
                        Key key = new Key((String) row.get("user_id"), (String) row.get("space_id"));
                        values.put(key, new Access(true, row.get("active_space_id") != null
                            && row.get("member_role") != null && row.get("blocked_user_id") == null,
                            Boolean.TRUE.equals(row.get("member_manager")) || "OWNER".equals(row.get("member_role"))));
                    }
                    for (Key key : keys) values.putIfAbsent(key, new Access(false, false, false));
                    completed.accept(new Batch(true, Map.copyOf(values)));
                } catch (RuntimeException failure) {
                    LoggerFactory.getLogger(getClass()).warn("Space access load failed: {}", failure.getClass().getSimpleName());
                    completed.accept(new Batch(false, Map.of()));
                }
            });
            return true;
        } catch (RejectedExecutionException full) {
            return false;
        }
    }

    @PreDestroy
    void shutdown() {
        worker.shutdown();
        try {
            if (!worker.awaitTermination(2, TimeUnit.SECONDS)) worker.shutdownNow();
        } catch (InterruptedException interrupted) {
            worker.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}
