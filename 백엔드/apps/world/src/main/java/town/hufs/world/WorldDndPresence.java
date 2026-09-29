package town.hufs.world;

import jakarta.annotation.PreDestroy;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Publishes short-lived DND markers and privacy-approved online presence across World nodes. */
@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class WorldDndPresence {
    static final String KEY_PREFIX = "hufs-town:presence:dnd:";
    static final String SHARED_KEY_PREFIX = "hufs-town:presence:shared:";
    private static final String SHARED_ONLINE_PREFERENCE = "share_presence_with_friends";
    private static final Duration KEY_TTL = Duration.ofSeconds(30);
    private static final long PRESENCE_WINDOW_MILLIS = 10_000;
    private static final DefaultRedisScript<Long> PUBLISH_SHARED = new DefaultRedisScript<>(
        "local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000); " +
            "redis.call('ZADD',KEYS[1],now+tonumber(ARGV[1]),ARGV[2]); " +
            "redis.call('PEXPIRE',KEYS[1],ARGV[3]); return 1", Long.class);

    record Entry(String userId, String playerId, String status) {}

    private final JdbcTemplate db;
    private final StringRedisTemplate redis;
    private final AtomicReference<List<Entry>> desired = new AtomicReference<>(List.of());
    private final ScheduledExecutorService refresher = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "town-dnd-presence-publisher");
        thread.setDaemon(true);
        return thread;
    });
    private volatile Set<Entry> publishedDnd = Set.of();
    private volatile Set<Entry> publishedShared = Set.of();

    WorldDndPresence(JdbcTemplate db, StringRedisTemplate redis) {
        this.db = db;
        this.redis = redis;
        refresher.scheduleWithFixedDelay(this::refreshSafely, 0, 2, TimeUnit.SECONDS);
    }

    void replace(Collection<Entry> entries) {
        desired.set(entries == null ? List.of() : entries.stream().distinct()
            .sorted((left, right) -> {
                int user = left.userId().compareTo(right.userId());
                if (user != 0) return user;
                int player = left.playerId().compareTo(right.playerId());
                return player != 0 ? player : left.status().compareTo(right.status());
            }).toList());
    }

    void remove(String userId, String playerId) {
        desired.updateAndGet(entries -> entries.stream()
            .filter(entry -> !entry.userId().equals(userId) || !entry.playerId().equals(playerId))
            .toList());
    }

    private void refreshSafely() {
        try {
            Set<Entry> current = new HashSet<>(desired.get());
            Set<Entry> dnd = current.stream().filter(entry -> "DND".equals(entry.status()))
                .collect(java.util.stream.Collectors.toSet());
            publishDnd(dnd);
            publishedDnd = Set.copyOf(dnd);

            Set<Entry> shared = sharedEntries(current);
            publishShared(shared);
            publishedShared = Set.copyOf(shared);
        } catch (RuntimeException unavailable) {
            LoggerFactory.getLogger(getClass()).warn("Account presence refresh failed: {}",
                unavailable.getClass().getSimpleName());
        }
    }

    private Set<Entry> sharedEntries(Set<Entry> current) {
        List<String> users = current.stream().map(Entry::userId).distinct().sorted().toList();
        if (users.isEmpty()) return Set.of();
        String placeholders = String.join(",", java.util.Collections.nCopies(users.size(), "?"));
        List<String> sharingUsers = db.queryForList("""
            SELECT user_id FROM user_social_preference
            WHERE share_presence_with_friends=TRUE AND user_id IN (%s)
            """.formatted(placeholders), String.class, users.toArray());
        Set<String> sharing = Set.copyOf(sharingUsers);
        return current.stream().filter(entry -> sharing.contains(entry.userId()))
            .collect(java.util.stream.Collectors.toSet());
    }

    private void publishDnd(Set<Entry> current) {
        Set<Entry> previous = publishedDnd;
        removeStale(KEY_PREFIX, previous, current);
        long expiresAt = System.currentTimeMillis() + PRESENCE_WINDOW_MILLIS;
        Set<String> touchedUsers = new HashSet<>();
        for (Entry entry : current) {
            String key = KEY_PREFIX + entry.userId();
            redis.opsForZSet().add(key, entry.playerId(), expiresAt);
            touchedUsers.add(key);
        }
        for (String key : touchedUsers) redis.expire(key, KEY_TTL);
    }

    private void publishShared(Set<Entry> current) {
        removeStale(SHARED_KEY_PREFIX, publishedShared, current);
        for (Entry entry : current) {
            redis.execute(PUBLISH_SHARED, List.of(SHARED_KEY_PREFIX + entry.userId()),
                Long.toString(PRESENCE_WINDOW_MILLIS), entry.playerId(), Long.toString(KEY_TTL.toMillis()));
        }
    }

    private void removeStale(String keyPrefix, Set<Entry> previous, Set<Entry> current) {
        for (Entry stale : previous) {
            if (!current.contains(stale)) redis.opsForZSet().remove(keyPrefix + stale.userId(), stale.playerId());
        }
    }

    @PreDestroy
    void shutdown() {
        refresher.shutdownNow();
        for (Entry entry : publishedDnd) removePresence(KEY_PREFIX, entry);
        for (Entry entry : publishedShared) removePresence(SHARED_KEY_PREFIX, entry);
    }

    private void removePresence(String keyPrefix, Entry entry) {
        try {
            redis.opsForZSet().remove(keyPrefix + entry.userId(), entry.playerId());
        } catch (RuntimeException unavailable) {
            LoggerFactory.getLogger(getClass()).warn("Account presence cleanup failed: {}",
                unavailable.getClass().getSimpleName());
        }
    }
}
