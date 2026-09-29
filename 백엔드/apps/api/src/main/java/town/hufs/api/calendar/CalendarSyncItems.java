package town.hufs.api.calendar;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class CalendarSyncItems {
    private final JdbcTemplate db;

    CalendarSyncItems(JdbcTemplate db) { this.db = db; }

    Optional<Item> find(String userId, String sourceKind, String sourceId) {
        return db.query("""
            SELECT remote_event_id,remote_etag,source_hash,sync_state,synced_at
            FROM calendar_sync_item WHERE user_id=? AND provider='GOOGLE' AND source_kind=? AND source_id=?
            """, (row, index) -> new Item(userId, sourceKind, sourceId, row.getString("remote_event_id"),
                row.getString("remote_etag"), row.getString("source_hash"), row.getString("sync_state"),
                row.getTimestamp("synced_at").toInstant()), userId, sourceKind, sourceId).stream().findFirst();
    }

    void save(String userId, String sourceKind, String sourceId, String remoteEventId,
              String remoteEtag, String sourceHash) {
        db.update("""
            INSERT INTO calendar_sync_item(user_id,provider,source_kind,source_id,remote_event_id,
                remote_etag,source_hash,sync_state)
            VALUES (?, 'GOOGLE', ?, ?, ?, ?, ?, 'SYNCED')
            ON DUPLICATE KEY UPDATE remote_event_id=VALUES(remote_event_id),remote_etag=VALUES(remote_etag),
                source_hash=VALUES(source_hash),sync_state='SYNCED',synced_at=CURRENT_TIMESTAMP(6)
            """, userId, sourceKind, sourceId, remoteEventId, remoteEtag, sourceHash);
    }

    void markConflict(String userId, String sourceKind, String sourceId) {
        db.update("""
            UPDATE calendar_sync_item SET sync_state='CONFLICT'
            WHERE user_id=? AND provider='GOOGLE' AND source_kind=? AND source_id=?
            """, userId, sourceKind, sourceId);
    }

    void delete(String userId, String sourceKind, String sourceId) {
        db.update("""
            DELETE FROM calendar_sync_item
            WHERE user_id=? AND provider='GOOGLE' AND source_kind=? AND source_id=?
            """, userId, sourceKind, sourceId);
    }

    List<Conflict> conflicts(String userId) {
        return db.query("""
            SELECT source_kind,source_id,remote_event_id,synced_at
            FROM calendar_sync_item WHERE user_id=? AND provider='GOOGLE' AND sync_state='CONFLICT'
            ORDER BY synced_at DESC LIMIT 100
            """, (row, index) -> new Conflict(row.getString("source_kind"), row.getString("source_id"),
                row.getString("remote_event_id"), row.getTimestamp("synced_at").toInstant()), userId);
    }

    record Item(String userId, String sourceKind, String sourceId, String remoteEventId, String remoteEtag,
                String sourceHash, String state, Instant syncedAt) {}
    record Conflict(String sourceKind, String sourceId, String remoteEventId, Instant detectedAt) {}
}
