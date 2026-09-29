package town.hufs.api.auth;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import town.hufs.auth.TownPrincipal;

import java.sql.Timestamp;
import java.text.Normalizer;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Account-scoped friend requests; location is never exposed by this API. */
@RestController
@RequestMapping("/api/v1/me/friends")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
final class UserFriendsController {
    record Friend(String userId, String displayName, Instant since, boolean online) {}
    private record FriendRow(String userId, String displayName, Instant since, boolean sharesPresence) {}
    record FriendRequest(String id, String userId, String displayName, Instant requestedAt) {}
    record Overview(List<Friend> friends, List<FriendRequest> incoming, List<FriendRequest> outgoing) {}
    record RequestDraft(String targetUserId) {}
    record RequestState(String id, String status, Instant requestedAt) {}
    record Decision(String decision) {}
    record Preferences(boolean allowFriendRequests, Boolean allowFriendNotifications,
                       Boolean sharePresenceWithFriends) {}
    enum FriendSearchRelationship { FRIEND, INCOMING, OUTGOING, COOLDOWN, AVAILABLE, UNAVAILABLE }
    record FriendSearchResult(String userId, String displayName, FriendSearchRelationship relationship) {}

    private static final int MAX_PENDING_REQUESTS = 50;
    private static final int MAX_REQUESTS_PER_MINUTE = 20;
    private static final int MAX_SEARCHES_PER_MINUTE = 60;
    private static final DefaultRedisScript<Long> REQUEST_LIMIT = new DefaultRedisScript<>(
        "local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000); " +
            "local window=tonumber(ARGV[1]); redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-window); " +
            "local count=tonumber(redis.call('ZCARD',KEYS[1])); if count>=tonumber(ARGV[2]) then return count+1 end; " +
            "redis.call('ZADD',KEYS[1],now,ARGV[3]); redis.call('PEXPIRE',KEYS[1],window); return count+1", Long.class);
    private static final DefaultRedisScript<Long> SEARCH_LIMIT = new DefaultRedisScript<>(
        "local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000); " +
            "local window=tonumber(ARGV[1]); redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-window); " +
            "local count=tonumber(redis.call('ZCARD',KEYS[1])); if count>=tonumber(ARGV[2]) then return count+1 end; " +
            "redis.call('ZADD',KEYS[1],now,ARGV[3]); redis.call('PEXPIRE',KEYS[1],window); return count+1", Long.class);
    private static final DefaultRedisScript<Long> SHARED_ONLINE_COUNT = new DefaultRedisScript<>(
        "local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000); " +
            "return redis.call('ZCOUNT',KEYS[1],now,'+inf')", Long.class);

    private final JdbcTemplate db;
    private final TransactionTemplate transactions;
    private final StringRedisTemplate redis;

    UserFriendsController(JdbcTemplate db, TransactionTemplate transactions, StringRedisTemplate redis) {
        this.db = db;
        this.transactions = transactions;
        this.redis = redis;
    }

    @GetMapping
    Overview overview(@AuthenticationPrincipal TownPrincipal principal) {
        String user = principal.userId();
        List<FriendRow> rows = db.query("""
            SELECT account.id,account.display_name,friendship.resolved_at,
              COALESCE(preference.share_presence_with_friends,FALSE) AS shares_presence
            FROM user_friendship friendship
            JOIN app_user account ON account.id=IF(friendship.user_a_id=?,friendship.user_b_id,friendship.user_a_id)
              AND account.status='ACTIVE' AND account.deleted_at IS NULL
            LEFT JOIN user_social_preference preference ON preference.user_id=account.id
            WHERE friendship.status='ACCEPTED' AND (friendship.user_a_id=? OR friendship.user_b_id=?)
              AND NOT EXISTS (SELECT 1 FROM user_block block WHERE
                (block.blocker_user_id=? AND block.blocked_user_id=account.id)
                OR (block.blocker_user_id=account.id AND block.blocked_user_id=?))
            ORDER BY account.display_name,account.id LIMIT 500
            """, (rs, row) -> new FriendRow(rs.getString("id"), rs.getString("display_name"),
                instant(rs.getTimestamp("resolved_at")), rs.getBoolean("shares_presence")),
            user, user, user, user, user);
        List<Friend> friends = rows.stream().map(friend -> new Friend(friend.userId(), friend.displayName(),
            friend.since(), friend.sharesPresence() && sharedOnline(friend.userId()))).toList();
        return new Overview(friends, requests(user, true), requests(user, false));
    }

    @GetMapping("/search")
    List<FriendSearchResult> search(@AuthenticationPrincipal TownPrincipal principal,
                                    @RequestParam(name = "q") String query) {
        String prefix = query == null ? "" : Normalizer.normalize(query.strip(), Normalizer.Form.NFC);
        int codePoints = prefix.codePointCount(0, prefix.length());
        if (codePoints < 2 || codePoints > 32) throw invalid();

        enforceSearchRateLimit(principal.userId());
        String escapedPrefix = prefix.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
        String viewer = principal.userId();
        return db.query("""
            SELECT account.id,account.display_name,
              CASE
                WHEN friendship.status='ACCEPTED' THEN 'FRIEND'
                WHEN friendship.status='PENDING' AND friendship.requested_by_user_id=? THEN 'OUTGOING'
                WHEN friendship.status='PENDING' THEN 'INCOMING'
                WHEN friendship.status='DECLINED' AND friendship.requested_by_user_id=?
                  AND friendship.resolved_at>CURRENT_TIMESTAMP(6)-INTERVAL 24 HOUR THEN 'COOLDOWN'
                WHEN COALESCE(preference.allow_friend_requests,TRUE)=FALSE THEN 'UNAVAILABLE'
                ELSE 'AVAILABLE'
              END AS relationship
            FROM app_user account
            LEFT JOIN user_friendship friendship
              ON ((friendship.user_a_id=? AND friendship.user_b_id=account.id)
                OR (friendship.user_b_id=? AND friendship.user_a_id=account.id))
            LEFT JOIN user_social_preference preference ON preference.user_id=account.id
            WHERE account.status='ACTIVE' AND account.deleted_at IS NULL AND account.id<>?
              AND account.display_name LIKE ? ESCAPE '!'
              AND NOT EXISTS (SELECT 1 FROM user_block block WHERE
                (block.blocker_user_id=? AND block.blocked_user_id=account.id)
                OR (block.blocker_user_id=account.id AND block.blocked_user_id=?))
            ORDER BY account.display_name,account.id LIMIT 20
            """, (rs, row) -> new FriendSearchResult(rs.getString("id"), rs.getString("display_name"),
                FriendSearchRelationship.valueOf(rs.getString("relationship"))),
            viewer, viewer, viewer, viewer, viewer, escapedPrefix, viewer, viewer);
    }

    @PostMapping("/requests")
    RequestState request(@AuthenticationPrincipal TownPrincipal principal, @RequestBody RequestDraft draft) {
        String requester = principal.userId();
        String target = draft == null ? null : canonicalUuid(draft.targetUserId());
        if (target == null || requester.equals(target)) throw invalid();
        enforceRequestRateLimit(requester);
        String first = requester.compareTo(target) < 0 ? requester : target;
        String second = requester.compareTo(target) < 0 ? target : requester;

        return transactions.execute(status -> {
            List<String> activeUsers = db.queryForList("""
                SELECT id FROM app_user WHERE id IN (?,?) AND status='ACTIVE' AND deleted_at IS NULL
                ORDER BY id FOR UPDATE
                """, String.class, first, second);
            if (activeUsers.size() != 2 || blockedPair(requester, target)) throw unavailable();

            Existing existing = db.query("""
                SELECT friendship_id,requested_by_user_id,status,created_at,resolved_at
                FROM user_friendship WHERE user_a_id=? AND user_b_id=? FOR UPDATE
                """, rs -> rs.next() ? new Existing(rs.getString("friendship_id"), rs.getString("requested_by_user_id"),
                    rs.getString("status"), rs.getTimestamp("created_at"), rs.getTimestamp("resolved_at")) : null,
                first, second);
            if (existing == null) {
                if (!allowsRequests(target)) throw unavailable();
                enforcePendingLimit(requester);
                String id = UUID.randomUUID().toString();
                db.update("""
                    INSERT INTO user_friendship(friendship_id,user_a_id,user_b_id,requested_by_user_id,status)
                    VALUES (?,?,?,?, 'PENDING')
                    """, id, first, second, requester);
                enqueueFriendNotification(id, target, requester, "FRIEND_REQUEST");
                return new RequestState(id, "PENDING", Instant.now());
            }
            if ("ACCEPTED".equals(existing.status())) return new RequestState(existing.id(), "ACCEPTED", instant(existing.createdAt()));
            if ("PENDING".equals(existing.status())) {
                if (requester.equals(existing.requestedBy()))
                    return new RequestState(existing.id(), "PENDING", instant(existing.createdAt()));
                db.update("UPDATE user_friendship SET status='ACCEPTED',resolved_at=CURRENT_TIMESTAMP(6) WHERE friendship_id=?",
                    existing.id());
                enqueueFriendNotification(existing.id(), existing.requestedBy(), requester, "FRIEND_ACCEPTED");
                return new RequestState(existing.id(), "ACCEPTED", Instant.now());
            }
            if ("DECLINED".equals(existing.status()) && requester.equals(existing.requestedBy())
                && existing.resolvedAt() != null && declineCooldownActive(existing.resolvedAt()))
                throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "거절한 상대에게 다시 요청하려면 24시간 기다려 주세요.");
            String id = existing.id();
            if (!allowsRequests(target)) throw unavailable();
            enforcePendingLimit(requester);
            String nextId = UUID.randomUUID().toString();
            db.update("DELETE FROM social_push_outbox WHERE friendship_id=?", id);
            db.update("""
                UPDATE user_friendship SET friendship_id=?,requested_by_user_id=?,status='PENDING',created_at=CURRENT_TIMESTAMP(6),resolved_at=NULL
                WHERE friendship_id=?
                """, nextId, requester, id);
            return new RequestState(nextId, "PENDING", Instant.now());
        });
    }

    @PostMapping("/requests/{requestId}/respond")
    Map<String, String> respond(@AuthenticationPrincipal TownPrincipal principal, @PathVariable String requestId,
                                @RequestBody Decision decision) {
        String normalizedRequestId = canonicalUuid(requestId);
        if (normalizedRequestId == null || decision == null
            || (!"ACCEPT".equals(decision.decision()) && !"DECLINE".equals(decision.decision()))) throw invalid();
        return transactions.execute(status -> {
            Existing request = db.query("""
                SELECT friendship_id,requested_by_user_id,status,created_at,resolved_at
                FROM user_friendship WHERE friendship_id=?
                  AND (user_a_id=? OR user_b_id=?) FOR UPDATE
                """, rs -> rs.next() ? new Existing(rs.getString("friendship_id"), rs.getString("requested_by_user_id"),
                    rs.getString("status"), rs.getTimestamp("created_at"), rs.getTimestamp("resolved_at")) : null,
                normalizedRequestId, principal.userId(), principal.userId());
            if (request == null) throw unavailable();
            if (!"PENDING".equals(request.status()) || principal.userId().equals(request.requestedBy()))
                throw new ResponseStatusException(HttpStatus.CONFLICT, "처리할 수 있는 친구 요청이 아니에요.");
            String requester = request.requestedBy();
            if (blockedPair(requester, principal.userId())) throw unavailable();
            if ("ACCEPT".equals(decision.decision())) {
                db.update("UPDATE user_friendship SET status='ACCEPTED',resolved_at=CURRENT_TIMESTAMP(6) WHERE friendship_id=?", normalizedRequestId);
                enqueueFriendNotification(normalizedRequestId, requester, principal.userId(), "FRIEND_ACCEPTED");
            } else {
                db.update("UPDATE user_friendship SET status='DECLINED',resolved_at=CURRENT_TIMESTAMP(6) WHERE friendship_id=?", normalizedRequestId);
            }
            return Map.of("status", "ACCEPT".equals(decision.decision()) ? "ACCEPTED" : "DECLINED");
        });
    }

    @DeleteMapping("/requests/{requestId}")
    Map<String, Boolean> cancel(@AuthenticationPrincipal TownPrincipal principal, @PathVariable String requestId) {
        String normalizedRequestId = canonicalUuid(requestId);
        if (normalizedRequestId == null) throw invalid();
        int removed = db.update("""
            UPDATE user_friendship SET status='CANCELLED',resolved_at=CURRENT_TIMESTAMP(6)
            WHERE friendship_id=? AND requested_by_user_id=? AND status='PENDING'
            """, normalizedRequestId, principal.userId());
        if (removed != 1) throw unavailable();
        return Map.of("cancelled", true);
    }

    @DeleteMapping("/{friendUserId}")
    Map<String, Boolean> remove(@AuthenticationPrincipal TownPrincipal principal, @PathVariable String friendUserId) {
        String friend = canonicalUuid(friendUserId);
        if (friend == null || friend.equals(principal.userId())) throw invalid();
        String first = principal.userId().compareTo(friend) < 0 ? principal.userId() : friend;
        String second = principal.userId().compareTo(friend) < 0 ? friend : principal.userId();
        return transactions.execute(status -> {
            List<String> activeUsers = db.queryForList("""
                SELECT id FROM app_user WHERE id IN (?,?) AND status='ACTIVE' AND deleted_at IS NULL
                ORDER BY id FOR UPDATE
                """, String.class, first, second);
            if (activeUsers.size() != 2) throw unavailable();
            int deleted = db.update("DELETE FROM user_friendship WHERE user_a_id=? AND user_b_id=? AND status='ACCEPTED'",
                first, second);
            if (deleted != 1) throw unavailable();
            return Map.of("removed", true);
        });
    }

    @GetMapping("/preferences")
    Preferences preferences(@AuthenticationPrincipal TownPrincipal principal) {
        String user = principal.userId();
        return new Preferences(friendRequestsAllowed(user), friendNotificationsAllowed(user), sharePresenceWithFriends(user));
    }

    @PutMapping("/preferences")
    Preferences updatePreferences(@AuthenticationPrincipal TownPrincipal principal, @RequestBody Preferences preferences) {
        if (preferences == null) throw invalid();
        boolean allowFriendNotifications = preferences.allowFriendNotifications() == null
            ? friendNotificationsAllowed(principal.userId())
            : preferences.allowFriendNotifications();
        boolean sharePresence = preferences.sharePresenceWithFriends() == null
            ? sharePresenceWithFriends(principal.userId())
            : preferences.sharePresenceWithFriends();
        Preferences updated = new Preferences(preferences.allowFriendRequests(), allowFriendNotifications, sharePresence);
        db.update("""
            INSERT INTO user_social_preference(user_id,allow_friend_requests,allow_friend_notifications,share_presence_with_friends)
            VALUES (?,?,?,?)
            ON DUPLICATE KEY UPDATE allow_friend_requests=VALUES(allow_friend_requests),
                allow_friend_notifications=VALUES(allow_friend_notifications),
                share_presence_with_friends=VALUES(share_presence_with_friends),updated_at=CURRENT_TIMESTAMP(6)
            """, principal.userId(), updated.allowFriendRequests(), updated.allowFriendNotifications(), updated.sharePresenceWithFriends());
        return updated;
    }

    private void enqueueFriendNotification(String friendshipId, String recipient, String actor, String eventType) {
        if (!friendNotificationsAllowed(recipient)) return;
        db.update("""
            INSERT INTO social_push_outbox(id,friendship_id,event_type,recipient_user_id,actor_user_id)
            VALUES (?,?,?,?,?)
            """, UUID.randomUUID().toString(), friendshipId, eventType, recipient, actor);
    }

    private List<FriendRequest> requests(String user, boolean incoming) {
        String direction = incoming ? " friendship.requested_by_user_id<>?" : " friendship.requested_by_user_id=?";
        String accountExpression = incoming
            ? "friendship.requested_by_user_id"
            : "IF(friendship.requested_by_user_id=friendship.user_a_id,friendship.user_b_id,friendship.user_a_id)";
        return db.query("""
            SELECT friendship.friendship_id,account.id,account.display_name,friendship.created_at
            FROM user_friendship friendship
            JOIN app_user account ON account.id=""" + accountExpression + """
              AND account.status='ACTIVE' AND account.deleted_at IS NULL
            WHERE (friendship.user_a_id=? OR friendship.user_b_id=?)
              AND friendship.status='PENDING' AND """ + direction + """
              AND NOT EXISTS (SELECT 1 FROM user_block block WHERE
                (block.blocker_user_id=? AND block.blocked_user_id=account.id)
                OR (block.blocker_user_id=account.id AND block.blocked_user_id=?))
            ORDER BY friendship.created_at,friendship.friendship_id LIMIT 100
            """, (rs, row) -> new FriendRequest(rs.getString("friendship_id"), rs.getString("id"),
                rs.getString("display_name"), instant(rs.getTimestamp("created_at"))),
            user, user, user, user, user);
    }

    private boolean allowsRequests(String user) {
        return friendRequestsAllowed(user);
    }

    private boolean declineCooldownActive(Timestamp resolvedAt) {
        return Boolean.TRUE.equals(db.queryForObject("""
            SELECT ? > CURRENT_TIMESTAMP(6) - INTERVAL 24 HOUR
            """, Boolean.class, resolvedAt));
    }

    private void enforceRequestRateLimit(String requester) {
        String key = "hufs-town:friend-request-limit:" + requester;
        Long attempt = redis.execute(REQUEST_LIMIT, List.of(key), "60000", Integer.toString(MAX_REQUESTS_PER_MINUTE),
            UUID.randomUUID().toString());
        if (attempt == null || attempt > MAX_REQUESTS_PER_MINUTE)
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                "최근 60초 동안 친구 요청은 20회까지 보낼 수 있어요. 잠시 후 다시 시도해 주세요.");
    }

    private void enforceSearchRateLimit(String requester) {
        String key = "hufs-town:friend-search-limit:" + requester;
        Long attempt = redis.execute(SEARCH_LIMIT, List.of(key), "60000", Integer.toString(MAX_SEARCHES_PER_MINUTE),
            UUID.randomUUID().toString());
        if (attempt == null || attempt > MAX_SEARCHES_PER_MINUTE)
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                "최근 60초 동안 친구 계정 검색은 60회까지 할 수 있어요. 잠시 후 다시 시도해 주세요.");
    }

    private void enforcePendingLimit(String requester) {
        List<String> pending = db.queryForList("""
            SELECT friendship_id FROM user_friendship
            WHERE requested_by_user_id=? AND status='PENDING'
            LIMIT 50 FOR UPDATE
            """, String.class, requester);
        if (pending.size() >= MAX_PENDING_REQUESTS)
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                "대기 중인 친구 요청은 최대 50개까지 보낼 수 있어요.");
    }

    private boolean friendRequestsAllowed(String user) {
        return Boolean.TRUE.equals(db.queryForObject("""
            SELECT COALESCE((SELECT allow_friend_requests FROM user_social_preference WHERE user_id=?),TRUE)
            """, Boolean.class, user));
    }

    private boolean friendNotificationsAllowed(String user) {
        return Boolean.TRUE.equals(db.queryForObject("""
            SELECT COALESCE((SELECT allow_friend_notifications FROM user_social_preference WHERE user_id=?),TRUE)
            """, Boolean.class, user));
    }

    private boolean sharePresenceWithFriends(String user) {
        return Boolean.TRUE.equals(db.queryForObject("""
            SELECT COALESCE((SELECT share_presence_with_friends FROM user_social_preference WHERE user_id=?),FALSE)
            """, Boolean.class, user));
    }

    private boolean sharedOnline(String user) {
        Long count = redis.execute(SHARED_ONLINE_COUNT, List.of("hufs-town:presence:shared:" + user));
        return count != null && count > 0;
    }

    private boolean blockedPair(String first, String second) {
        return db.queryForObject("""
            SELECT EXISTS (SELECT 1 FROM user_block WHERE (blocker_user_id=? AND blocked_user_id=?)
                OR (blocker_user_id=? AND blocked_user_id=?))
            """, Boolean.class, first, second, second, first);
    }

    private static String canonicalUuid(String value) {
        if (!validUuid(value)) return null;
        return UUID.fromString(value).toString();
    }

    private static boolean validUuid(String value) {
        if (value == null || value.length() > 36) return false;
        try { return UUID.fromString(value).toString().equalsIgnoreCase(value); }
        catch (IllegalArgumentException invalid) { return false; }
    }

    private static Instant instant(Timestamp timestamp) {
        return timestamp == null ? Instant.EPOCH : timestamp.toInstant();
    }

    private static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, "친구 요청 정보를 확인해 주세요.");
    }

    private static ResponseStatusException unavailable() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "요청할 수 있는 계정을 찾지 못했어요.");
    }

    private record Existing(String id, String requestedBy, String status, Timestamp createdAt, Timestamp resolvedAt) {}
}
