package town.hufs.world;

import jakarta.annotation.PreDestroy;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import town.hufs.protocol.ChatEvent;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class ChatPersistence {
    record StoreResult(boolean ok, boolean inserted, ChatEvent event, String code, String message) {}
    private record Existing(ChatEvent event, String contentHash) {}
    private static final RowMapper<Existing> MESSAGE = (rs, row) -> new Existing(
        new ChatEvent("chatEvent", rs.getString("message_id"), rs.getString("client_message_id"),
            rs.getString("channel"), "", rs.getString("sender_player_id"), rs.getString("sender_name"),
            rs.getLong("sender_avatar"), rs.getString("sender_skin"), rs.getString("sender_clothing"),
            rs.getString("sender_hair"), rs.getString("body"),
            rs.getTimestamp("sent_at").getTime(), rs.getString("zone_id"), 0, 0, false),
        rs.getString("content_hash"));

    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final ChatRetentionPolicy retentionPolicy;
    private final ThreadPoolExecutor writer = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(256), task -> {
            Thread thread = new Thread(task, "town-chat-storage");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());
    private final ScheduledExecutorService retention = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "town-chat-retention");
        thread.setDaemon(true);
        return thread;
    });

    ChatPersistence(JdbcTemplate db, TransactionTemplate tx, ChatRetentionPolicy retentionPolicy) {
        this.db = db;
        this.tx = tx;
        this.retentionPolicy = retentionPolicy;
        retention.scheduleWithFixedDelay(this::queuePurge, 1, 1, TimeUnit.HOURS);
    }

    boolean enqueue(String spaceId, String senderUserId, ChatEvent event, List<String> recipientUserIds,
                    Consumer<StoreResult> completed) {
        try {
            writer.execute(() -> {
                StoreResult result;
                try {
                    result = tx.execute(status -> persist(spaceId, senderUserId, event, recipientUserIds));
                    if (result == null) result = unavailable();
                } catch (RuntimeException failure) {
                    org.slf4j.LoggerFactory.getLogger(getClass()).warn("Chat persistence failed: {}", failure.getClass().getSimpleName());
                    result = unavailable();
                }
                completed.accept(result);
            });
            return true;
        } catch (RejectedExecutionException full) {
            return false;
        }
    }

    private StoreResult persist(String spaceId, String senderUserId, ChatEvent event, List<String> recipientUserIds) {
        if (senderUserId != null && !senderUserId.isBlank()) {
            List<String> active = db.queryForList("""
                SELECT id FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL FOR UPDATE
                """, String.class, senderUserId);
            if (active.isEmpty()) return new StoreResult(false, false, null, "CHAT_ACCOUNT_UNAVAILABLE", "이 계정은 채팅을 사용할 수 없어요.");
            if (isChatRestricted(senderUserId))
                return new StoreResult(false, false, null, "CHAT_RESTRICTED", "운영 조치로 채팅이 일시 제한된 계정이에요.");
            int currentMembership = db.queryForObject("""
                SELECT COUNT(*) FROM space_member member
                WHERE member.space_id=? AND member.user_id=?
                  AND NOT EXISTS (SELECT 1 FROM space_access_block blocked
                    WHERE blocked.space_id=member.space_id AND blocked.user_id=member.user_id)
                """, Integer.class, spaceId, senderUserId);
            if (currentMembership != 1)
                return new StoreResult(false, false, null, "SPACE_ACCESS_REVOKED", "공간 입장 권한이 없어 채팅을 보낼 수 없어요.");
        }
        String hash = contentHash(event);
        var old = db.query("""
            SELECT message_id, client_message_id, channel, sender_player_id, sender_user_id,
                   sender_name, sender_avatar, sender_skin, sender_clothing, sender_hair, body, sent_at, zone_id, content_hash
            FROM chat_message WHERE space_id=? AND sender_user_id=? AND client_message_id=? FOR UPDATE
            """, MESSAGE, spaceId, senderUserId, event.clientMessageId());
        if (!old.isEmpty()) return duplicate(old.getFirst(), hash);

        Timestamp sentAt = new Timestamp(event.sentAt());
        Timestamp expiresAt = Timestamp.from(Instant.ofEpochMilli(event.sentAt())
            .plus(retentionPolicy.days(), ChronoUnit.DAYS));
        try {
            db.update("""
                INSERT INTO chat_message(message_id,space_id,sender_user_id,sender_player_id,client_message_id,
                    channel,zone_id,sender_name,sender_avatar,sender_skin,sender_clothing,sender_hair,body,content_hash,sent_at,expires_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, event.messageId(), spaceId, senderUserId, event.senderId(), event.clientMessageId(),
                event.channel(), event.zoneId(), event.senderName(), event.avatar(), event.skin(), event.clothing(), event.hair(),
                event.text(), hash, sentAt, expiresAt);
        } catch (org.springframework.dao.DuplicateKeyException raced) {
            var existing = db.query("""
                SELECT message_id, client_message_id, channel, sender_player_id, sender_user_id,
                       sender_name, sender_avatar, sender_skin, sender_clothing, sender_hair, body, sent_at, zone_id, content_hash
                FROM chat_message WHERE space_id=? AND sender_user_id=? AND client_message_id=? FOR UPDATE
                """, MESSAGE, spaceId, senderUserId, event.clientMessageId());
            if (existing.isEmpty()) throw raced;
            return duplicate(existing.getFirst(), hash);
        }
        var recipients = new LinkedHashSet<>(recipientUserIds);
        recipients.add(senderUserId);
        for (String userId : recipients) {
            db.update("INSERT IGNORE INTO chat_message_recipient(message_id,user_id) VALUES (?,?)", event.messageId(), userId);
        }
        return new StoreResult(true, true, event, "", "");
    }

    private boolean isChatRestricted(String userId) {
        return db.queryForObject("""
            SELECT COUNT(*) FROM user_chat_restriction
            WHERE user_id=? AND muted_until>CURRENT_TIMESTAMP(6)
            """, Integer.class, userId) > 0;
    }

    private static StoreResult duplicate(Existing existing, String receivedHash) {
        if (!MessageDigest.isEqual(existing.contentHash().getBytes(StandardCharsets.US_ASCII), receivedHash.getBytes(StandardCharsets.US_ASCII)))
            return new StoreResult(false, false, null, "CHAT_IDEMPOTENCY_CONFLICT", "이미 사용한 요청 ID예요. 다시 보내 주세요.");
        return new StoreResult(true, false, existing.event(), "", "");
    }

    private static String contentHash(ChatEvent event) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                (event.channel() + "\n" + event.zoneId() + "\n" + event.text()).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private void queuePurge() {
        try {
            writer.execute(() -> {
                try {
                    for (int page = 0; page < 10; page++) {
                        int removed = db.update("DELETE FROM chat_message WHERE expires_at<=CURRENT_TIMESTAMP(6) LIMIT 1000");
                        if (removed < 1000) break;
                    }
                } catch (RuntimeException failure) {
                    org.slf4j.LoggerFactory.getLogger(getClass()).warn("Chat retention cleanup failed: {}", failure.getClass().getSimpleName());
                }
            });
        } catch (RejectedExecutionException full) {
            org.slf4j.LoggerFactory.getLogger(getClass()).warn("Chat retention cleanup deferred because storage queue is full");
        }
    }

    private static StoreResult unavailable() {
        return new StoreResult(false, false, null, "CHAT_STORAGE_UNAVAILABLE", "메시지를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
    }

    @PreDestroy
    void shutdown() {
        retention.shutdownNow();
        writer.shutdown();
        try {
            if (!writer.awaitTermination(2, TimeUnit.SECONDS)) writer.shutdownNow();
        } catch (InterruptedException interrupted) {
            writer.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}
