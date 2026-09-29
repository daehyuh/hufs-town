package town.hufs.api.space;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import town.hufs.auth.TownPrincipal;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Durable, location-blind meetup requests for people who are not in the same live world. */
@RestController
@RequestMapping("/api/v1/me/join-requests")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
final class SocialJoinRequestsController {
    record RequestDraft(String conversationId, String destinationSpaceId, String message) {}
    record Decision(String decision) {}
    record JoinRequest(String id, String displayName, String message, String status,
                       long requestedAt, long expiresAt, String destinationSpaceId,
                       String destinationSpaceName) {}
    record RequestState(String id, String status, long requestedAt, long expiresAt) {}

    private static final Duration REQUEST_TTL = Duration.ofDays(7);
    private static final Duration REQUEST_COOLDOWN = Duration.ofSeconds(5);
    private static final int MAX_PENDING_INCOMING = 4;

    private final JdbcTemplate db;
    private final TransactionTemplate tx;

    SocialJoinRequestsController(JdbcTemplate db, TransactionTemplate tx) {
        this.db = db;
        this.tx = tx;
    }

    /** Approved requests remain available briefly so the recipient can follow the normal space admission flow. */
    @GetMapping
    List<JoinRequest> incoming(@AuthenticationPrincipal TownPrincipal principal) {
        String user = principal.userId();
        expireFor(user);
        return db.query("""
            SELECT request.id,request.message,request.status,request.created_at,request.expires_at,
                   sender.display_name,request.destination_space_id,request.destination_space_name
            FROM social_join_request request
            JOIN app_user sender ON sender.id=request.requester_user_id
              AND sender.status='ACTIVE' AND sender.deleted_at IS NULL
            WHERE request.target_user_id=? AND (
                (request.status='PENDING' AND request.expires_at>CURRENT_TIMESTAMP(6))
                OR (request.status='APPROVED' AND request.resolved_at>=CURRENT_TIMESTAMP(6)-INTERVAL 7 DAY)
              )
              AND NOT EXISTS (
                SELECT 1 FROM user_block block
                WHERE (block.blocker_user_id=request.requester_user_id AND block.blocked_user_id=request.target_user_id)
                   OR (block.blocker_user_id=request.target_user_id AND block.blocked_user_id=request.requester_user_id)
              )
            ORDER BY request.created_at DESC,request.id LIMIT 50
            """, (rs, row) -> new JoinRequest(rs.getString("id"), rs.getString("display_name"),
                rs.getString("message"), rs.getString("status"), rs.getTimestamp("created_at").getTime(),
                rs.getTimestamp("expires_at").getTime(), rs.getString("destination_space_id"),
                rs.getString("destination_space_name")), user);
    }

    /** Requester sees only their own recent requests and the other account's public display name. */
    @GetMapping("/outgoing")
    List<JoinRequest> outgoing(@AuthenticationPrincipal TownPrincipal principal) {
        String user = principal.userId();
        expireFor(user);
        return db.query("""
            SELECT request.id,request.message,request.status,request.created_at,request.expires_at,
                   recipient.display_name,request.destination_space_id,request.destination_space_name
            FROM social_join_request request
            JOIN app_user recipient ON recipient.id=request.target_user_id
              AND recipient.status='ACTIVE' AND recipient.deleted_at IS NULL
            WHERE request.requester_user_id=? AND request.created_at>=CURRENT_TIMESTAMP(6)-INTERVAL 7 DAY
            ORDER BY request.created_at DESC,request.id LIMIT 50
            """, (rs, row) -> new JoinRequest(rs.getString("id"), rs.getString("display_name"),
                rs.getString("message"), rs.getString("status"), rs.getTimestamp("created_at").getTime(),
                rs.getTimestamp("expires_at").getTime(), rs.getString("destination_space_id"),
                rs.getString("destination_space_name")), user);
    }

    @PostMapping
    RequestState create(@AuthenticationPrincipal TownPrincipal principal, @RequestBody RequestDraft draft) {
        if (draft == null || !validUuid(draft.conversationId()) || !validUuid(draft.destinationSpaceId()))
            throw invalid();
        String requester = principal.userId();
        String conversationId = UUID.fromString(draft.conversationId()).toString();
        String destinationSpaceId = UUID.fromString(draft.destinationSpaceId()).toString();
        String message = normalizeMessage(draft.message());
        return tx.execute(status -> {
            // Resolve the opaque selector server-side; group chats and conversations the caller left stay hidden.
            String target = directPeer(conversationId, requester);
            // Account-row locks serialize duplicate/cooldown checks without a race between API instances.
            List<String> locked = db.queryForList("""
                SELECT id FROM app_user WHERE id IN (?,?) ORDER BY id FOR UPDATE
                """, String.class, requester, target);
            if (locked.size() != 2) throw unavailable();
            active(requester);
            active(target);
            String destinationSpaceName = db.query("""
                SELECT space.name FROM town_space space
                JOIN space_member member ON member.space_id=space.id AND member.user_id=?
                WHERE space.id=? AND space.archived_at IS NULL FOR UPDATE
                """, rs -> rs.next() ? rs.getString(1) : null, requester, destinationSpaceId);
            if (destinationSpaceName == null) throw unavailable();
            expirePair(requester, target);
            if (blockedPair(requester, target)) throw unavailable();

            RequestState pending = db.query("""
                SELECT id,status,created_at,expires_at FROM social_join_request
                WHERE requester_user_id=? AND target_user_id=? AND status='PENDING'
                  AND expires_at>CURRENT_TIMESTAMP(6) FOR UPDATE
                """, rs -> rs.next() ? new RequestState(rs.getString("id"), rs.getString("status"),
                    rs.getTimestamp("created_at").getTime(), rs.getTimestamp("expires_at").getTime()) : null,
                requester, target);
            if (pending != null) return pending;

            if (db.queryForObject("""
                SELECT COUNT(*) FROM social_join_request WHERE requester_user_id=? AND status='PENDING'
                  AND expires_at>CURRENT_TIMESTAMP(6)
                """, Integer.class, requester) > 0)
                throw new SpaceFailure(409, "JOIN_REQUEST_PENDING", "이미 응답을 기다리는 합류 요청이 있어요.");

            Timestamp cooldown = db.query("""
                SELECT created_at FROM social_join_request WHERE requester_user_id=?
                  AND created_at>CURRENT_TIMESTAMP(6)-INTERVAL 5 SECOND
                ORDER BY created_at DESC LIMIT 1
                """, rs -> rs.next() ? rs.getTimestamp(1) : null, requester);
            if (cooldown != null && cooldown.toInstant().plus(REQUEST_COOLDOWN).isAfter(Instant.now()))
                throw new SpaceFailure(429, "JOIN_REQUEST_COOLDOWN", "잠시 기다렸다가 다시 요청해 주세요.");

            if (db.queryForObject("""
                SELECT COUNT(*) FROM social_join_request WHERE target_user_id=? AND status='PENDING'
                  AND expires_at>CURRENT_TIMESTAMP(6)
                """, Integer.class, target) >= MAX_PENDING_INCOMING)
                throw new SpaceFailure(409, "JOIN_REQUEST_BUSY", "상대가 확인 중인 요청이 많아요. 나중에 다시 요청해 주세요.");

            String id = UUID.randomUUID().toString();
            Timestamp now = Timestamp.from(Instant.now());
            Timestamp expires = Timestamp.from(now.toInstant().plus(REQUEST_TTL));
            db.update("""
                INSERT INTO social_join_request(id,requester_user_id,target_user_id,message,status,expires_at,
                    destination_space_id,destination_space_name)
                VALUES (?,?,?,?,'PENDING',?,?,?)
                """, id, requester, target, message, expires, destinationSpaceId, destinationSpaceName);
            return new RequestState(id, "PENDING", now.getTime(), expires.getTime());
        });
    }

    @PostMapping("/{requestId}/respond")
    Map<String, String> respond(@AuthenticationPrincipal TownPrincipal principal,
                                @PathVariable String requestId, @RequestBody Decision decision) {
        if (!validUuid(requestId) || decision == null
            || (!"APPROVE".equals(decision.decision()) && !"DECLINE".equals(decision.decision())))
            throw invalid();
        return tx.execute(status -> {
            RequestRow request = db.query("""
                SELECT id,requester_user_id,target_user_id,status,expires_at FROM social_join_request
                WHERE id=? AND target_user_id=? FOR UPDATE
                """, rs -> rs.next() ? new RequestRow(rs.getString("id"),rs.getString("requester_user_id"),
                    rs.getString("target_user_id"),rs.getString("status"),rs.getTimestamp("expires_at")) : null,
                requestId, principal.userId());
            if (request == null) throw unavailable();
            if (!"PENDING".equals(request.status()))
                throw new SpaceFailure(409, "JOIN_REQUEST_RESOLVED", "이미 처리된 합류 요청이에요.");
            if (!request.expiresAt().toInstant().isAfter(Instant.now())) {
                db.update("UPDATE social_join_request SET status='EXPIRED',resolved_at=CURRENT_TIMESTAMP(6) WHERE id=?", requestId);
                return Map.of("status", "EXPIRED");
            }
            active(request.requesterUserId());
            active(request.targetUserId());
            if (blockedPair(request.requesterUserId(), request.targetUserId())) throw unavailable();
            String next = "APPROVE".equals(decision.decision()) ? "APPROVED" : "DECLINED";
            db.update("UPDATE social_join_request SET status=?,resolved_at=CURRENT_TIMESTAMP(6) WHERE id=? AND status='PENDING'",
                next, requestId);
            // This is a consent/meetup signal only. A later explicit space invite/admission is required to move anyone.
            return Map.of("status", next);
        });
    }

    @PostMapping("/{requestId}/cancel")
    Map<String, Boolean> cancel(@AuthenticationPrincipal TownPrincipal principal, @PathVariable String requestId) {
        if (!validUuid(requestId)) throw invalid();
        int updated = db.update("""
            UPDATE social_join_request SET status='CANCELLED',resolved_at=CURRENT_TIMESTAMP(6)
            WHERE id=? AND requester_user_id=? AND status='PENDING' AND expires_at>CURRENT_TIMESTAMP(6)
            """, requestId, principal.userId());
        if (updated != 1) throw unavailable();
        return Map.of("cancelled", true);
    }

    private String directPeer(String conversationId, String requester) {
        List<String> peers = db.queryForList("""
            SELECT peer.user_id
            FROM direct_conversation conversation
            JOIN direct_conversation_member mine
              ON mine.conversation_id=conversation.id AND mine.user_id=?
            JOIN direct_conversation_member peer
              ON peer.conversation_id=conversation.id AND peer.user_id<>mine.user_id
            JOIN app_user account ON account.id=peer.user_id AND account.status='ACTIVE' AND account.deleted_at IS NULL
            WHERE conversation.id=? AND conversation.conversation_kind='DIRECT'
            ORDER BY peer.user_id FOR UPDATE
            """, String.class, requester, conversationId);
        if (peers.size() != 1 || requester.equals(peers.getFirst())) throw unavailable();
        return peers.getFirst();
    }

    private boolean blockedPair(String first, String second) {
        return db.queryForObject("""
            SELECT EXISTS (SELECT 1 FROM user_block WHERE (blocker_user_id=? AND blocked_user_id=?)
                OR (blocker_user_id=? AND blocked_user_id=?))
            """, Boolean.class, first, second, second, first);
    }

    private void active(String user) {
        if (db.queryForObject("SELECT COUNT(*) FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL",
            Integer.class, user) != 1) throw unavailable();
    }

    private void expireFor(String user) {
        db.update("""
            UPDATE social_join_request SET status='EXPIRED',resolved_at=CURRENT_TIMESTAMP(6)
            WHERE status='PENDING' AND expires_at<=CURRENT_TIMESTAMP(6)
              AND (requester_user_id=? OR target_user_id=?)
            """, user, user);
    }

    private void expirePair(String requester, String target) {
        db.update("""
            UPDATE social_join_request SET status='EXPIRED',resolved_at=CURRENT_TIMESTAMP(6)
            WHERE requester_user_id=? AND target_user_id=? AND status='PENDING'
              AND expires_at<=CURRENT_TIMESTAMP(6)
            """, requester, target);
    }

    private static String normalizeMessage(String value) {
        if (value == null) return "";
        String text = value.strip();
        if (text.codePointCount(0, text.length()) > 160 || text.codePoints().anyMatch(Character::isISOControl))
            throw invalid();
        return text;
    }

    private static boolean validUuid(String value) {
        if (value == null || value.length() > 36) return false;
        try { return UUID.fromString(value).toString().equalsIgnoreCase(value); }
        catch (IllegalArgumentException invalid) { return false; }
    }

    private static SpaceFailure invalid() {
        return new SpaceFailure(400, "JOIN_REQUEST_INVALID", "합류 요청 정보를 확인해 주세요.");
    }

    private static SpaceFailure unavailable() {
        return new SpaceFailure(404, "JOIN_REQUEST_UNAVAILABLE", "요청할 수 있는 참가자를 찾지 못했어요.");
    }

    private record RequestRow(String id, String requesterUserId, String targetUserId, String status,
                              Timestamp expiresAt) {}
}
