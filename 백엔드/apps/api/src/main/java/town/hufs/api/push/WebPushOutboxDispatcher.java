package town.hufs.api.push;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Component
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
public class WebPushOutboxDispatcher {
    private record Claimed(String id, String leaseId, int attempt, boolean social) {}
    private record Message(String conversationId, String senderName, String recipientId) {}
    private record FriendNotification(String eventType, String senderName, String recipientId) {}
    private record Subscription(String endpoint, String p256dh, String auth) {}

    private final JdbcTemplate db;
    private final TransactionTemplate transactions;
    private final WebPushDelivery delivery;
    private final ObjectMapper json;
    private final StringRedisTemplate redis;

    WebPushOutboxDispatcher(JdbcTemplate db, TransactionTemplate transactions,
                            WebPushDelivery delivery, ObjectMapper json, StringRedisTemplate redis) {
        this.db = db;
        this.transactions = transactions;
        this.delivery = delivery;
        this.json = json;
        this.redis = redis;
    }

    @Scheduled(fixedDelayString = "${town.web-push.poll-ms:1000}")
    public void dispatch() {
        if (!delivery.enabled()) return;
        for (boolean social : List.of(false, true)) {
            for (Claimed row : claimBatch(social)) {
                try {
                    deliver(row);
                } catch (Exception ignored) {
                    retry(row, "DELIVERY_ERROR");
                }
            }
        }
    }

    @Scheduled(cron = "0 15 4 * * *")
    void removeExpiredRows() {
        for (String table : List.of("direct_message_push_outbox", "social_push_outbox")) {
            db.update("DELETE FROM " + table + " WHERE delivered_at IS NOT NULL " +
                "AND delivered_at < CURRENT_TIMESTAMP(6) - INTERVAL 7 DAY");
            db.update("DELETE FROM " + table + " WHERE delivered_at IS NULL " +
                "AND created_at < CURRENT_TIMESTAMP(6) - INTERVAL 1 DAY");
        }
    }

    private List<Claimed> claimBatch(boolean social) {
        String table = social ? "social_push_outbox" : "direct_message_push_outbox";
        return transactions.execute(status -> {
            List<Claimed> candidates = db.query(("""
                SELECT id,attempt_count FROM %s
                WHERE delivered_at IS NULL AND next_attempt_at <= CURRENT_TIMESTAMP(6)
                  AND (lease_until IS NULL OR lease_until < CURRENT_TIMESTAMP(6))
                  AND created_at >= CURRENT_TIMESTAMP(6) - INTERVAL 1 DAY
                ORDER BY created_at,id LIMIT 5 FOR UPDATE SKIP LOCKED
                """).formatted(table), (rs, row) -> new Claimed(rs.getString("id"), UUID.randomUUID().toString(),
                    rs.getInt("attempt_count") + 1, social));
            for (Claimed candidate : candidates) {
                db.update(("""
                    UPDATE %s
                    SET lease_id=?,lease_until=TIMESTAMPADD(SECOND,600,CURRENT_TIMESTAMP(6)),attempt_count=attempt_count+1
                    WHERE id=? AND delivered_at IS NULL
                    """).formatted(table), candidate.leaseId(), candidate.id());
            }
            return candidates;
        });
    }

    private void deliver(Claimed row) throws Exception {
        if (row.social()) deliverFriendNotification(row);
        else deliverDirectMessage(row);
    }

    private void deliverDirectMessage(Claimed row) throws Exception {
        List<Message> messages = db.query("""
            SELECT dm.conversation_id,dm.sender_name,o.recipient_user_id
            FROM direct_message_push_outbox o
            JOIN direct_message dm ON dm.message_id=o.message_id
            JOIN direct_conversation_member member
              ON member.conversation_id=dm.conversation_id AND member.user_id=o.recipient_user_id
            JOIN app_user sender ON sender.id=dm.sender_user_id
            JOIN app_user recipient ON recipient.id=member.user_id
            WHERE o.id=? AND dm.deleted_at IS NULL AND dm.expires_at>CURRENT_TIMESTAMP(6)
              AND sender.status='ACTIVE' AND sender.deleted_at IS NULL
              AND recipient.status='ACTIVE' AND recipient.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM user_block b
                WHERE (b.blocker_user_id=dm.sender_user_id AND b.blocked_user_id=member.user_id)
                   OR (b.blocker_user_id=member.user_id AND b.blocked_user_id=dm.sender_user_id)
              )
            """, (rs, index) -> new Message(rs.getString("conversation_id"), rs.getString("sender_name"),
                rs.getString("recipient_user_id")), row.id());
        if (messages.isEmpty()) {
            finish(row, "NOT_DELIVERABLE");
            return;
        }

        Message message = messages.getFirst();
        String payload = json.writeValueAsString(Map.of(
            "kind", "DIRECT_MESSAGE",
            "title", "메시지 · " + message.senderName(),
            "body", "새 메시지가 도착했어요.",
            "conversationId", message.conversationId()
        ));
        deliverPayload(row, message.recipientId(), payload);
    }

    private void deliverFriendNotification(Claimed row) throws Exception {
        List<FriendNotification> events = db.query("""
            SELECT outbox.event_type,actor.display_name,outbox.recipient_user_id
            FROM social_push_outbox outbox
            JOIN user_friendship friendship ON friendship.friendship_id=outbox.friendship_id
            JOIN app_user actor ON actor.id=outbox.actor_user_id AND actor.status='ACTIVE' AND actor.deleted_at IS NULL
            JOIN app_user recipient ON recipient.id=outbox.recipient_user_id
              AND recipient.status='ACTIVE' AND recipient.deleted_at IS NULL
            LEFT JOIN user_social_preference preference ON preference.user_id=recipient.id
            WHERE outbox.id=? AND COALESCE(preference.allow_friend_notifications,TRUE)=TRUE
              AND ((outbox.event_type='FRIEND_REQUEST' AND friendship.status='PENDING'
                    AND friendship.requested_by_user_id=outbox.actor_user_id)
                OR (outbox.event_type='FRIEND_ACCEPTED' AND friendship.status='ACCEPTED'))
              AND NOT EXISTS (SELECT 1 FROM user_block block WHERE
                (block.blocker_user_id=outbox.actor_user_id AND block.blocked_user_id=outbox.recipient_user_id)
                OR (block.blocker_user_id=outbox.recipient_user_id AND block.blocked_user_id=outbox.actor_user_id))
            """, (rs, index) -> new FriendNotification(rs.getString("event_type"), rs.getString("display_name"),
                rs.getString("recipient_user_id")), row.id());
        if (events.isEmpty()) {
            finish(row, "NOT_DELIVERABLE");
            return;
        }

        FriendNotification event = events.getFirst();
        boolean accepted = "FRIEND_ACCEPTED".equals(event.eventType());
        String payload = json.writeValueAsString(Map.of(
            "kind", "FRIEND",
            "eventType", event.eventType(),
            "title", accepted ? "친구 요청 수락" : "새 친구 요청",
            "body", accepted
                ? event.senderName() + "님이 친구 요청을 수락했어요."
                : event.senderName() + "님이 친구 요청을 보냈어요."
        ));
        deliverPayload(row, event.recipientId(), payload);
    }

    private void deliverPayload(Claimed row, String recipientId, String payload) throws Exception {
        if (isDnd(recipientId)) {
            finish(row, "SUPPRESSED_DND");
            return;
        }
        List<Subscription> subscriptions = db.query("""
            SELECT endpoint,p256dh,auth_secret FROM web_push_subscription WHERE user_id=?
            """, (rs, index) -> new Subscription(rs.getString("endpoint"), rs.getString("p256dh"),
            rs.getString("auth_secret")), recipientId);
        if (subscriptions.isEmpty()) {
            finish(row, null);
            return;
        }

        boolean delivered = false;
        boolean retryable = false;
        for (Subscription subscription : subscriptions) {
            try {
                WebPushDelivery.DeliveryResponse response = delivery.send(subscription.endpoint(),
                    subscription.p256dh(), subscription.auth(), payload);
                int code = response.statusCode();
                if (code >= 200 && code < 300) {
                    delivered = true;
                } else if (code == 404 || code == 410 || (code >= 300 && code < 500 && code != 429)) {
                    deleteSubscription(recipientId, subscription.endpoint());
                } else {
                    retryable = true;
                }
            } catch (Exception networkFailure) {
                retryable = true;
            }
        }

        if (delivered || !retryable) finish(row, null);
        else retry(row, "PROVIDER_UNAVAILABLE");
    }

    private void deleteSubscription(String userId, String endpoint) {
        db.update("DELETE FROM web_push_subscription WHERE user_id=? AND endpoint=?", userId, endpoint);
    }

    boolean isDnd(String userId) {
        Long activeSessions = redis.opsForZSet().count(
            "hufs-town:presence:dnd:" + userId, (double) System.currentTimeMillis(), Double.POSITIVE_INFINITY);
        return activeSessions != null && activeSessions > 0;
    }

    private void finish(Claimed row, String errorCode) {
        String table = row.social() ? "social_push_outbox" : "direct_message_push_outbox";
        db.update(("""
            UPDATE %s
            SET delivered_at=CURRENT_TIMESTAMP(6),last_error_code=?,lease_id=NULL,lease_until=NULL
            WHERE id=? AND lease_id=? AND delivered_at IS NULL
            """).formatted(table), errorCode, row.id(), row.leaseId());
    }

    private void retry(Claimed row, String errorCode) {
        if (row.attempt() >= 8) {
            finish(row, "RETRY_LIMIT");
            return;
        }
        int delaySeconds = Math.min(3600, 15 * (1 << Math.min(row.attempt() - 1, 7)));
        String table = row.social() ? "social_push_outbox" : "direct_message_push_outbox";
        db.update(("""
            UPDATE %s
            SET next_attempt_at=TIMESTAMPADD(SECOND,?,CURRENT_TIMESTAMP(6)),last_error_code=?,lease_id=NULL,lease_until=NULL
            WHERE id=? AND lease_id=? AND delivered_at IS NULL
            """).formatted(table), delaySeconds, errorCode, row.id(), row.leaseId());
    }
}
