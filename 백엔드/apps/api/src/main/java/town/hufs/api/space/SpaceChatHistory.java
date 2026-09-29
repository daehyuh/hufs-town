package town.hufs.api.space;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import town.hufs.auth.TownPrincipal;

import java.sql.Timestamp;
import java.util.*;

@Service
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class SpaceChatHistory {
    record Entry(String type, String messageId, String clientMessageId, String channel, String conversationId, String senderId,
                 String senderName, long avatar, String skin, String clothing, String hair,
                 String text, long sentAt, String zoneId, long revision, long editedAt, boolean deleted, boolean own) {}
    private record Cursor(Timestamp sentAt, String messageId, String zoneId) {}
    private final Spaces spaces;
    private final JdbcTemplate db;

    SpaceChatHistory(Spaces spaces, JdbcTemplate db) {
        this.spaces = spaces;
        this.db = db;
    }

    List<Entry> list(String spaceId, TownPrincipal principal, String channel, String zoneId, String beforeId, int limit) {
        if (principal == null || !validUuid(spaceId) || !Set.of("nearby", "room", "space").contains(channel)
            || limit < 1 || limit > 100 || ("room".equals(channel) && !validZone(zoneId))) throw invalid();
        spaces.detail(spaceId, principal.userId());

        var parameters = new ArrayList<Object>();
        StringBuilder sql = new StringBuilder("""
            SELECT m.message_id,m.client_message_id,m.channel,m.sender_player_id,m.sender_user_id,
                   m.sender_name,m.sender_avatar,m.sender_skin,m.sender_clothing,m.sender_hair,m.body,m.sent_at,m.zone_id
            FROM chat_message m JOIN chat_message_recipient r ON r.message_id=m.message_id
            WHERE m.space_id=? AND m.channel=? AND m.expires_at>CURRENT_TIMESTAMP(6) AND r.user_id=?
            """);
        parameters.add(spaceId);
        parameters.add(channel);
        parameters.add(principal.userId());
        if ("room".equals(channel)) {
            sql.append(" AND m.zone_id=?");
            parameters.add(zoneId);
        }
        if (beforeId != null && !beforeId.isBlank()) {
            if (!validUuid(beforeId)) throw invalid();
            Cursor cursor = db.query("""
                SELECT m.sent_at,m.message_id,m.zone_id FROM chat_message m
                JOIN chat_message_recipient r ON r.message_id=m.message_id
                WHERE m.space_id=? AND m.message_id=? AND m.channel=? AND m.expires_at>CURRENT_TIMESTAMP(6)
                  AND r.user_id=?
                """, rs -> rs.next() ? new Cursor(rs.getTimestamp("sent_at"), rs.getString("message_id"), rs.getString("zone_id")) : null,
                spaceId, beforeId, channel, principal.userId());
            if (cursor == null || ("room".equals(channel) && !zoneId.equals(cursor.zoneId()))) throw invalid();
            sql.append(" AND (m.sent_at<? OR (m.sent_at=? AND m.message_id<?))");
            parameters.add(cursor.sentAt());
            parameters.add(cursor.sentAt());
            parameters.add(cursor.messageId());
        }
        sql.append(" ORDER BY m.sent_at DESC,m.message_id DESC LIMIT ").append(limit);
        List<Entry> entries = db.query(sql.toString(), (rs, row) -> new Entry("chatEvent",
            rs.getString("message_id"), rs.getString("client_message_id"), rs.getString("channel"), "",
            rs.getString("sender_player_id"), rs.getString("sender_name"), rs.getLong("sender_avatar"),
            rs.getString("sender_skin"), rs.getString("sender_clothing"), rs.getString("sender_hair"),
            rs.getString("body"), rs.getTimestamp("sent_at").getTime(), rs.getString("zone_id"),
            0, 0, false, principal.userId().equals(rs.getString("sender_user_id"))), parameters.toArray());
        Collections.reverse(entries);
        return entries;
    }

    private static boolean validUuid(String id) {
        if (id == null || id.length() > 36) return false;
        try { return UUID.fromString(id).toString().equalsIgnoreCase(id); }
        catch (IllegalArgumentException invalid) { return false; }
    }

    private static boolean validZone(String id) {
        return id != null && id.length() <= 64 && id.matches("[A-Za-z0-9_-]{1,64}");
    }

    private static SpaceFailure invalid() {
        return new SpaceFailure(400, "INVALID_CHAT_HISTORY", "채팅 이력 요청을 확인해 주세요.");
    }
}
