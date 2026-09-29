package town.hufs.api.space;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import town.hufs.auth.TownPrincipal;
import org.springframework.security.core.annotation.AuthenticationPrincipal;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

@RestController
@RequestMapping("/api/v1/dms")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class DirectMessagesController {
    record Conversation(String conversationId, String kind, String displayName, int participantCount, Long avatar,
                        String skin, String clothing, String hair, String lastMessage,
                        Long lastMessageAt, int unreadCount, boolean owner) {}
    record MembershipChange(boolean changed) {}
    record GroupMember(String memberId, String displayName, long avatar, String skin, String clothing, String hair,
                       boolean owner, boolean self, long joinedAt) {}
    record GroupNameRequest(String name) {}
    record GroupNameChange(boolean changed, String name) {}
    record GroupMemberRemoval(boolean changed) {}
    record GroupInvitation(String invitationId, String conversationId, String groupName, String inviterName,
                           long createdAt, long expiresAt) {}
    record GroupInvitationResponse(boolean accepted) {}
    record GroupInvitationChange(boolean changed, boolean accepted, String conversationId, String message) {}
    record Entry(String type, String messageId, String clientMessageId, String channel, String conversationId,
                 String senderId, String senderName, long avatar, String skin, String clothing, String hair,
                 String text, long sentAt, String zoneId, long revision, long editedAt, boolean deleted, boolean own,
                 int readByCount) {}
    record RevisionEntry(long revision, String text, long versionAt) {}
    private record Cursor(Timestamp sentAt, String messageId) {}
    private record InvitationRow(String conversationId, String inviterUserId, String status, Timestamp expiresAt) {}
    private record GroupLock(String kind, String ownerUserId) {}

    private final JdbcTemplate db;
    private final TransactionTemplate transactions;

    DirectMessagesController(JdbcTemplate db, TransactionTemplate transactions) {
        this.db = db;
        this.transactions = transactions;
    }

    @GetMapping
    List<Conversation> list(@AuthenticationPrincipal TownPrincipal principal) {
        if (principal == null) throw hidden();
        return db.query("""
            SELECT c.id AS conversation_id,c.conversation_kind AS conversation_kind,
                   CASE WHEN c.conversation_kind='GROUP' THEN c.group_name ELSE
                     (SELECT other.display_name FROM direct_conversation_member peer
                      JOIN app_user other ON other.id=peer.user_id AND other.status='ACTIVE' AND other.deleted_at IS NULL
                      WHERE peer.conversation_id=c.id AND peer.user_id<>mine.user_id LIMIT 1)
                   END AS display_name,
                   (SELECT COUNT(*) FROM direct_conversation_member participant WHERE participant.conversation_id=c.id) AS participant_count,
                   (c.owner_user_id=mine.user_id) AS is_owner,
                   (SELECT other.avatar_preset FROM direct_conversation_member peer
                    JOIN app_user other ON other.id=peer.user_id AND other.status='ACTIVE' AND other.deleted_at IS NULL
                    WHERE peer.conversation_id=c.id AND peer.user_id<>mine.user_id ORDER BY peer.user_id LIMIT 1) AS avatar_preset,
                   (SELECT other.avatar_skin FROM direct_conversation_member peer
                    JOIN app_user other ON other.id=peer.user_id AND other.status='ACTIVE' AND other.deleted_at IS NULL
                    WHERE peer.conversation_id=c.id AND peer.user_id<>mine.user_id ORDER BY peer.user_id LIMIT 1) AS avatar_skin,
                   (SELECT other.avatar_clothing FROM direct_conversation_member peer
                    JOIN app_user other ON other.id=peer.user_id AND other.status='ACTIVE' AND other.deleted_at IS NULL
                    WHERE peer.conversation_id=c.id AND peer.user_id<>mine.user_id ORDER BY peer.user_id LIMIT 1) AS avatar_clothing,
                   (SELECT other.avatar_hair FROM direct_conversation_member peer
                    JOIN app_user other ON other.id=peer.user_id AND other.status='ACTIVE' AND other.deleted_at IS NULL
                    WHERE peer.conversation_id=c.id AND peer.user_id<>mine.user_id ORDER BY peer.user_id LIMIT 1) AS avatar_hair,
                   (SELECT CASE WHEN d.deleted_at IS NOT NULL THEN '삭제된 메시지' ELSE d.body END
                    FROM direct_message d WHERE d.conversation_id=c.id
                      AND d.expires_at>CURRENT_TIMESTAMP(6)
                      ORDER BY d.sent_at DESC,d.message_id DESC LIMIT 1) AS last_message,
                   (SELECT d.sent_at FROM direct_message d WHERE d.conversation_id=c.id
                      AND d.expires_at>CURRENT_TIMESTAMP(6)
                      ORDER BY d.sent_at DESC,d.message_id DESC LIMIT 1) AS last_message_at,
                   (SELECT COUNT(*) FROM direct_message d WHERE d.conversation_id=c.id
                      AND d.sender_user_id<>mine.user_id AND d.expires_at>CURRENT_TIMESTAMP(6)
                      AND (mine.last_read_at IS NULL OR d.sent_at>mine.last_read_at OR
                        (d.sent_at=mine.last_read_at AND mine.last_read_message_id IS NOT NULL
                          AND d.message_id>mine.last_read_message_id))) AS unread_count
            FROM direct_conversation c
            JOIN direct_conversation_member mine ON mine.conversation_id=c.id AND mine.user_id=?
            WHERE c.conversation_kind='GROUP' OR EXISTS (
                SELECT 1 FROM direct_conversation_member peer
                JOIN app_user other ON other.id=peer.user_id AND other.status='ACTIVE' AND other.deleted_at IS NULL
                WHERE peer.conversation_id=c.id AND peer.user_id<>mine.user_id
            )
            ORDER BY COALESCE((SELECT MAX(d.sent_at) FROM direct_message d
                               WHERE d.conversation_id=c.id AND d.expires_at>CURRENT_TIMESTAMP(6)),c.updated_at) DESC,c.id
            LIMIT 100
            """, (rs, row) -> {
                Timestamp sentAt = rs.getTimestamp("last_message_at");
                return new Conversation(rs.getString("conversation_id"), rs.getString("conversation_kind"),
                    rs.getString("display_name"), rs.getInt("participant_count"), rs.getObject("avatar_preset", Long.class),
                    rs.getString("avatar_skin"),
                    rs.getString("avatar_clothing"), rs.getString("avatar_hair"), rs.getString("last_message"),
                    sentAt == null ? null : sentAt.getTime(), rs.getInt("unread_count"), rs.getBoolean("is_owner"));
            }, principal.userId());
    }

    @DeleteMapping("/{conversationId}/membership")
    MembershipChange leaveGroup(@AuthenticationPrincipal TownPrincipal principal,
                                @PathVariable String conversationId) {
        if (principal == null) throw hidden();
        if (!validUuid(conversationId)) throw invalid();
        return transactions.execute(status -> {
            GroupLock group = lockGroup(conversationId);
            if (group == null) throw hidden();
            boolean member = !db.queryForList("SELECT user_id FROM direct_conversation_member WHERE conversation_id=? AND user_id=?",
                String.class, conversationId, principal.userId()).isEmpty();
            if (!member) throw hidden();
            if (principal.userId().equals(group.ownerUserId())) {
                List<String> successor = db.queryForList("""
                    SELECT user_id FROM direct_conversation_member
                    WHERE conversation_id=? AND user_id<>? ORDER BY joined_at,user_id LIMIT 1
                    """, String.class, conversationId, principal.userId());
                if (!successor.isEmpty()) db.update("UPDATE direct_conversation SET owner_user_id=? WHERE id=?",
                    successor.getFirst(), conversationId);
            }
            int removed = db.update(
                "DELETE FROM direct_conversation_member WHERE conversation_id=? AND user_id=?",
                conversationId, principal.userId());
            if (removed == 0) throw hidden();
            int remaining = db.queryForObject(
                "SELECT COUNT(*) FROM direct_conversation_member WHERE conversation_id=?",
                Integer.class, conversationId);
            if (remaining < 2) db.update("DELETE FROM direct_conversation WHERE id=?", conversationId);
            return new MembershipChange(true);
        });
    }

    @GetMapping("/{conversationId}/members")
    List<GroupMember> groupMembers(@AuthenticationPrincipal TownPrincipal principal,
                                   @PathVariable String conversationId) {
        if (principal == null || !validUuid(conversationId)) throw hidden();
        boolean group = !db.queryForList("SELECT id FROM direct_conversation WHERE id=? AND conversation_kind='GROUP'",
            String.class, conversationId).isEmpty();
        boolean member = !db.queryForList("SELECT user_id FROM direct_conversation_member WHERE conversation_id=? AND user_id=?",
            String.class, conversationId, principal.userId()).isEmpty();
        if (!group || !member) throw hidden();
        return db.query("""
            SELECT m.membership_id,u.display_name,u.avatar_preset,u.avatar_skin,u.avatar_clothing,u.avatar_hair,
                   (m.user_id=c.owner_user_id) AS is_owner,(m.user_id=?) AS is_self,m.joined_at
            FROM direct_conversation_member m
            JOIN direct_conversation c ON c.id=m.conversation_id
            JOIN app_user u ON u.id=m.user_id AND u.status='ACTIVE' AND u.deleted_at IS NULL
            WHERE m.conversation_id=?
            ORDER BY is_owner DESC,m.joined_at,m.user_id
            """, (rs, row) -> new GroupMember(rs.getString("membership_id"), rs.getString("display_name"),
            rs.getLong("avatar_preset"), rs.getString("avatar_skin"), rs.getString("avatar_clothing"),
            rs.getString("avatar_hair"), rs.getBoolean("is_owner"), rs.getBoolean("is_self"),
            rs.getTimestamp("joined_at").getTime()), principal.userId(), conversationId);
    }

    @PatchMapping("/{conversationId}")
    GroupNameChange renameGroup(@AuthenticationPrincipal TownPrincipal principal,
                                @PathVariable String conversationId,
                                @RequestBody GroupNameRequest request) {
        if (principal == null) throw hidden();
        if (!validUuid(conversationId) || request == null || request.name() == null
            || request.name().isBlank() || request.name().codePointCount(0, request.name().length()) > 32
            || request.name().chars().anyMatch(Character::isISOControl)) throw invalid();
        String name = request.name().strip();
        return transactions.execute(status -> {
            GroupLock group = lockGroup(conversationId);
            if (group == null || !principal.userId().equals(group.ownerUserId()))
                throw new SpaceFailure(403, "GROUP_OWNER_REQUIRED", "그룹 소유자만 이름을 바꿀 수 있어요.");
            db.update("UPDATE direct_conversation SET group_name=?,updated_at=CURRENT_TIMESTAMP(6) WHERE id=?",
                name, conversationId);
            return new GroupNameChange(true, name);
        });
    }

    @DeleteMapping("/{conversationId}/members/{memberId}")
    GroupMemberRemoval removeGroupMember(@AuthenticationPrincipal TownPrincipal principal,
                                         @PathVariable String conversationId,
                                         @PathVariable String memberId) {
        if (principal == null) throw hidden();
        if (!validUuid(conversationId) || !validUuid(memberId)) throw invalid();
        return transactions.execute(status -> {
            GroupLock group = lockGroup(conversationId);
            if (group == null || !principal.userId().equals(group.ownerUserId()))
                throw new SpaceFailure(403, "GROUP_OWNER_REQUIRED", "그룹 소유자만 멤버를 내보낼 수 있어요.");
            List<String> targets = db.queryForList("""
                SELECT user_id FROM direct_conversation_member
                WHERE conversation_id=? AND membership_id=? FOR UPDATE
                """, String.class, conversationId, memberId);
            if (targets.isEmpty()) throw hidden();
            String targetUserId = targets.getFirst();
            if (principal.userId().equals(targetUserId))
                throw new SpaceFailure(409, "GROUP_OWNER_CANNOT_REMOVE_SELF", "그룹 소유자는 나가기 기능을 사용해 주세요.");
            db.update("DELETE FROM direct_conversation_member WHERE conversation_id=? AND membership_id=?",
                conversationId, memberId);
            db.update("""
                UPDATE direct_conversation_invite SET status='CANCELLED',responded_at=CURRENT_TIMESTAMP(6)
                WHERE conversation_id=? AND invitee_user_id=? AND status='PENDING'
                """, conversationId, targetUserId);
            return new GroupMemberRemoval(true);
        });
    }

    @GetMapping("/group-invitations")
    List<GroupInvitation> groupInvitations(@AuthenticationPrincipal TownPrincipal principal) {
        if (principal == null) throw hidden();
        return db.query("""
            SELECT i.id,i.conversation_id,c.group_name,inviter.display_name AS inviter_name,i.created_at,i.expires_at
            FROM direct_conversation_invite i
            JOIN direct_conversation c ON c.id=i.conversation_id AND c.conversation_kind='GROUP'
            JOIN app_user inviter ON inviter.id=i.inviter_user_id AND inviter.status='ACTIVE' AND inviter.deleted_at IS NULL
            WHERE i.invitee_user_id=? AND i.status='PENDING' AND i.expires_at>CURRENT_TIMESTAMP(6)
            ORDER BY i.created_at DESC,i.id
            LIMIT 50
            """, (rs, row) -> new GroupInvitation(rs.getString("id"), rs.getString("conversation_id"),
            rs.getString("group_name"), rs.getString("inviter_name"), rs.getTimestamp("created_at").getTime(),
            rs.getTimestamp("expires_at").getTime()), principal.userId());
    }

    @PostMapping("/group-invitations/{invitationId}")
    GroupInvitationChange respondToGroupInvitation(@AuthenticationPrincipal TownPrincipal principal,
                                                    @PathVariable String invitationId,
                                                    @RequestBody GroupInvitationResponse request) {
        if (principal == null) throw hidden();
        if (!validUuid(invitationId) || request == null) throw invalid();
        return transactions.execute(status -> {
            InvitationRow initial = db.query("""
                SELECT conversation_id,inviter_user_id,status,expires_at
                FROM direct_conversation_invite WHERE id=? AND invitee_user_id=?
                """, rs -> rs.next() ? new InvitationRow(rs.getString("conversation_id"),
                    rs.getString("inviter_user_id"), rs.getString("status"), rs.getTimestamp("expires_at")) : null,
                invitationId, principal.userId());
            if (initial == null) throw hidden();
            List<String> initialMembers = db.queryForList(
                "SELECT user_id FROM direct_conversation_member WHERE conversation_id=? ORDER BY user_id",
                String.class, initial.conversationId());
            if (request.accepted()) {
                var users = new TreeSet<>(initialMembers);
                users.add(principal.userId());
                lockActiveAccounts(List.copyOf(users));
            }
            List<String> kinds = db.queryForList(
                "SELECT conversation_kind FROM direct_conversation WHERE id=? FOR UPDATE",
                String.class, initial.conversationId());
            if (kinds.isEmpty() || !"GROUP".equals(kinds.getFirst())) throw hidden();
            List<String> members = db.queryForList(
                "SELECT user_id FROM direct_conversation_member WHERE conversation_id=? ORDER BY user_id FOR UPDATE",
                String.class, initial.conversationId());
            if (!members.equals(initialMembers))
                throw new SpaceFailure(409, "GROUP_MEMBERS_CHANGED", "그룹 구성이 바뀌었어요. 초대 목록을 새로고침해 주세요.");
            InvitationRow current = db.query("""
                SELECT conversation_id,inviter_user_id,status,expires_at
                FROM direct_conversation_invite WHERE id=? AND invitee_user_id=? FOR UPDATE
                """, rs -> rs.next() ? new InvitationRow(rs.getString("conversation_id"),
                    rs.getString("inviter_user_id"), rs.getString("status"), rs.getTimestamp("expires_at")) : null,
                invitationId, principal.userId());
            if (current == null) throw hidden();
            if (!"PENDING".equals(current.status()))
                throw new SpaceFailure(409, "GROUP_INVITE_RESOLVED", "이미 처리된 그룹 초대예요.");
            if (!current.expiresAt().after(Timestamp.from(Instant.now())))
                throw new SpaceFailure(409, "GROUP_INVITE_EXPIRED", "그룹 초대가 만료되었어요.");
            if (!request.accepted()) {
                db.update("UPDATE direct_conversation_invite SET status='DECLINED',responded_at=CURRENT_TIMESTAMP(6) WHERE id=?",
                    invitationId);
                return new GroupInvitationChange(true, false, current.conversationId(), "그룹 초대를 거절했어요.");
            }
            if (members.contains(principal.userId()))
                throw new SpaceFailure(409, "GROUP_ALREADY_MEMBER", "이미 그룹 대화 참가자예요.");
            if (members.size() >= 12)
                throw new SpaceFailure(409, "GROUP_FULL", "그룹 대화가 가득 차 초대를 수락할 수 없어요.");
            var participants = new ArrayList<>(members);
            participants.add(principal.userId());
            if (hasBlockedPair(participants))
                throw new SpaceFailure(409, "GROUP_BLOCKED", "참가자 간 차단 설정 때문에 초대를 수락할 수 없어요.");
            db.update("INSERT INTO direct_conversation_member(membership_id,conversation_id,user_id) VALUES (UUID(),?,?)",
                current.conversationId(), principal.userId());
            db.update("UPDATE direct_conversation_invite SET status='ACCEPTED',responded_at=CURRENT_TIMESTAMP(6) WHERE id=?",
                invitationId);
            db.update("UPDATE direct_conversation SET updated_at=CURRENT_TIMESTAMP(6) WHERE id=?", current.conversationId());
            return new GroupInvitationChange(true, true, current.conversationId(), "그룹 대화에 참여했어요.");
        });
    }

    @GetMapping("/{conversationId}/messages")
    List<Entry> messages(@AuthenticationPrincipal TownPrincipal principal,
                         @PathVariable String conversationId,
                         @RequestParam(required = false) String beforeId,
                         @RequestParam(defaultValue = "50") int limit) {
        if (principal == null || !validUuid(conversationId) || limit < 1 || limit > 100) throw invalid();
        String userId = principal.userId();
        boolean member = !db.queryForList("SELECT user_id FROM direct_conversation_member WHERE conversation_id=? AND user_id=?",
            String.class, conversationId, userId).isEmpty();
        if (!member) throw hidden();

        var args = new ArrayList<Object>();
        StringBuilder sql = new StringBuilder("""
            SELECT d.message_id,d.client_message_id,d.conversation_id,d.sender_player_id,d.sender_user_id,
                   d.sender_name,d.sender_avatar,d.sender_skin,d.sender_clothing,d.sender_hair,d.body,d.sent_at,
                   d.revision,d.edited_at,d.deleted_at,
                   (SELECT COUNT(*) FROM direct_conversation_member reader
                    WHERE reader.conversation_id=d.conversation_id AND reader.user_id<>d.sender_user_id
                      AND reader.last_read_at IS NOT NULL
                      AND (reader.last_read_at>d.sent_at OR
                        (reader.last_read_at=d.sent_at AND reader.last_read_message_id>=d.message_id))) AS read_by_count
            FROM direct_message d
            WHERE d.conversation_id=? AND d.expires_at>CURRENT_TIMESTAMP(6)
            """);
        args.add(conversationId);
        if (beforeId != null && !beforeId.isBlank()) {
            if (!validUuid(beforeId)) throw invalid();
            Cursor cursor = db.query("""
                SELECT sent_at,message_id FROM direct_message
                WHERE conversation_id=? AND message_id=? AND expires_at>CURRENT_TIMESTAMP(6)
                """, rs -> rs.next() ? new Cursor(rs.getTimestamp("sent_at"), rs.getString("message_id")) : null,
                conversationId, beforeId);
            if (cursor == null) throw invalid();
            sql.append(" AND (d.sent_at<? OR (d.sent_at=? AND d.message_id<?))");
            args.add(cursor.sentAt());
            args.add(cursor.sentAt());
            args.add(cursor.messageId());
        }
        sql.append(" ORDER BY d.sent_at DESC,d.message_id DESC LIMIT ").append(limit);
        List<Entry> entries = db.query(sql.toString(), (rs, row) -> new Entry("chatEvent",
            rs.getString("message_id"), rs.getString("client_message_id"), "dm", rs.getString("conversation_id"),
            rs.getString("sender_player_id"), rs.getString("sender_name"), rs.getLong("sender_avatar"),
            rs.getString("sender_skin"), rs.getString("sender_clothing"), rs.getString("sender_hair"),
            rs.getTimestamp("deleted_at") == null ? rs.getString("body") : "",
            rs.getTimestamp("sent_at").getTime(), "", rs.getLong("revision"),
            rs.getTimestamp("edited_at") == null ? 0 : rs.getTimestamp("edited_at").getTime(),
            rs.getTimestamp("deleted_at") != null, userId.equals(rs.getString("sender_user_id")),
            rs.getInt("read_by_count")), args.toArray());
        Collections.reverse(entries);
        return entries;
    }

    @GetMapping("/{conversationId}/messages/{messageId}/revisions")
    List<RevisionEntry> revisions(@AuthenticationPrincipal TownPrincipal principal,
                                  @PathVariable String conversationId,
                                  @PathVariable String messageId) {
        if (principal == null || !validUuid(conversationId) || !validUuid(messageId)) throw invalid();
        boolean member = !db.queryForList(
            "SELECT user_id FROM direct_conversation_member WHERE conversation_id=? AND user_id=?",
            String.class, conversationId, principal.userId()).isEmpty();
        if (!member) throw hidden();
        boolean visible = !db.queryForList("""
            SELECT message_id FROM direct_message
            WHERE conversation_id=? AND message_id=? AND expires_at>CURRENT_TIMESTAMP(6) AND deleted_at IS NULL
            """, String.class, conversationId, messageId).isEmpty();
        if (!visible) throw hidden();
        return db.query("""
            SELECT revision,body,version_at FROM direct_message_revision
            WHERE message_id=? ORDER BY revision DESC LIMIT 50
            """, (rs, row) -> new RevisionEntry(rs.getLong("revision"), rs.getString("body"),
                rs.getTimestamp("version_at").getTime()), messageId);
    }

    private static boolean validUuid(String value) {
        if (value == null || value.length() > 36) return false;
        try { return UUID.fromString(value).toString().equalsIgnoreCase(value); }
        catch (IllegalArgumentException invalid) { return false; }
    }

    private GroupLock lockGroup(String conversationId) {
        GroupLock row = db.query("""
            SELECT conversation_kind,owner_user_id FROM direct_conversation WHERE id=? FOR UPDATE
            """, rs -> rs.next() ? new GroupLock(rs.getString("conversation_kind"), rs.getString("owner_user_id")) : null,
            conversationId);
        return row != null && "GROUP".equals(row.kind()) ? row : null;
    }

    private void lockActiveAccounts(List<String> users) {
        if (users.isEmpty()) throw hidden();
        String placeholders = String.join(",", Collections.nCopies(users.size(), "?"));
        Object[] parameters = users.toArray();
        List<String> locked = db.queryForList("SELECT id FROM app_user WHERE id IN (" + placeholders + ") ORDER BY id FOR UPDATE",
            String.class, parameters);
        int active = db.queryForObject("SELECT COUNT(*) FROM app_user WHERE id IN (" + placeholders
            + ") AND status='ACTIVE' AND deleted_at IS NULL", Integer.class, parameters);
        if (locked.size() != users.size() || active != users.size())
            throw new SpaceFailure(409, "GROUP_MEMBER_UNAVAILABLE", "참가자의 계정을 확인할 수 없어요.");
    }

    private boolean hasBlockedPair(List<String> users) {
        String placeholders = String.join(",", Collections.nCopies(users.size(), "?"));
        Object[] parameters = new Object[users.size() * 2];
        for (int index = 0; index < users.size(); index++) {
            parameters[index] = users.get(index);
            parameters[index + users.size()] = users.get(index);
        }
        return db.queryForObject("SELECT COUNT(*) FROM user_block WHERE blocker_user_id IN (" + placeholders
            + ") AND blocked_user_id IN (" + placeholders + ")", Integer.class, parameters) > 0;
    }

    private static SpaceFailure invalid() {
        return new SpaceFailure(400, "INVALID_DIRECT_MESSAGE", "메시지 대화 요청을 확인해 주세요.");
    }

    private static SpaceFailure hidden() {
        return new SpaceFailure(404, "DIRECT_CONVERSATION_NOT_FOUND", "대화를 찾을 수 없어요.");
    }
}
