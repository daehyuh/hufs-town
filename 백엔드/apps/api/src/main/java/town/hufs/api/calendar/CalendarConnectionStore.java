package town.hufs.api.calendar;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;

@Repository
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class CalendarConnectionStore {
    private static final String PROVIDER = "GOOGLE";
    private final JdbcTemplate db;

    CalendarConnectionStore(JdbcTemplate db) { this.db = db; }

    Optional<Connection> find(String userId) {
        return db.query("""
            SELECT remote_calendar_id,refresh_token_ciphertext,connected_at,connection_state
            FROM user_calendar_connection WHERE user_id=? AND provider=?
            """, (row, index) -> new Connection(userId, row.getString("remote_calendar_id"),
                row.getString("refresh_token_ciphertext"), row.getTimestamp("connected_at").toInstant(),
                row.getString("connection_state")),
            userId, PROVIDER).stream().findFirst();
    }

    void save(String userId, String calendarId, String encryptedRefreshToken) {
        db.update("""
            INSERT INTO user_calendar_connection(user_id,provider,remote_calendar_id,refresh_token_ciphertext)
            VALUES (?,?,?,?)
            ON DUPLICATE KEY UPDATE remote_calendar_id=VALUES(remote_calendar_id),
                refresh_token_ciphertext=VALUES(refresh_token_ciphertext),connected_at=CURRENT_TIMESTAMP(6),
                connection_state='CONNECTED',updated_at=CURRENT_TIMESTAMP(6)
            """, userId, PROVIDER, calendarId, encryptedRefreshToken);
    }

    void requireReconnect(String userId) {
        db.update("""
            UPDATE user_calendar_connection SET connection_state='RECONNECT_REQUIRED',updated_at=CURRENT_TIMESTAMP(6)
            WHERE user_id=? AND provider=?
            """, userId, PROVIDER);
    }

    void delete(String userId) {
        db.update("DELETE FROM user_calendar_connection WHERE user_id=? AND provider=?", userId, PROVIDER);
    }

    record Connection(String userId, String remoteCalendarId, String encryptedRefreshToken,
                      Instant connectedAt, String connectionState) {}
}
