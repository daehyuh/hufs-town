package town.hufs.api.space;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import town.hufs.api.calendar.CalendarSyncOutbox;
import town.hufs.auth.TownPrincipal;

import java.sql.Timestamp;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/spaces/{spaceId}/scheduled-events")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class ScheduledEventsController {
    private static final DefaultRedisScript<Long> LIMIT = new DefaultRedisScript<>(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", Long.class);
    private static final Duration MIN_LEAD = Duration.ofMinutes(1);
    private static final Duration MAX_LEAD = Duration.ofDays(365);
    private static final Duration MAX_EVENT = Duration.ofHours(12);
    private static final String EVENT_SELECT = """
        SELECT e.id,e.title,e.description,e.instructions,e.resource_url,e.starts_at,e.ends_at,e.cancelled_at,e.created_at,e.updated_at,
               COALESCE(counts.going_count,0) AS going_count,
               COALESCE(counts.interested_count,0) AS interested_count,
               COALESCE(counts.declined_count,0) AS declined_count,
               COALESCE(mine.response,'') AS my_response
        FROM town_scheduled_event e
        LEFT JOIN (
            SELECT event_id,SUM(response='GOING') AS going_count,
                   SUM(response='INTERESTED') AS interested_count,
                   SUM(response='DECLINED') AS declined_count
            FROM town_scheduled_event_rsvp GROUP BY event_id
        ) counts ON counts.event_id=e.id
        LEFT JOIN town_scheduled_event_rsvp mine ON mine.event_id=e.id AND mine.user_id=?
        """;

    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final StringRedisTemplate redis;
    private final Spaces spaces;
    private final CalendarSyncOutbox calendarSync;

    ScheduledEventsController(JdbcTemplate db, TransactionTemplate tx, StringRedisTemplate redis, Spaces spaces,
                              CalendarSyncOutbox calendarSync) {
        this.db = db;
        this.tx = tx;
        this.redis = redis;
        this.spaces = spaces;
        this.calendarSync = calendarSync;
    }

    @GetMapping
    List<ScheduledEvent> list(@PathVariable String spaceId, @AuthenticationPrincipal TownPrincipal principal) {
        String userId = userId(principal);
        requireReadable(spaceId, userId);
        return db.query(EVENT_SELECT + """
            WHERE e.space_id=? AND (
                (e.cancelled_at IS NULL AND e.starts_at>=CURRENT_TIMESTAMP(6)-INTERVAL 1 DAY)
                OR e.cancelled_at>=CURRENT_TIMESTAMP(6)-INTERVAL 30 DAY
            )
            ORDER BY (e.cancelled_at IS NOT NULL),e.starts_at,e.created_at DESC
            LIMIT 50
            """, (r, n) -> view(r), userId, spaceId);
    }

    @PostMapping
    ScheduledEvent create(@PathVariable String spaceId, @AuthenticationPrincipal TownPrincipal principal,
                          @RequestBody EventDraft draft) {
        rateLimit(principal);
        String userId = userId(principal);
        Normalized value = normalize(draft, Instant.now());
        return tx.execute(status -> {
            lockManagerSpace(spaceId, userId);
            Integer upcoming = db.queryForObject("""
                SELECT COUNT(*) FROM town_scheduled_event
                WHERE space_id=? AND cancelled_at IS NULL AND starts_at>CURRENT_TIMESTAMP(6)
                """, Integer.class, spaceId);
            if (upcoming != null && upcoming >= 50)
                throw new SpaceFailure(409, "EVENT_LIMIT", "공간의 예정 행사는 최대 50개까지 등록할 수 있어요.");
            Integer daily = db.queryForObject("""
                SELECT COUNT(*) FROM town_scheduled_event
                WHERE created_by=? AND created_at>=CURRENT_TIMESTAMP(6)-INTERVAL 1 DAY
                """, Integer.class, userId);
            if (daily != null && daily >= 10)
                throw new SpaceFailure(429, "EVENT_RATE_LIMIT", "하루에 등록할 수 있는 행사는 10개예요.");
            String id = UUID.randomUUID().toString();
            db.update("""
                INSERT INTO town_scheduled_event(id,space_id,created_by,title,description,instructions,resource_url,starts_at,ends_at)
                VALUES (?,?,?,?,?,?,?,?,?)
                """, id, spaceId, userId, value.title(), value.description(), value.instructions(), value.resourceUrl(),
                Timestamp.from(value.startsAt()), value.endsAt() == null ? null : Timestamp.from(value.endsAt()));
            return find(spaceId, id, userId);
        });
    }

    @PatchMapping("/{eventId}")
    ScheduledEvent update(@PathVariable String spaceId, @PathVariable String eventId,
                          @AuthenticationPrincipal TownPrincipal principal, @RequestBody EventDraft draft) {
        rateLimit(principal);
        String userId = userId(principal);
        Normalized value = normalize(draft, Instant.now());
        return tx.execute(status -> {
            lockManagerSpace(spaceId, userId);
            EventLock current = lockEvent(spaceId, eventId);
            if (current.cancelled())
                throw new SpaceFailure(409, "EVENT_CANCELLED", "취소된 행사는 수정할 수 없어요.");
            int updated = db.update("""
                UPDATE town_scheduled_event SET title=?,description=?,instructions=?,resource_url=?,starts_at=?,ends_at=?
                WHERE id=? AND space_id=? AND cancelled_at IS NULL AND starts_at>CURRENT_TIMESTAMP(6)
                """, value.title(), value.description(), value.instructions(), value.resourceUrl(),
                Timestamp.from(value.startsAt()), value.endsAt() == null ? null : Timestamp.from(value.endsAt()),
                eventId, spaceId);
            if (updated != 1) throw new SpaceFailure(409, "EVENT_STARTED", "이미 시작한 행사는 수정할 수 없어요.");
            calendarSync.enqueueGoingAttendees(eventId, "UPSERT");
            return find(spaceId, eventId, userId);
        });
    }

    @DeleteMapping("/{eventId}")
    ScheduledEvent cancel(@PathVariable String spaceId, @PathVariable String eventId,
                          @AuthenticationPrincipal TownPrincipal principal) {
        rateLimit(principal);
        String userId = userId(principal);
        return tx.execute(status -> {
            lockManagerSpace(spaceId, userId);
            EventLock current = lockEvent(spaceId, eventId);
            if (current.cancelled()) return find(spaceId, eventId, userId);
            int cancelled = db.update("""
                UPDATE town_scheduled_event SET cancelled_at=CURRENT_TIMESTAMP(6)
                WHERE id=? AND space_id=? AND cancelled_at IS NULL AND starts_at>CURRENT_TIMESTAMP(6)
                """, eventId, spaceId);
            if (cancelled != 1) throw new SpaceFailure(409, "EVENT_STARTED", "이미 시작한 행사는 취소할 수 없어요.");
            calendarSync.enqueueGoingAttendees(eventId, "DELETE");
            return find(spaceId, eventId, userId);
        });
    }

    @PutMapping("/{eventId}/rsvp")
    ScheduledEvent respond(@PathVariable String spaceId, @PathVariable String eventId,
                           @AuthenticationPrincipal TownPrincipal principal, @RequestBody RsvpDraft draft) {
        rateLimit(principal);
        String userId = userId(principal);
        String response = draft == null || draft.response() == null ? "" : draft.response().strip().toUpperCase(java.util.Locale.ROOT);
        if (!Set.of("GOING", "INTERESTED", "DECLINED").contains(response))
            throw new SpaceFailure(400, "RSVP_INVALID", "참석 응답을 선택해 주세요.");
        return tx.execute(status -> {
            requireReadable(spaceId, userId);
            EventLock event = lockEvent(spaceId, eventId);
            if (event.cancelled() || !event.startsAt().isAfter(Instant.now()))
                throw new SpaceFailure(409, "RSVP_CLOSED", "시작했거나 취소된 행사는 참석 응답을 바꿀 수 없어요.");
            db.update("""
                INSERT INTO town_scheduled_event_rsvp(event_id,user_id,response)
                VALUES (?,?,?)
                ON DUPLICATE KEY UPDATE response=VALUES(response),responded_at=CURRENT_TIMESTAMP(6)
                """, eventId, userId, response);
            calendarSync.enqueue(userId, "SCHEDULED_EVENT", eventId,
                "GOING".equals(response) ? "UPSERT" : "DELETE");
            return find(spaceId, eventId, userId);
        });
    }

    @DeleteMapping("/{eventId}/rsvp")
    ScheduledEvent clearResponse(@PathVariable String spaceId, @PathVariable String eventId,
                                 @AuthenticationPrincipal TownPrincipal principal) {
        rateLimit(principal);
        String userId = userId(principal);
        return tx.execute(status -> {
            requireReadable(spaceId, userId);
            lockEvent(spaceId, eventId);
            db.update("DELETE FROM town_scheduled_event_rsvp WHERE event_id=? AND user_id=?", eventId, userId);
            calendarSync.enqueue(userId, "SCHEDULED_EVENT", eventId, "DELETE");
            return find(spaceId, eventId, userId);
        });
    }

    private void rateLimit(TownPrincipal principal) {
        String userId = userId(principal);
        Long count = redis.execute(LIMIT, List.of("hufs-town:event-schedule-limit:" + userId));
        if (count == null || count > 60)
            throw new SpaceFailure(429, "SPACE_RATE_LIMIT", "요청이 많아요. 잠시 뒤 다시 시도해 주세요.");
    }

    private String userId(TownPrincipal principal) {
        if (principal == null) throw new SpaceFailure(401, "AUTH_REQUIRED", "로그인이 필요해요.");
        return principal.userId();
    }

    private void requireReadable(String spaceId, String userId) {
        spaces.detail(spaceId, userId);
    }

    private void lockManagerSpace(String spaceId, String userId) {
        requireSpaceId(spaceId);
        active(userId);
        if (db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE", String.class, spaceId).isEmpty())
            throw hidden();
        if (db.queryForObject("SELECT COUNT(*) FROM space_access_block WHERE space_id=? AND user_id=?",
            Integer.class, spaceId, userId) > 0) throw hidden();
        List<Boolean> manager = db.query("""
            SELECT (role='OWNER' OR manager=TRUE) AS can_manage
            FROM space_member WHERE space_id=? AND user_id=? FOR UPDATE
            """, (r, n) -> r.getBoolean("can_manage"), spaceId, userId);
        if (manager.isEmpty() || !manager.getFirst())
            throw new SpaceFailure(403, "EVENT_FORBIDDEN", "공간 운영자만 행사를 관리할 수 있어요.");
    }

    private EventLock lockEvent(String spaceId, String eventId) {
        requireUuid(eventId);
        return db.query("""
            SELECT starts_at,cancelled_at
            FROM town_scheduled_event WHERE space_id=? AND id=? FOR UPDATE
            """, (r, n) -> new EventLock(r.getTimestamp("cancelled_at") != null, r.getTimestamp("starts_at").toInstant()), spaceId, eventId)
            .stream().findFirst().orElseThrow(ScheduledEventsController::hidden);
    }

    private ScheduledEvent find(String spaceId, String eventId, String userId) {
        return db.query(EVENT_SELECT + " WHERE e.space_id=? AND e.id=?",
            (r, n) -> view(r), userId, spaceId, eventId)
            .stream().findFirst().orElseThrow(ScheduledEventsController::hidden);
    }

    private static Normalized normalize(EventDraft draft, Instant now) {
        if (draft == null) throw invalid();
        String title = text(draft.title(), 80, false);
        String description = text(draft.description(), 280, true);
        String instructions = text(draft.instructions(), 500, true);
        String resourceUrl = text(draft.resourceUrl(), 512, true);
        if (!resourceUrl.isEmpty() && !resourceUrl.matches("(?i)https://[^\\s]+")) throw invalid();
        Instant startsAt = instant(draft.startsAt());
        if (startsAt.isBefore(now.plus(MIN_LEAD)) || startsAt.isAfter(now.plus(MAX_LEAD)))
            throw new SpaceFailure(400, "EVENT_TIME_INVALID", "행사 시작은 1분 이후부터 1년 안으로 지정해 주세요.");
        Instant endsAt = draft.endsAt() == null || draft.endsAt().isBlank() ? null : instant(draft.endsAt());
        if (endsAt != null && (endsAt.isBefore(startsAt.plusSeconds(60)) || endsAt.isAfter(startsAt.plus(MAX_EVENT))))
            throw new SpaceFailure(400, "EVENT_TIME_INVALID", "종료 시각은 시작 뒤 1분~12시간 사이로 지정해 주세요.");
        return new Normalized(title, description, instructions, resourceUrl, startsAt, endsAt);
    }

    private static Instant instant(String value) {
        try { return Instant.parse(value); }
        catch (RuntimeException invalid) { throw new SpaceFailure(400, "EVENT_TIME_INVALID", "행사 날짜와 시간을 확인해 주세요."); }
    }

    private static String text(String value, int max, boolean emptyAllowed) {
        String normalized = value == null ? "" : value.strip();
        boolean invalidChar = normalized.codePoints().anyMatch(ch ->
            (Character.isISOControl(ch) && ch != '\n' && ch != '\r' && ch != '\t')
                || Character.getType(ch) == Character.FORMAT);
        if ((!emptyAllowed && normalized.isEmpty()) || normalized.codePointCount(0, normalized.length()) > max || invalidChar)
            throw invalid();
        return normalized;
    }

    private static ScheduledEvent view(ResultSet row) throws SQLException {
        return new ScheduledEvent(row.getString("id"), row.getString("title"), row.getString("description"),
            row.getString("instructions"), row.getString("resource_url"), instant(row.getTimestamp("starts_at")),
            instant(row.getTimestamp("ends_at")), row.getTimestamp("cancelled_at") != null,
            instant(row.getTimestamp("created_at")), instant(row.getTimestamp("updated_at")),
            row.getLong("going_count"), row.getLong("interested_count"), row.getLong("declined_count"),
            row.getString("my_response"));
    }

    private static String instant(Timestamp value) { return value == null ? "" : value.toInstant().toString(); }
    private void active(String userId) {
        Integer count = db.queryForObject("SELECT COUNT(*) FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL",
            Integer.class, userId);
        if (count == null || count != 1)
            throw new SpaceFailure(403, "ACCOUNT_UNAVAILABLE", "이 계정으로 행사를 이용할 수 없어요.");
    }
    private static void requireSpaceId(String value) { requireUuid(value); }
    private static void requireUuid(String value) {
        try {
            if (!UUID.fromString(value).toString().equalsIgnoreCase(value)) throw hidden();
        } catch (RuntimeException invalid) {
            throw hidden();
        }
    }
    private static SpaceFailure hidden() { return new SpaceFailure(404, "SPACE_NOT_FOUND", "공간이나 행사를 찾을 수 없어요."); }
    private static SpaceFailure invalid() { return new SpaceFailure(400, "EVENT_INVALID", "행사 정보를 확인해 주세요."); }

    record EventDraft(String title, String description, String instructions, String resourceUrl,
                      String startsAt, String endsAt) {}
    record RsvpDraft(String response) {}
    record ScheduledEvent(String id, String title, String description, String instructions, String resourceUrl,
                          String startsAt, String endsAt, boolean cancelled, String createdAt, String updatedAt,
                          long goingCount, long interestedCount, long declinedCount, String myResponse) {}
    private record EventLock(boolean cancelled, Instant startsAt) {}
    private record Normalized(String title, String description, String instructions, String resourceUrl,
                              Instant startsAt, Instant endsAt) {}
}
