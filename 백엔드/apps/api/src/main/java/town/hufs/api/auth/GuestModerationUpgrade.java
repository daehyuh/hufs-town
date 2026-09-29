package town.hufs.api.auth;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Timestamp;
import java.util.List;

/** Carries active browser-scoped guest restrictions into an account when that guest session signs in. */
@Service
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
final class GuestModerationUpgrade {
    private final JdbcTemplate db;
    private final TransactionTemplate transactions;

    GuestModerationUpgrade(JdbcTemplate db, TransactionTemplate transactions) {
        this.db = db;
        this.transactions = transactions;
    }

    void transfer(String guestId, String userId) {
        if (guestId == null || !guestId.matches("[0-9a-fA-F-]{36}")) return;
        try {
            transactions.executeWithoutResult(status -> {
                List<Restriction> restrictions = db.query("""
                    SELECT chat_muted_until,media_muted_until,blocked_until,report_id,
                           updated_by_user_id,reason
                    FROM guest_moderation_restriction
                    WHERE guest_id=? FOR UPDATE
                    """, (row, index) -> new Restriction(
                    row.getTimestamp("chat_muted_until"), row.getTimestamp("media_muted_until"),
                    row.getTimestamp("blocked_until"), row.getString("report_id"),
                    row.getString("updated_by_user_id"), row.getString("reason")), guestId);
                if (restrictions.isEmpty()) return;
                Restriction restriction = restrictions.getFirst();
                Timestamp now = new Timestamp(System.currentTimeMillis());
                merge("user_chat_restriction", "muted_until", userId,
                    active(restriction.chatMutedUntil(), now), restriction);
                merge("user_media_mute", "muted_until", userId,
                    active(restriction.mediaMutedUntil(), now), restriction);
                merge("user_world_restriction", "blocked_until", userId,
                    active(restriction.blockedUntil(), now), restriction);
            });
        } catch (RuntimeException failure) {
            throw new AuthFailure(HttpStatus.SERVICE_UNAVAILABLE, "MODERATION_TRANSFER_UNAVAILABLE",
                "게스트 운영 조치를 계정에 적용하지 못했어요. 잠시 후 다시 로그인해 주세요.");
        }
    }

    private void merge(String table, String expiryColumn, String userId, Timestamp incomingUntil,
                       Restriction source) {
        if (incomingUntil == null) return;
        List<Restriction> currentRows = db.query("SELECT " + expiryColumn + " AS expiry,report_id,updated_by_user_id,reason " +
            "FROM " + table + " WHERE user_id=? FOR UPDATE", (row, index) -> new Restriction(
            null, null, row.getTimestamp("expiry"), row.getString("report_id"),
            row.getString("updated_by_user_id"), row.getString("reason")), userId);
        Restriction current = currentRows.isEmpty() ? null : currentRows.getFirst();
        if (current != null && current.blockedUntil() != null && !incomingUntil.after(current.blockedUntil())) return;
        if (current == null) {
            db.update("INSERT INTO " + table + "(user_id," + expiryColumn + ",report_id,updated_by_user_id,reason) " +
                    "VALUES (?,?,?,?,?)", userId, incomingUntil, source.reportId(), source.updatedByUserId(), safeReason(source.reason()));
        } else {
            db.update("UPDATE " + table + " SET " + expiryColumn + "=?,report_id=?,updated_by_user_id=?,reason=?,updated_at=CURRENT_TIMESTAMP(6) " +
                    "WHERE user_id=?", incomingUntil, source.reportId(), source.updatedByUserId(), safeReason(source.reason()), userId);
        }
    }

    private static Timestamp active(Timestamp value, Timestamp now) {
        return value != null && value.after(now) ? value : null;
    }

    private static String safeReason(String reason) { return reason == null ? "" : reason; }

    private record Restriction(Timestamp chatMutedUntil, Timestamp mediaMutedUntil, Timestamp blockedUntil,
                               String reportId, String updatedByUserId, String reason) {}
}
