package town.hufs.world;

import jakarta.annotation.PreDestroy;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class UserBlockStore {
    record LoadResult(boolean ok, Set<String> blockedUserIds, boolean allowPokes) {}
    record UpdateResult(boolean ok, boolean limitExceeded) {}
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final StringRedisTemplate redis;
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(256), task -> {
            Thread thread = new Thread(task, "town-user-block-storage");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());

    UserBlockStore(JdbcTemplate db, TransactionTemplate tx, StringRedisTemplate redis) {
        this.db = db;
        this.tx = tx;
        this.redis = redis;
    }

    boolean load(String userId, Consumer<LoadResult> completed) {
        try {
            worker.execute(() -> {
                try {
                    Set<String> blocked = new LinkedHashSet<>(db.queryForList(
                        "SELECT blocked_user_id FROM user_block WHERE blocker_user_id=? ORDER BY created_at DESC LIMIT 500",
                        String.class, userId));
                    Boolean allowPokes = db.queryForObject("SELECT allow_pokes FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL",
                        Boolean.class, userId);
                    completed.accept(new LoadResult(true, Set.copyOf(blocked), Boolean.TRUE.equals(allowPokes)));
                } catch (RuntimeException failure) {
                    LoggerFactory.getLogger(getClass()).warn("User block load failed: {}", failure.getClass().getSimpleName());
                    completed.accept(new LoadResult(false, Set.of(), false));
                }
            });
            return true;
        } catch (RejectedExecutionException full) {
            return false;
        }
    }

    boolean set(String blockerUserId, String blockedUserId, String displayName, boolean blocked,
                Consumer<UpdateResult> completed) {
        try {
            worker.execute(() -> {
                try {
                    if (blocked) {
                        tx.executeWithoutResult(status -> {
                            db.queryForList("SELECT id FROM app_user WHERE id=? FOR UPDATE", String.class, blockerUserId);
                            int existing = db.queryForObject("SELECT COUNT(*) FROM user_block WHERE blocker_user_id=? AND blocked_user_id=?", Integer.class,
                                blockerUserId, blockedUserId);
                            int count = db.queryForObject("SELECT COUNT(*) FROM user_block WHERE blocker_user_id=?", Integer.class, blockerUserId);
                            if (existing == 0 && count >= 500) throw new BlockLimitException();
                            db.update("""
                                INSERT INTO user_block(block_id,blocker_user_id,blocked_user_id,blocked_display_name)
                                VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE blocked_display_name=VALUES(blocked_display_name)
                                """, UUID.randomUUID().toString(), blockerUserId, blockedUserId, displayName);
                            String first = blockerUserId.compareTo(blockedUserId) < 0 ? blockerUserId : blockedUserId;
                            String second = blockerUserId.compareTo(blockedUserId) < 0 ? blockedUserId : blockerUserId;
                            db.update("DELETE FROM user_friendship WHERE user_a_id=? AND user_b_id=?", first, second);
                        });
                    } else {
                        db.update("DELETE FROM user_block WHERE blocker_user_id=? AND blocked_user_id=?",
                            blockerUserId, blockedUserId);
                    }
                    try {
                        redis.convertAndSend(UserBlockChangeFanout.CHANNEL, blockerUserId);
                    } catch (RuntimeException unavailable) {
                        LoggerFactory.getLogger(getClass()).warn("Block-list refresh hint failed: {}",
                            unavailable.getClass().getSimpleName());
                    }
                    completed.accept(new UpdateResult(true, false));
                } catch (BlockLimitException limit) {
                    completed.accept(new UpdateResult(false, true));
                } catch (RuntimeException failure) {
                    LoggerFactory.getLogger(getClass()).warn("User block update failed: {}", failure.getClass().getSimpleName());
                    completed.accept(new UpdateResult(false, false));
                }
            });
            return true;
        } catch (RejectedExecutionException full) {
            return false;
        }
    }

    private static final class BlockLimitException extends RuntimeException {}

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
