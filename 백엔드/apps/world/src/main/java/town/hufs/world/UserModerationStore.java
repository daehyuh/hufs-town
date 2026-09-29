package town.hufs.world;

import jakarta.annotation.PreDestroy;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import town.hufs.domain.MediaPolicy;

import java.sql.Timestamp;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class UserModerationStore {
    record UserState(Set<MediaPolicy.Source> mutedSources, long blockedUntil, long chatMutedUntil) {}
    record UserResult(boolean ok, UserState state) {}
    record BatchResult(boolean ok, Map<String, UserResult> users) {}

    private final JdbcTemplate db;
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(512), task -> {
            Thread thread = new Thread(task, "town-user-moderation-storage");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());

    UserModerationStore(JdbcTemplate db) { this.db = db; }

    boolean load(String userId, Consumer<UserResult> completed) {
        return loadMany(Set.of(userId), result -> completed.accept(result.users().getOrDefault(userId,
            new UserResult(false, new UserState(Set.of(), 0, 0)))));
    }

    boolean loadMany(Collection<String> requestedUserIds, Consumer<BatchResult> completed) {
        Set<String> subjects = Set.copyOf(requestedUserIds);
        if (subjects.isEmpty()) {
            completed.accept(new BatchResult(true, Map.of()));
            return true;
        }
        Set<String> accountIds = new HashSet<>();
        Set<String> guestIds = new HashSet<>();
        for (String subject : subjects) {
            if (subject != null && subject.matches("user:[0-9a-fA-F-]{36}")) accountIds.add(subject.substring(5));
            else if (subject != null && subject.matches("guest:[0-9a-fA-F-]{36}")) guestIds.add(subject.substring(6));
            else return false;
        }
        try {
            worker.execute(() -> {
                try {
                    Map<String, UserResult> states = new HashMap<>();
                    long now = System.currentTimeMillis();
                    if (!accountIds.isEmpty()) {
                        String placeholders = String.join(",", Collections.nCopies(accountIds.size(), "?"));
                        List<Map<String, Object>> rows = db.queryForList("""
                        SELECT CONCAT('user:',u.id) AS moderation_subject,
                               media.muted_until AS media_muted_until,world.blocked_until AS world_blocked_until,
                               chat.muted_until AS chat_muted_until
                        FROM app_user u
                        LEFT JOIN user_media_mute media ON media.user_id=u.id
                        LEFT JOIN user_world_restriction world ON world.user_id=u.id
                        LEFT JOIN user_chat_restriction chat ON chat.user_id=u.id
                        WHERE u.id IN (%s) AND u.status='ACTIVE' AND u.deleted_at IS NULL
                        """.formatted(placeholders), accountIds.toArray());
                        for (Map<String, Object> row : rows) states.put((String) row.get("moderation_subject"), result(row, now));
                        for (String accountId : accountIds) states.putIfAbsent("user:" + accountId,
                            new UserResult(false, new UserState(Set.of(), 0, 0)));
                    }
                    if (!guestIds.isEmpty()) {
                        String placeholders = String.join(",", Collections.nCopies(guestIds.size(), "?"));
                        List<Map<String, Object>> rows = db.queryForList("""
                            SELECT CONCAT('guest:',guest_id) AS moderation_subject,
                                   media_muted_until,blocked_until AS world_blocked_until,chat_muted_until
                            FROM guest_moderation_restriction WHERE guest_id IN (%s)
                            """.formatted(placeholders), guestIds.toArray());
                        for (Map<String, Object> row : rows)
                            states.put((String) row.get("moderation_subject"), result(row, now));
                        for (String guestId : guestIds) states.putIfAbsent("guest:" + guestId,
                            new UserResult(true, new UserState(Set.of(), 0, 0)));
                    }
                    completed.accept(new BatchResult(true, Map.copyOf(states)));
                } catch (RuntimeException failure) {
                    LoggerFactory.getLogger(getClass()).warn("User moderation state load failed: {}", failure.getClass().getSimpleName());
                    completed.accept(new BatchResult(false, Map.of()));
                }
            });
            return true;
        } catch (RejectedExecutionException full) {
            return false;
        }
    }

    private static UserResult result(Map<String, Object> row, long now) {
        Timestamp mediaUntil = (Timestamp) row.get("media_muted_until");
        Timestamp worldUntil = (Timestamp) row.get("world_blocked_until");
        Timestamp chatUntil = (Timestamp) row.get("chat_muted_until");
        Set<MediaPolicy.Source> muted = mediaUntil != null && mediaUntil.getTime() > now
            ? Set.copyOf(EnumSet.allOf(MediaPolicy.Source.class)) : Set.of();
        return new UserResult(true, new UserState(muted,
            worldUntil != null && worldUntil.getTime() > now ? worldUntil.getTime() : 0,
            chatUntil != null && chatUntil.getTime() > now ? chatUntil.getTime() : 0));
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
