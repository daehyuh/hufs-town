package town.hufs.api.calendar;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

@Repository
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
public class CalendarSyncOutbox {
    private static final String READABLE_SPACE = """
        AND NOT EXISTS (SELECT 1 FROM space_access_block b WHERE b.space_id=s.id AND b.user_id=?)
        AND (EXISTS (SELECT 1 FROM space_member m WHERE m.space_id=s.id AND m.user_id=?)
          OR (s.visibility<>'PRIVATE' AND (
            NOT EXISTS (SELECT 1 FROM space_allowed_email_domain d WHERE d.space_id=s.id)
            OR EXISTS (
                SELECT 1 FROM oauth_identity identity
                JOIN space_allowed_email_domain allowed ON allowed.space_id=s.id
                  AND allowed.email_domain=LOWER(SUBSTRING_INDEX(identity.verified_email,'@',-1))
                WHERE identity.user_id=? AND identity.verified_email IS NOT NULL
                  AND identity.verified_email LIKE '%@%'
            )
          )))
        """;

    private final JdbcTemplate db;
    private final TransactionTemplate transactions;

    public CalendarSyncOutbox(JdbcTemplate db, TransactionTemplate transactions) {
        this.db = db;
        this.transactions = transactions;
    }

    public void enqueue(String userId, String sourceKind, String sourceId, String operation) {
        if (!Set.of("SCHEDULED_EVENT", "ROOM_RESERVATION").contains(sourceKind)
            || !Set.of("UPSERT", "DELETE").contains(operation)) return;
        db.update("""
            INSERT INTO calendar_sync_outbox(id,user_id,provider,source_kind,source_id,operation)
            SELECT ?,connection.user_id,'GOOGLE',?,?,?
            FROM user_calendar_connection connection
            WHERE connection.user_id=? AND connection.provider='GOOGLE'
              AND connection.connection_state='CONNECTED'
              AND NOT EXISTS (
                SELECT 1 FROM calendar_sync_item item
                WHERE item.user_id=connection.user_id AND item.provider='GOOGLE'
                  AND item.source_kind=? AND item.source_id=? AND item.sync_state='CONFLICT'
              )
            ON DUPLICATE KEY UPDATE operation=VALUES(operation),attempts=0,
                available_at=CURRENT_TIMESTAMP(6),lease_until=NULL,lease_id=NULL,
                force_apply=FALSE,last_error_code=NULL,updated_at=CURRENT_TIMESTAMP(6)
            """, UUID.randomUUID().toString(), sourceKind, sourceId, operation, userId, sourceKind, sourceId);
    }

    public void enqueueGoingAttendees(String eventId, String operation) {
        List<String> userIds = db.queryForList("""
            SELECT user_id FROM town_scheduled_event_rsvp
            WHERE event_id=? AND response='GOING'
            """, String.class, eventId);
        userIds.forEach(userId -> enqueue(userId, "SCHEDULED_EVENT", eventId, operation));
    }

    public void enqueueConflictOverwrite(String userId, String sourceKind, String sourceId) {
        if (!Set.of("SCHEDULED_EVENT", "ROOM_RESERVATION").contains(sourceKind))
            throw new CalendarIntegrationFailure("CALENDAR_SYNC_ITEM_NOT_FOUND", 404);
        int updated = db.update("""
            INSERT INTO calendar_sync_outbox(id,user_id,provider,source_kind,source_id,operation,force_apply)
            SELECT ?,item.user_id,item.provider,item.source_kind,item.source_id,
                CASE WHEN item.sync_state='CONFLICT' THEN 'UPSERT' ELSE 'UPSERT' END,TRUE
            FROM calendar_sync_item item
            JOIN user_calendar_connection connection ON connection.user_id=item.user_id
                AND connection.provider=item.provider AND connection.connection_state='CONNECTED'
            WHERE item.user_id=? AND item.provider='GOOGLE' AND item.source_kind=? AND item.source_id=?
              AND item.sync_state='CONFLICT'
            ON DUPLICATE KEY UPDATE operation='UPSERT',attempts=0,available_at=CURRENT_TIMESTAMP(6),
                lease_until=NULL,lease_id=NULL,force_apply=TRUE,last_error_code=NULL,updated_at=CURRENT_TIMESTAMP(6)
            """, UUID.randomUUID().toString(), userId, sourceKind, sourceId);
        if (updated == 0) {
            Integer exists = db.queryForObject("""
                SELECT COUNT(*) FROM calendar_sync_item WHERE user_id=? AND provider='GOOGLE'
                  AND source_kind=? AND source_id=? AND sync_state='CONFLICT'
                """, Integer.class, userId, sourceKind, sourceId);
            if (exists == null || exists == 0)
                throw new CalendarIntegrationFailure("CALENDAR_SYNC_ITEM_NOT_FOUND", 404);
            throw new CalendarIntegrationFailure("CALENDAR_RECONNECT_REQUIRED", 409);
        }
    }

    public void reconcileUser(String userId) {
        transactions.executeWithoutResult(status -> reconcileLocked(userId));
    }

    public void reconcileConnectedUsers() {
        List<String> users = db.queryForList("""
            SELECT user_id FROM user_calendar_connection
            WHERE provider='GOOGLE' AND connection_state='CONNECTED'
            ORDER BY user_id
            """, String.class);
        users.forEach(this::reconcileUser);
    }

    private void reconcileLocked(String userId) {
        List<String> events = db.queryForList("""
            SELECT DISTINCT e.id
            FROM town_scheduled_event e
            JOIN town_scheduled_event_rsvp response ON response.event_id=e.id
              AND response.user_id=? AND response.response='GOING'
            JOIN town_space s ON s.id=e.space_id AND s.archived_at IS NULL
            JOIN app_user account ON account.id=? AND account.status='ACTIVE' AND account.deleted_at IS NULL
            WHERE e.cancelled_at IS NULL
            """ + READABLE_SPACE, String.class, userId, userId, userId, userId, userId);
        events.forEach(eventId -> enqueue(userId, "SCHEDULED_EVENT", eventId, "UPSERT"));

        List<String> reservations = db.queryForList("""
            SELECT reservation.id
            FROM town_room_reservation reservation
            JOIN town_space s ON s.id=reservation.space_id AND s.archived_at IS NULL
            JOIN app_user account ON account.id=? AND account.status='ACTIVE' AND account.deleted_at IS NULL
            WHERE reservation.organizer_user_id=? AND reservation.cancelled_at IS NULL
            """ + READABLE_SPACE, String.class, userId, userId, userId, userId, userId);
        reservations.forEach(reservationId -> enqueue(userId, "ROOM_RESERVATION", reservationId, "UPSERT"));

        Set<String> activeSources = new HashSet<>();
        events.forEach(id -> activeSources.add("SCHEDULED_EVENT:" + id));
        reservations.forEach(id -> activeSources.add("ROOM_RESERVATION:" + id));
        List<SourceKey> existing = db.query("""
            SELECT source_kind,source_id,sync_state FROM calendar_sync_item
            WHERE user_id=? AND provider='GOOGLE'
            """, (row, index) -> new SourceKey(row.getString("source_kind"), row.getString("source_id"),
                row.getString("sync_state")), userId);
        for (SourceKey source : existing) {
            if (!activeSources.contains(source.kind() + ":" + source.id()) && !"CONFLICT".equals(source.state()))
                enqueue(userId, source.kind(), source.id(), "DELETE");
        }
    }

    List<Claim> claimBatch(int limit) {
        return transactions.execute(status -> {
            List<Claim> candidates = db.query("""
                SELECT outbox.id,outbox.user_id,outbox.source_kind,outbox.source_id,outbox.operation,
                    outbox.attempts,outbox.force_apply
                FROM calendar_sync_outbox outbox
                JOIN user_calendar_connection connection ON connection.user_id=outbox.user_id
                  AND connection.provider=outbox.provider AND connection.connection_state='CONNECTED'
                WHERE outbox.provider='GOOGLE' AND outbox.available_at<=CURRENT_TIMESTAMP(6)
                  AND (outbox.lease_until IS NULL OR outbox.lease_until<CURRENT_TIMESTAMP(6))
                ORDER BY outbox.available_at,outbox.created_at,outbox.id
                LIMIT ? FOR UPDATE SKIP LOCKED
                """, (row, index) -> new Claim(row.getString("id"), row.getString("user_id"),
                    row.getString("source_kind"), row.getString("source_id"), row.getString("operation"),
                    row.getInt("attempts") + 1, row.getBoolean("force_apply"), UUID.randomUUID().toString()), limit);
            List<Claim> claimed = new ArrayList<>(candidates.size());
            for (Claim claim : candidates) {
                int changed = db.update("""
                    UPDATE calendar_sync_outbox SET attempts=?,lease_id=?,
                        lease_until=TIMESTAMPADD(SECOND,90,CURRENT_TIMESTAMP(6))
                    WHERE id=? AND (lease_until IS NULL OR lease_until<CURRENT_TIMESTAMP(6))
                    """, claim.attempt(), claim.leaseId(), claim.id());
                if (changed == 1) claimed.add(claim);
            }
            return List.copyOf(claimed);
        });
    }

    void finish(Claim claim) {
        db.update("DELETE FROM calendar_sync_outbox WHERE id=? AND lease_id=?", claim.id(), claim.leaseId());
    }

    boolean isCurrent(Claim claim) {
        Integer count = db.queryForObject("""
            SELECT COUNT(*) FROM calendar_sync_outbox
            WHERE id=? AND lease_id=? AND EXISTS (
              SELECT 1 FROM user_calendar_connection connection
              WHERE connection.user_id=calendar_sync_outbox.user_id
                AND connection.provider='GOOGLE' AND connection.connection_state='CONNECTED'
            )
            """, Integer.class, claim.id(), claim.leaseId());
        return count != null && count == 1;
    }

    int pendingCount(String userId, boolean failed) {
        Integer count = db.queryForObject("""
            SELECT COUNT(*) FROM calendar_sync_outbox
            WHERE user_id=? AND provider='GOOGLE' AND attempts %s 8
            """.formatted(failed ? ">=" : "<"), Integer.class, userId);
        return count == null ? 0 : count;
    }

    void retry(Claim claim, String errorCode) {
        if (claim.attempt() >= 8) {
            db.update("""
                UPDATE calendar_sync_outbox SET attempts=8,last_error_code='RETRY_LIMIT',
                    available_at=TIMESTAMPADD(DAY,1,CURRENT_TIMESTAMP(6)),lease_until=NULL,lease_id=NULL
                WHERE id=? AND lease_id=?
                """, claim.id(), claim.leaseId());
            return;
        }
        int delaySeconds = Math.min(3600, 15 * (1 << Math.min(claim.attempt() - 1, 7)));
        db.update("""
            UPDATE calendar_sync_outbox SET last_error_code=?,
                available_at=TIMESTAMPADD(SECOND,?,CURRENT_TIMESTAMP(6)),lease_until=NULL,lease_id=NULL
            WHERE id=? AND lease_id=?
            """, safeError(errorCode), delaySeconds, claim.id(), claim.leaseId());
    }

    private static String safeError(String value) {
        return value != null && value.matches("[A-Z0-9_]{1,64}") ? value : "CALENDAR_SYNC_FAILED";
    }

    record Claim(String id, String userId, String sourceKind, String sourceId, String operation,
                 int attempt, boolean forceApply, String leaseId) {}
    private record SourceKey(String kind, String id, String state) {}
}
