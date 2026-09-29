package town.hufs.world;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import town.hufs.protocol.RoomNoteRevision;
import town.hufs.protocol.RoomNoteState;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Predicate;

/** Persists one private-room note, its revision history, and cross-node state relays. */
@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class RoomNotesStore implements MessageListener {
    static final String CHANNEL = "hufs-town:world:room-notes:v1";
    private static final int BATCH_SIZE = 100;
    private static final int RETENTION_DAYS = 30;
    private static final int PRESENCE_TTL_SECONDS = 15;
    private static final int MAX_BODY_CODE_POINTS = 4000;

    record SaveResult(boolean accepted, String code, String message, RoomNoteState state) {}
    record Relay(String spaceId, String mapId, String zoneId, RoomNoteState state) {}

    private record Hint(String originNodeId, long eventId) {}
    private record OutboxRow(long id, String spaceId, String mapId, String zoneId) {}
    private record StoredDocument(long revision, String body, Timestamp updatedAt, String updatedByName,
                                  Timestamp meetingEndedAt, Timestamp retentionExpiresAt) {}
    private record Persisted(SaveResult result, long eventId) {}

    private static final String DOCUMENT = """
        SELECT revision,body,updated_at,updated_by_name,meeting_ended_at,retention_expires_at
        FROM space_room_note
        WHERE space_id=? AND map_id=? AND zone_id=?
          AND (retention_expires_at IS NULL OR retention_expires_at>CURRENT_TIMESTAMP(6))
        """;

    private final String nodeId = UUID.randomUUID().toString();
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final StringRedisTemplate redis;
    private final ObjectMapper json;
    private final RedisMessageListenerContainer listener;
    private final ThreadPoolExecutor writer = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(256), task -> {
            Thread thread = new Thread(task, "town-room-note-storage");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());
    private final ThreadPoolExecutor publisher = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(256), task -> {
            Thread thread = new Thread(task, "town-room-note-publisher");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());
    private final ScheduledThreadPoolExecutor poller = new ScheduledThreadPoolExecutor(1, task -> {
        Thread thread = new Thread(task, "town-room-note-outbox-poller");
        thread.setDaemon(true);
        return thread;
    });
    private final ScheduledThreadPoolExecutor retention = new ScheduledThreadPoolExecutor(1, task -> {
        Thread thread = new Thread(task, "town-room-note-retention");
        thread.setDaemon(true);
        return thread;
    });
    private final AtomicBoolean polling = new AtomicBoolean();
    private volatile long cursor;
    private volatile Predicate<Relay> receiver = ignored -> false;

    RoomNotesStore(RedisConnectionFactory connectionFactory, JdbcTemplate db, TransactionTemplate tx,
                   StringRedisTemplate redis, ObjectMapper json) {
        this.db = db;
        this.tx = tx;
        this.redis = redis;
        this.json = json;
        try {
            cursor = outboxTableExists() ? latestEventId() : -1;
        } catch (RuntimeException migrationsNotReady) {
            // The API may still be applying migrations when a world node starts.
            cursor = -1;
        }
        listener = new RedisMessageListenerContainer();
        listener.setConnectionFactory(connectionFactory);
        listener.addMessageListener(this, new ChannelTopic(CHANNEL));
        listener.afterPropertiesSet();
        listener.start();
        poller.setRemoveOnCancelPolicy(true);
        poller.scheduleWithFixedDelay(this::requestPoll, 250, 250, TimeUnit.MILLISECONDS);
        retention.setRemoveOnCancelPolicy(true);
        retention.scheduleWithFixedDelay(this::queuePresenceSweep, 5, 5, TimeUnit.SECONDS);
        retention.scheduleWithFixedDelay(this::queuePurge, 1, 1, TimeUnit.HOURS);
    }

    boolean load(String spaceId, String mapId, String zoneId, Consumer<RoomNoteState> completed) {
        if (!validRoom(spaceId, mapId, zoneId)) return false;
        return submit("room note load", () -> {
            try {
                completed.accept(readState(spaceId, mapId, zoneId));
            } catch (RuntimeException failure) {
                LoggerFactory.getLogger(getClass()).warn("Room note load failed: {}", failure.getClass().getSimpleName());
                completed.accept(null);
            }
        });
    }

    boolean save(String spaceId, String mapId, String zoneId, String requestId, String authorUserId,
                 String authorName, long baseRevision, String body, Consumer<SaveResult> completed) {
        if (!validRoom(spaceId, mapId, zoneId)) return false;
        return submit("room note save", () -> {
            Persisted persisted;
            try {
                persisted = tx.execute(status -> persist(spaceId, mapId, zoneId, requestId, authorUserId,
                    authorName, baseRevision, body));
                if (persisted == null) {
                    completed.accept(rejected("ROOM_NOTE_STORAGE_UNAVAILABLE", "메모를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.", null));
                    return;
                }
            } catch (RuntimeException failure) {
                LoggerFactory.getLogger(getClass()).warn("Room note save failed: {}", failure.getClass().getSimpleName());
                completed.accept(rejected("ROOM_NOTE_STORAGE_UNAVAILABLE", "메모를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.", null));
                return;
            }
            try {
                completed.accept(persisted.result());
            } finally {
                if (persisted.eventId() > 0) publish(persisted.eventId());
            }
        });
    }

    /** Clears the retention clock when a participant resumes or starts using the room. */
    void resume(String spaceId, String mapId, String zoneId) {
        if (!validRoom(spaceId, mapId, zoneId)) return;
        if (!submit("room note resume", () -> tx.executeWithoutResult(status -> {
            lockDocument(spaceId, mapId, zoneId);
            db.update("""
                DELETE FROM space_room_note
                WHERE space_id=? AND map_id=? AND zone_id=?
                  AND retention_expires_at IS NOT NULL AND retention_expires_at<=CURRENT_TIMESTAMP(6)
                """, spaceId, mapId, zoneId);
            touchPresence(spaceId, mapId, zoneId);
            db.update("""
                UPDATE space_room_note SET meeting_ended_at=NULL,retention_expires_at=NULL
                WHERE space_id=? AND map_id=? AND zone_id=?
                """, spaceId, mapId, zoneId);
        }))) LoggerFactory.getLogger(getClass()).warn("Room note resume deferred because storage queue is full");
    }

    /** Refreshes this node's liveness lease while its local room still has occupants. */
    void touch(String spaceId, String mapId, String zoneId) {
        if (!validRoom(spaceId, mapId, zoneId)) return;
        if (!submit("room note presence heartbeat", () -> tx.executeWithoutResult(status -> {
            lockDocument(spaceId, mapId, zoneId);
            db.update("""
                DELETE FROM space_room_note
                WHERE space_id=? AND map_id=? AND zone_id=?
                  AND retention_expires_at IS NOT NULL AND retention_expires_at<=CURRENT_TIMESTAMP(6)
                """, spaceId, mapId, zoneId);
            touchPresence(spaceId, mapId, zoneId);
            db.update("""
                UPDATE space_room_note SET meeting_ended_at=NULL,retention_expires_at=NULL
                WHERE space_id=? AND map_id=? AND zone_id=?
                """, spaceId, mapId, zoneId);
        }))) LoggerFactory.getLogger(getClass()).warn("Room note presence heartbeat deferred because storage queue is full");
    }

    /** Starts the 30-day retention period after the room becomes empty. */
    void end(String spaceId, String mapId, String zoneId, long endedAt) {
        if (!validRoom(spaceId, mapId, zoneId) || endedAt <= 0) return;
        Timestamp end = new Timestamp(endedAt);
        if (!submit("room note end", () -> tx.executeWithoutResult(status -> {
            db.update("""
                DELETE FROM space_room_note_presence
                WHERE space_id=? AND map_id=? AND zone_id=? AND node_id=?
                """, spaceId, mapId, zoneId, nodeId);
            lockDocument(spaceId, mapId, zoneId);
            db.update("""
                UPDATE space_room_note note
                SET meeting_ended_at=?,retention_expires_at=TIMESTAMPADD(DAY,?,?)
                WHERE note.space_id=? AND note.map_id=? AND note.zone_id=? AND note.meeting_ended_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM space_room_note_presence presence
                    WHERE presence.space_id=note.space_id AND presence.map_id=note.map_id
                      AND presence.zone_id=note.zone_id
                      AND presence.last_seen_at>TIMESTAMPADD(SECOND,-?,CURRENT_TIMESTAMP(6))
                  )
                """, end, RETENTION_DAYS, end, spaceId, mapId, zoneId, PRESENCE_TTL_SECONDS);
        })))
            LoggerFactory.getLogger(getClass()).warn("Room note retention start deferred because storage queue is full");
    }

    void receiver(Predicate<Relay> receiver) {
        this.receiver = receiver == null ? ignored -> false : receiver;
        requestPoll();
    }

    @Override public void onMessage(Message message, byte[] pattern) {
        try {
            Hint hint = json.readValue(new String(message.getBody(), StandardCharsets.UTF_8), Hint.class);
            if (hint.eventId() > cursor && !nodeId.equals(hint.originNodeId())) requestPoll();
        } catch (Exception invalid) {
            LoggerFactory.getLogger(getClass()).warn("Ignoring invalid room note wake-up: {}", invalid.getClass().getSimpleName());
        }
    }

    private Persisted persist(String spaceId, String mapId, String zoneId, String requestId, String authorUserId,
                              String authorName, long baseRevision, String body) {
        if (!validRequest(requestId) || !validUuid(authorUserId) || !validAuthorName(authorName)
            || baseRevision < 0 || !validBody(body))
            return new Persisted(rejected("ROOM_NOTE_INVALID", "메모 내용을 확인해 주세요.", emptyState(zoneId)), 0);

        List<String> activeAuthor = db.queryForList("""
            SELECT id FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL FOR UPDATE
            """, String.class, authorUserId);
        if (activeAuthor.isEmpty())
            return new Persisted(rejected("ROOM_NOTE_ACCOUNT_UNAVAILABLE", "로그인 상태를 확인할 수 없어 메모를 저장하지 못했어요.", null), 0);

        db.update("""
            DELETE FROM space_room_note
            WHERE space_id=? AND map_id=? AND zone_id=?
              AND retention_expires_at IS NOT NULL AND retention_expires_at<=CURRENT_TIMESTAMP(6)
            """, spaceId, mapId, zoneId);
        db.update("""
            INSERT IGNORE INTO space_room_note(space_id,map_id,zone_id)
            VALUES (?,?,?)
            """, spaceId, mapId, zoneId);
        StoredDocument document = db.queryForObject(DOCUMENT + " FOR UPDATE", this::storedDocument,
            spaceId, mapId, zoneId);
        String requestHash = fingerprint(requestId, authorUserId, authorName, baseRevision, body);
        List<String> existingHashes = db.queryForList("""
            SELECT request_hash FROM space_room_note_revision
            WHERE space_id=? AND map_id=? AND zone_id=? AND request_id=?
            """, String.class, spaceId, mapId, zoneId, requestId);
        if (!existingHashes.isEmpty()) {
            if (!MessageDigest.isEqual(existingHashes.getFirst().getBytes(StandardCharsets.US_ASCII),
                requestHash.getBytes(StandardCharsets.US_ASCII)))
                return new Persisted(rejected("ROOM_NOTE_IDEMPOTENCY_CONFLICT", "이미 처리한 요청 ID를 다른 내용으로 사용할 수 없어요.",
                    readState(spaceId, mapId, zoneId)), 0);
            return new Persisted(accepted(readState(spaceId, mapId, zoneId)), 0);
        }

        RoomNoteState current = state(spaceId, mapId, zoneId, document);
        if (document.meetingEndedAt() != null)
            return new Persisted(rejected("ROOM_NOTE_MEETING_ENDED", "회의가 종료되어 메모를 수정할 수 없어요.", current), 0);
        if (document.revision() != baseRevision)
            return new Persisted(rejected("ROOM_NOTE_CONFLICT", "다른 참가자가 먼저 수정했어요. 최신 메모를 불러왔어요.", current), 0);

        long nextRevision = document.revision() + 1;
        Timestamp now = new Timestamp(System.currentTimeMillis());
        db.update("""
            UPDATE space_room_note
            SET revision=?,body=?,updated_at=CURRENT_TIMESTAMP(6),updated_by_user_id=?,updated_by_name=?
            WHERE space_id=? AND map_id=? AND zone_id=?
            """, nextRevision, body, authorUserId, authorName.strip(), spaceId, mapId, zoneId);
        db.update("""
            INSERT INTO space_room_note_revision(space_id,map_id,zone_id,request_id,revision,request_hash,
                author_user_id,author_name,body,edited_at)
            VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP(6))
            """, spaceId, mapId, zoneId, requestId, nextRevision, requestHash, authorUserId, authorName.strip(), body);
        long eventId = allocateEventId();
        db.update("""
            INSERT INTO space_room_note_event_outbox(id,origin_node_id,space_id,map_id,zone_id)
            VALUES (?,?,?,?,?)
            """, eventId, nodeId, spaceId, mapId, zoneId);
        return new Persisted(accepted(readState(spaceId, mapId, zoneId)), eventId);
    }

    private long allocateEventId() {
        Long next = db.queryForObject("""
            SELECT next_id FROM space_room_note_event_sequence WHERE singleton_id=1 FOR UPDATE
            """, Long.class);
        if (next == null || next < 1) throw new IllegalStateException("Room note outbox sequence is unavailable");
        db.update("UPDATE space_room_note_event_sequence SET next_id=? WHERE singleton_id=1", next + 1);
        return next;
    }

    private RoomNoteState readState(String spaceId, String mapId, String zoneId) {
        List<StoredDocument> rows = db.query(DOCUMENT, this::storedDocument, spaceId, mapId, zoneId);
        return rows.isEmpty() ? emptyState(zoneId) : state(spaceId, mapId, zoneId, rows.getFirst());
    }

    private RoomNoteState state(String spaceId, String mapId, String zoneId, StoredDocument document) {
        List<RoomNoteRevision> history = db.query("""
            SELECT revision,author_name,edited_at FROM space_room_note_revision
            WHERE space_id=? AND map_id=? AND zone_id=?
            ORDER BY revision DESC LIMIT 20
            """, (row, index) -> new RoomNoteRevision(row.getLong("revision"), row.getString("author_name"),
                row.getTimestamp("edited_at").getTime()), spaceId, mapId, zoneId);
        return new RoomNoteState("roomNoteState", zoneId, document.revision(), document.body(),
            millis(document.updatedAt()), document.updatedByName(), millis(document.meetingEndedAt()),
            millis(document.retentionExpiresAt()), List.copyOf(history));
    }

    private StoredDocument storedDocument(ResultSet row, int index) throws java.sql.SQLException {
        return new StoredDocument(row.getLong("revision"), row.getString("body"), row.getTimestamp("updated_at"),
            row.getString("updated_by_name"), row.getTimestamp("meeting_ended_at"), row.getTimestamp("retention_expires_at"));
    }

    private void publish(long eventId) {
        Hint hint = new Hint(nodeId, eventId);
        try {
            publisher.execute(() -> {
                try {
                    redis.convertAndSend(CHANNEL, json.writeValueAsString(hint));
                } catch (Exception failure) {
                    LoggerFactory.getLogger(getClass()).warn("Room note wake-up publish failed: {}", failure.getClass().getSimpleName());
                }
                requestPoll();
            });
        } catch (RejectedExecutionException full) {
            LoggerFactory.getLogger(getClass()).warn("Room note wake-up queue is full; SQL polling will recover events");
            requestPoll();
        }
    }

    private void requestPoll() {
        if (!polling.compareAndSet(false, true)) return;
        try {
            poller.execute(() -> {
                try {
                    drainOutbox();
                } finally {
                    polling.set(false);
                }
            });
        } catch (RejectedExecutionException shuttingDown) {
            polling.set(false);
        }
    }

    private void drainOutbox() {
        try {
            if (cursor < 0) {
                if (outboxTableExists()) cursor = latestEventId();
                return;
            }
            for (int page = 0; page < 10; page++) {
                List<OutboxRow> events = db.query("""
                    SELECT id,space_id,map_id,zone_id FROM space_room_note_event_outbox
                    WHERE id>? ORDER BY id LIMIT ?
                    """, (row, index) -> new OutboxRow(row.getLong("id"), row.getString("space_id"),
                    row.getString("map_id"), row.getString("zone_id")), cursor, BATCH_SIZE);
                if (events.isEmpty()) return;
                for (OutboxRow event : events) {
                    RoomNoteState state = readState(event.spaceId(), event.mapId(), event.zoneId());
                    if (state.revision() > 0 && !receiver.test(new Relay(event.spaceId(), event.mapId(), event.zoneId(), state)))
                        return;
                    cursor = event.id();
                }
                if (events.size() < BATCH_SIZE) return;
            }
        } catch (RuntimeException failure) {
            LoggerFactory.getLogger(getClass()).warn("Room note outbox poll failed: {}", failure.getClass().getSimpleName());
        }
    }

    private boolean outboxTableExists() {
        Boolean exists = db.execute((ConnectionCallback<Boolean>) connection -> {
            try (ResultSet tables = connection.getMetaData().getTables(connection.getCatalog(), null,
                "space_room_note_event_outbox", new String[] { "TABLE" })) {
                return tables.next();
            }
        });
        return Boolean.TRUE.equals(exists);
    }

    private long latestEventId() {
        Long latest = db.queryForObject("SELECT COALESCE(MAX(id),0) FROM space_room_note_event_outbox", Long.class);
        return latest == null ? 0 : latest;
    }

    void queuePurge() {
        if (!submit("room note retention cleanup", this::purgeExpiredDocuments))
            LoggerFactory.getLogger(getClass()).warn("Room note retention cleanup deferred because storage queue is full");
    }

    private void queuePresenceSweep() {
        if (!submit("room note presence sweep", () -> tx.executeWithoutResult(status -> {
            db.update("""
                DELETE FROM space_room_note_presence
                WHERE last_seen_at<=TIMESTAMPADD(SECOND,-?,CURRENT_TIMESTAMP(6))
                """, PRESENCE_TTL_SECONDS);
            db.update("""
                UPDATE space_room_note note
                SET meeting_ended_at=CURRENT_TIMESTAMP(6),
                    retention_expires_at=TIMESTAMPADD(DAY,?,CURRENT_TIMESTAMP(6))
                WHERE note.meeting_ended_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM space_room_note_presence presence
                    WHERE presence.space_id=note.space_id AND presence.map_id=note.map_id
                      AND presence.zone_id=note.zone_id
                      AND presence.last_seen_at>TIMESTAMPADD(SECOND,-?,CURRENT_TIMESTAMP(6))
                  )
                """, RETENTION_DAYS, PRESENCE_TTL_SECONDS);
            purgeExpiredDocuments();
        }))) LoggerFactory.getLogger(getClass()).warn("Room note presence sweep deferred because storage queue is full");
    }

    private void purgeExpiredDocuments() {
        for (int page = 0; page < 10; page++) {
            int removed = db.update("""
                DELETE FROM space_room_note
                WHERE retention_expires_at<=CURRENT_TIMESTAMP(6)
                ORDER BY retention_expires_at LIMIT 1000
                """);
            if (removed < 1000) break;
        }
    }

    private void touchPresence(String spaceId, String mapId, String zoneId) {
        db.update("""
            INSERT INTO space_room_note_presence(space_id,map_id,zone_id,node_id,last_seen_at)
            VALUES (?,?,?,?,CURRENT_TIMESTAMP(6))
            ON DUPLICATE KEY UPDATE last_seen_at=CURRENT_TIMESTAMP(6)
            """, spaceId, mapId, zoneId, nodeId);
    }

    private void lockDocument(String spaceId, String mapId, String zoneId) {
        db.queryForList("""
            SELECT revision FROM space_room_note WHERE space_id=? AND map_id=? AND zone_id=? FOR UPDATE
            """, Long.class, spaceId, mapId, zoneId);
    }

    private boolean submit(String operation, Runnable task) {
        try {
            writer.execute(() -> {
                try {
                    task.run();
                } catch (RuntimeException failure) {
                    LoggerFactory.getLogger(getClass()).warn("{} failed: {}", operation, failure.getClass().getSimpleName());
                }
            });
            return true;
        } catch (RejectedExecutionException full) {
            return false;
        }
    }

    private static SaveResult accepted(RoomNoteState state) { return new SaveResult(true, "", "", state); }
    private static SaveResult rejected(String code, String message, RoomNoteState state) {
        return new SaveResult(false, code, message, state);
    }

    private static RoomNoteState emptyState(String zoneId) {
        return new RoomNoteState("roomNoteState", zoneId, 0, "", 0, "", 0, 0, List.of());
    }

    private static long millis(Timestamp timestamp) { return timestamp == null ? 0 : timestamp.getTime(); }

    private static boolean validRoom(String spaceId, String mapId, String zoneId) {
        return validUuid(spaceId) && validUuid(mapId) && zoneId != null && zoneId.matches("[A-Za-z0-9_-]{1,64}");
    }

    private static boolean validUuid(String value) {
        if (value == null || value.length() != 36) return false;
        try { return UUID.fromString(value).toString().equalsIgnoreCase(value); }
        catch (IllegalArgumentException invalid) { return false; }
    }

    private static boolean validRequest(String value) {
        return value != null && value.matches("[A-Za-z0-9_-]{1,64}");
    }

    private static boolean validAuthorName(String value) {
        return value != null && !value.isBlank() && value.codePointCount(0, value.length()) <= 20
            && value.codePoints().noneMatch(ch -> Character.isISOControl(ch) || Character.getType(ch) == Character.FORMAT);
    }

    private static boolean validBody(String value) {
        return value != null && value.codePointCount(0, value.length()) <= MAX_BODY_CODE_POINTS
            && value.codePoints().noneMatch(ch -> Character.isISOControl(ch) && ch != '\n' && ch != '\r' && ch != '\t');
    }

    private static String fingerprint(String requestId, String authorUserId, String authorName, long baseRevision,
                                      String body) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            update(digest, requestId);
            update(digest, authorUserId);
            update(digest, authorName.strip());
            digest.update(ByteBuffer.allocate(Long.BYTES).putLong(baseRevision).array());
            update(digest, body);
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static void update(MessageDigest digest, String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(bytes.length).array());
        digest.update(bytes);
    }

    @PreDestroy
    void shutdown() {
        retention.shutdownNow();
        poller.shutdownNow();
        publisher.shutdownNow();
        listener.stop();
        try { listener.destroy(); }
        catch (Exception failure) {
            LoggerFactory.getLogger(getClass()).debug("Could not close room note Redis listener cleanly: {}", failure.getClass().getSimpleName());
        }
        writer.shutdown();
        try {
            if (!writer.awaitTermination(2, TimeUnit.SECONDS)) writer.shutdownNow();
        } catch (InterruptedException interrupted) {
            writer.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}
