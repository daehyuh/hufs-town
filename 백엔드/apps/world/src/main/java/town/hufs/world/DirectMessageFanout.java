package town.hufs.world;

import com.fasterxml.jackson.databind.JsonNode;
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
import town.hufs.protocol.ChatEvent;
import town.hufs.protocol.DirectMessageMutationEvent;
import town.hufs.protocol.DirectMessageReadEvent;

import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Predicate;

/** Redis wakes peers quickly; the SQL outbox is the durable source for live DM fan-out. */
@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class DirectMessageFanout implements MessageListener {
    static final String CHANNEL = "hufs-town:world:direct-messages:v2";
    private static final int BATCH_SIZE = 100;

    record Relay(long eventId, String originNodeId, String type, String actorUserId,
                 List<String> memberUserIds, JsonNode payload) {}
    private record Hint(String originNodeId, long eventId) {}
    private record OutboxEvent(long id, String type, String originNodeId, String actorUserId,
                               String readerMembershipId, String conversationId, String messageId,
                               String clientMessageId, String senderPlayerId, String senderName, long senderAvatar,
                               String senderSkin, String senderClothing, String senderHair, String body,
                               Timestamp sentAt, long revision, Timestamp editedAt, boolean deleted,
                               String recipientUserIds) {}

    private static final String LOAD_EVENTS = """
        SELECT e.id,e.event_type,e.origin_node_id,e.actor_user_id,e.reader_membership_id,
               d.conversation_id,d.message_id,d.client_message_id,d.sender_player_id,d.sender_name,d.sender_avatar,
               d.sender_skin,d.sender_clothing,d.sender_hair,d.body,d.sent_at,d.revision,d.edited_at,d.deleted_at,
               COALESCE((
                   SELECT GROUP_CONCAT(DISTINCT member.user_id ORDER BY member.user_id SEPARATOR ',')
                   FROM direct_message_event_recipient recipient
                   JOIN direct_conversation_member member ON member.membership_id=recipient.membership_id
                   JOIN app_user account ON account.id=member.user_id
                   WHERE recipient.event_id=e.id AND account.status='ACTIVE' AND account.deleted_at IS NULL
                     AND NOT EXISTS (
                         SELECT 1 FROM user_block block
                         WHERE (block.blocker_user_id=e.actor_user_id AND block.blocked_user_id=member.user_id)
                            OR (block.blocker_user_id=member.user_id AND block.blocked_user_id=e.actor_user_id)
                     )
               ),'') AS recipient_user_ids
        FROM direct_message_event_outbox e
        JOIN direct_message d ON d.message_id=e.message_id
        WHERE e.id>? ORDER BY e.id LIMIT ?
        """;

    private final String nodeId = UUID.randomUUID().toString();
    private final StringRedisTemplate redis;
    private final JdbcTemplate db;
    private final ObjectMapper json;
    private final RedisMessageListenerContainer listener;
    private final ThreadPoolExecutor publisher = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(256), task -> {
            Thread thread = new Thread(task, "town-dm-fanout-publisher");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());
    private final ScheduledThreadPoolExecutor poller = new ScheduledThreadPoolExecutor(1, task -> {
        Thread thread = new Thread(task, "town-dm-outbox-poller");
        thread.setDaemon(true);
        return thread;
    });
    private final AtomicBoolean polling = new AtomicBoolean();
    private volatile long cursor;
    private volatile Predicate<Relay> receiver = ignored -> false;

    DirectMessageFanout(RedisConnectionFactory connectionFactory, StringRedisTemplate redis,
                        JdbcTemplate db, ObjectMapper json) {
        this.redis = redis;
        this.db = db;
        this.json = json;
        try {
            cursor = outboxTableExists() ? latestEventId() : -1;
        } catch (RuntimeException migrationsNotReady) {
            // The world can start before the API has applied database migrations in local/test setups.
            cursor = -1;
        }
        listener = new RedisMessageListenerContainer();
        listener.setConnectionFactory(connectionFactory);
        listener.addMessageListener(this, new ChannelTopic(CHANNEL));
        listener.afterPropertiesSet();
        listener.start();
        poller.setRemoveOnCancelPolicy(true);
        poller.scheduleWithFixedDelay(this::requestPoll, 250, 250, TimeUnit.MILLISECONDS);
    }

    String nodeId() { return nodeId; }

    void receiver(Predicate<Relay> receiver) {
        this.receiver = receiver == null ? ignored -> false : receiver;
        requestPoll();
    }

    void publish(long eventId) {
        if (eventId <= 0) return;
        Hint hint = new Hint(nodeId, eventId);
        try {
            publisher.execute(() -> {
                try {
                    redis.convertAndSend(CHANNEL, json.writeValueAsString(hint));
                } catch (Exception failure) {
                    LoggerFactory.getLogger(getClass()).warn("Live DM wake-up publish failed: {}",
                        failure.getClass().getSimpleName());
                }
            });
        } catch (RejectedExecutionException full) {
            LoggerFactory.getLogger(getClass()).warn("Live DM wake-up queue is full; SQL polling will recover events");
        }
    }

    @Override public void onMessage(Message message, byte[] pattern) {
        try {
            Hint hint = json.readValue(new String(message.getBody(), StandardCharsets.UTF_8), Hint.class);
            if (!nodeId.equals(hint.originNodeId()) && hint.eventId() > cursor) requestPoll();
        } catch (Exception invalid) {
            LoggerFactory.getLogger(getClass()).warn("Ignoring invalid live DM wake-up: {}",
                invalid.getClass().getSimpleName());
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
                try {
                    if (outboxTableExists()) cursor = latestEventId();
                } catch (RuntimeException migrationsNotReady) {
                    LoggerFactory.getLogger(getClass()).debug("Waiting for the direct message outbox migration");
                }
                return;
            }
            for (int page = 0; page < 10; page++) {
                List<OutboxEvent> events = db.query(LOAD_EVENTS, (rs, row) -> {
                    Timestamp editedAt = rs.getTimestamp("edited_at");
                    return new OutboxEvent(rs.getLong("id"), rs.getString("event_type"),
                        rs.getString("origin_node_id"), rs.getString("actor_user_id"),
                        rs.getString("reader_membership_id"), rs.getString("conversation_id"),
                        rs.getString("message_id"), rs.getString("client_message_id"),
                        rs.getString("sender_player_id"), rs.getString("sender_name"), rs.getLong("sender_avatar"),
                        rs.getString("sender_skin"), rs.getString("sender_clothing"), rs.getString("sender_hair"),
                        rs.getString("body"), rs.getTimestamp("sent_at"), rs.getLong("revision"), editedAt,
                        rs.getTimestamp("deleted_at") != null, rs.getString("recipient_user_ids"));
                }, cursor, BATCH_SIZE);
                if (events.isEmpty()) return;
                for (OutboxEvent stored : events) {
                    Relay relay = relay(stored);
                    if (!receiver.test(relay)) return; // Keep this row for retry if the world queue is full.
                    cursor = stored.id();
                }
                if (events.size() < BATCH_SIZE) return;
            }
        } catch (RuntimeException failure) {
            LoggerFactory.getLogger(getClass()).warn("Direct message outbox poll failed: {}",
                failure.getClass().getSimpleName());
        }
    }

    private boolean outboxTableExists() {
        Boolean exists = db.execute((ConnectionCallback<Boolean>) connection -> {
            try (ResultSet tables = connection.getMetaData().getTables(connection.getCatalog(), null,
                "direct_message_event_outbox", new String[] { "TABLE" })) {
                return tables.next();
            }
        });
        return Boolean.TRUE.equals(exists);
    }

    private long latestEventId() {
        Long latest = db.queryForObject("SELECT COALESCE(MAX(id),0) FROM direct_message_event_outbox", Long.class);
        return latest == null ? 0 : latest;
    }

    private Relay relay(OutboxEvent stored) {
        List<String> members = stored.recipientUserIds().isBlank()
            ? List.of() : List.of(stored.recipientUserIds().split(","));
        Object payload;
        String relayType;
        switch (stored.type()) {
            case "MESSAGE" -> {
                relayType = "message";
                payload = new ChatEvent("chatEvent", stored.messageId(), stored.clientMessageId(), "dm",
                    stored.conversationId(), stored.senderPlayerId(), stored.senderName(), stored.senderAvatar(),
                    stored.senderSkin(), stored.senderClothing(), stored.senderHair(), stored.deleted() ? "" : stored.body(),
                    stored.sentAt().getTime(), "", stored.revision(), stored.editedAt() == null ? 0 : stored.editedAt().getTime(),
                    stored.deleted());
            }
            case "MUTATION" -> {
                relayType = "mutation";
                payload = new DirectMessageMutationEvent("directMessageMutationEvent", stored.conversationId(),
                    stored.messageId(), stored.deleted() ? "" : stored.body(), stored.revision(),
                    stored.editedAt() == null ? 0 : stored.editedAt().getTime(), stored.deleted());
            }
            case "READ" -> {
                if (stored.readerMembershipId() == null) return new Relay(stored.id(), stored.originNodeId(),
                    "ignored", stored.actorUserId(), List.of(), json.getNodeFactory().nullNode());
                relayType = "read";
                payload = new DirectMessageReadEvent("directMessageReadEvent", stored.conversationId(),
                    stored.messageId(), stored.sentAt().getTime(), stored.readerMembershipId());
            }
            default -> throw new IllegalArgumentException("Unknown direct message outbox event type");
        }
        return new Relay(stored.id(), stored.originNodeId(), relayType, stored.actorUserId(), members,
            json.valueToTree(payload));
    }

    @PreDestroy
    void shutdown() {
        publisher.shutdownNow();
        poller.shutdownNow();
        listener.stop();
        try {
            listener.destroy();
        } catch (Exception failure) {
            LoggerFactory.getLogger(getClass()).debug("Could not close the Redis DM listener cleanly: {}",
                failure.getClass().getSimpleName());
        }
    }
}
