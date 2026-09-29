package town.hufs.api.space;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import town.hufs.auth.TownPrincipal;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

/** Read-only event history and export endpoints for space managers. */
@RestController
@RequestMapping("/api/v1/spaces/{spaceId}/events")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class EventResultsController {
    private final JdbcTemplate db;

    EventResultsController(JdbcTemplate db) { this.db = db; }

    @GetMapping
    List<EventSummary> history(@PathVariable String spaceId, @AuthenticationPrincipal TownPrincipal principal) {
        manager(spaceId, principal);
        return db.query("""
            SELECT e.id,e.title,e.description,e.resource_url,e.started_at,e.ended_at,
                   COUNT(DISTINCT CASE WHEN a.player_id IS NOT NULL THEN
                       CASE WHEN a.user_id IS NULL THEN CONCAT('guest:',a.player_id) ELSE CONCAT('user:',a.user_id) END
                   END) AS attendee_count
            FROM town_event e LEFT JOIN town_event_attendance a ON a.event_id=e.id
            WHERE e.space_id=?
            GROUP BY e.id,e.title,e.description,e.resource_url,e.started_at,e.ended_at
            ORDER BY e.started_at DESC,e.id DESC LIMIT 100
            """, (r, n) -> eventSummary(r.getString("id"), r.getString("title"), r.getString("description"),
                r.getString("resource_url"), r.getTimestamp("started_at"), r.getTimestamp("ended_at"), r.getLong("attendee_count")), spaceId);
    }

    @GetMapping("/{eventId}/results")
    EventResults results(@PathVariable String spaceId, @PathVariable String eventId,
                         @AuthenticationPrincipal TownPrincipal principal) {
        manager(spaceId, principal);
        requireUuid(eventId, "EVENT_NOT_FOUND");
        EventSummary event = db.query("""
            SELECT e.id,e.title,e.description,e.resource_url,e.started_at,e.ended_at,
                   COUNT(DISTINCT CASE WHEN a.player_id IS NOT NULL THEN
                       CASE WHEN a.user_id IS NULL THEN CONCAT('guest:',a.player_id) ELSE CONCAT('user:',a.user_id) END
                   END) AS attendee_count
            FROM town_event e LEFT JOIN town_event_attendance a ON a.event_id=e.id
            WHERE e.space_id=? AND e.id=?
            GROUP BY e.id,e.title,e.description,e.resource_url,e.started_at,e.ended_at
            """, (r, n) -> eventSummary(r.getString("id"), r.getString("title"), r.getString("description"),
                r.getString("resource_url"), r.getTimestamp("started_at"), r.getTimestamp("ended_at"), r.getLong("attendee_count")), spaceId, eventId)
            .stream().findFirst().orElseThrow(() -> new SpaceFailure(404, "EVENT_NOT_FOUND", "행사 기록을 찾을 수 없어요."));
        List<Question> questions = db.query("""
            SELECT id,asker_name,body,answered,answer,answerer_name,asked_at,answered_at
            FROM town_event_question WHERE event_id=? ORDER BY asked_at,id LIMIT 100
            """, (r, n) -> new Question(r.getString("id"), r.getString("asker_name"), r.getString("body"),
                r.getBoolean("answered"), r.getString("answer"), r.getString("answerer_name"),
                instant(r.getTimestamp("asked_at")), instant(r.getTimestamp("answered_at"))), eventId);
        List<Poll> polls = db.query("""
            SELECT id,question,kind,correct_option_index,closed,created_at,closed_at FROM town_event_poll
            WHERE event_id=? ORDER BY created_at,id LIMIT 100
            """, (r, n) -> {
                Object correctOption = r.getObject("correct_option_index");
                return new Poll(r.getString("id"), r.getString("question"), r.getString("kind"),
                    correctOption == null ? null : ((Number) correctOption).intValue(), r.getBoolean("closed"),
                    instant(r.getTimestamp("created_at")), instant(r.getTimestamp("closed_at")),
                    db.query("SELECT option_index,label,vote_count FROM town_event_poll_option WHERE poll_id=? ORDER BY option_index",
                        (o, i) -> new PollOption(o.getInt("option_index"), o.getString("label"), o.getInt("vote_count")), r.getString("id")));
            }, eventId);
        List<QuizScore> quizScores = db.query("""
            SELECT COALESCE(u.display_name,a.display_name,'참가자') AS display_name,
                   SUM(v.points_awarded) AS score
            FROM town_event_poll_vote v
            JOIN town_event_poll p ON p.id=v.poll_id AND p.event_id=?
            LEFT JOIN app_user u ON u.id=v.user_id
            LEFT JOIN town_event_attendance a
                ON a.event_id=p.event_id AND a.player_id=v.participant_id AND v.participant_type='GUEST'
            WHERE p.kind='QUIZ' AND p.closed=TRUE
            GROUP BY v.participant_type,v.participant_id,u.display_name,a.display_name
            HAVING SUM(v.points_awarded)>0
            ORDER BY score DESC,display_name,v.participant_type,v.participant_id
            LIMIT 20
            """, (r, n) -> new QuizScore(r.getString("display_name"), r.getInt("score")), eventId);
        List<Attendance> attendance = db.query("""
            SELECT CASE WHEN attendee.user_id IS NULL THEN CONCAT('guest:',attendee.anonymous_player_id)
                        ELSE CONCAT('user:',attendee.user_id) END AS participant_id,
                   attendee.user_id,
                   (SELECT candidate.display_name FROM town_event_attendance candidate
                    WHERE candidate.event_id=? AND
                        ((attendee.user_id IS NOT NULL AND candidate.user_id=attendee.user_id)
                         OR (attendee.user_id IS NULL AND candidate.player_id=attendee.anonymous_player_id))
                    ORDER BY candidate.last_seen_at DESC,candidate.joined_at DESC LIMIT 1) AS display_name,
                   attendee.joined_at,attendee.last_seen_at,attendee.left_at,attendee.attended_seconds,attendee.session_count
            FROM (
                SELECT user_id,
                       CASE WHEN user_id IS NULL THEN player_id ELSE NULL END AS anonymous_player_id,
                       MIN(joined_at) AS joined_at,MAX(last_seen_at) AS last_seen_at,
                       CASE WHEN SUM(left_at IS NULL)>0 THEN NULL ELSE MAX(left_at) END AS left_at,
                       SUM(attended_seconds + CASE WHEN left_at IS NULL
                           THEN GREATEST(0,TIMESTAMPDIFF(SECOND,COALESCE(segment_started_at,joined_at),
                               LEAST(CURRENT_TIMESTAMP(6),DATE_ADD(last_seen_at,INTERVAL 10 SECOND)))) ELSE 0 END) AS attended_seconds,
                       SUM(segment_count) AS session_count
                FROM town_event_attendance WHERE event_id=?
                GROUP BY user_id,CASE WHEN user_id IS NULL THEN player_id ELSE NULL END
            ) attendee
            ORDER BY attendee.joined_at,display_name,participant_id
            """, (r, n) -> new Attendance(r.getString("participant_id"), r.getString("user_id"), r.getString("display_name"),
                instant(r.getTimestamp("joined_at")), instant(r.getTimestamp("last_seen_at")), instant(r.getTimestamp("left_at")),
                r.getLong("attended_seconds"), r.getLong("session_count")), eventId, eventId);
        return new EventResults(event, questions, polls, quizScores, attendance);
    }

    @GetMapping(value = "/{eventId}/attendance.csv", produces = "text/csv")
    ResponseEntity<byte[]> attendanceCsv(@PathVariable String spaceId, @PathVariable String eventId,
                                          @AuthenticationPrincipal TownPrincipal principal) {
        EventResults results = results(spaceId, eventId, principal);
        StringBuilder csv = new StringBuilder("\uFEFFparticipantId,displayName,userId,joinedAt,lastSeenAt,leftAt,attendedSeconds,connectionSessions\n");
        for (Attendance row : results.attendance()) {
            csv.append(cell(row.participantId())).append(',').append(cell(row.displayName())).append(',')
                .append(cell(row.userId())).append(',').append(cell(row.joinedAt())).append(',')
                .append(cell(row.lastSeenAt())).append(',').append(cell(row.leftAt())).append(',')
                .append(row.attendedSeconds()).append(',').append(row.sessionCount()).append('\n');
        }
        return ResponseEntity.ok()
            .contentType(MediaType.parseMediaType("text/csv;charset=UTF-8"))
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"hufs-town-attendance-" + eventId + ".csv\"")
            .body(csv.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private void manager(String spaceId, TownPrincipal principal) {
        if (principal == null) throw new SpaceFailure(401, "AUTH_REQUIRED", "로그인이 필요해요.");
        if (spaceId == null || eventIdInvalid(spaceId)) throw hidden();
        Integer active = db.queryForObject("SELECT COUNT(*) FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL",
            Integer.class, principal.userId());
        if (active == null || active != 1)
            throw new SpaceFailure(403, "ACCOUNT_UNAVAILABLE", "이 계정으로 행사 결과를 볼 수 없어요.");
        Integer space = db.queryForObject("SELECT COUNT(*) FROM town_space WHERE id=?", Integer.class, spaceId);
        if (space == null || space != 1) throw hidden();
        Integer blocked = db.queryForObject("SELECT COUNT(*) FROM space_access_block WHERE space_id=? AND user_id=?",
            Integer.class, spaceId, principal.userId());
        if (blocked != null && blocked > 0) throw hidden();
        Integer count = db.queryForObject("""
            SELECT COUNT(*) FROM space_member
            WHERE space_id=? AND user_id=? AND (role='OWNER' OR manager=TRUE)
            """, Integer.class, spaceId, principal.userId());
        if (count == null || count != 1) throw new SpaceFailure(403, "EVENT_FORBIDDEN", "공간 운영자만 행사 결과를 볼 수 있어요.");
    }

    private static SpaceFailure hidden() { return new SpaceFailure(404, "SPACE_NOT_FOUND", "공간이나 행사를 찾을 수 없어요."); }

    private static boolean eventIdInvalid(String value) {
        try { return !UUID.fromString(value).toString().equalsIgnoreCase(value); }
        catch (RuntimeException invalid) { return true; }
    }
    private static void requireUuid(String value, String code) {
        if (eventIdInvalid(value)) throw new SpaceFailure(404, code, "행사 기록을 찾을 수 없어요.");
    }
    private static EventSummary eventSummary(String id, String title, String description, String resourceUrl,
                                             Timestamp started, Timestamp ended, long attendeeCount) {
        return new EventSummary(id, title, description, resourceUrl, instant(started), instant(ended), attendeeCount);
    }
    private static String instant(Timestamp value) { return value == null ? "" : value.toInstant().toString(); }
    private static String cell(Object value) {
        String text = value == null ? "" : String.valueOf(value);
        int firstText = 0;
        while (firstText < text.length() && (Character.isWhitespace(text.charAt(firstText))
            || Character.isISOControl(text.charAt(firstText)) || text.charAt(firstText) == '\uFEFF')) firstText++;
        boolean dangerous = !text.isEmpty() && "=+-@\t\r\n".indexOf(text.charAt(0)) >= 0;
        dangerous |= firstText < text.length() && "=+-@".indexOf(text.charAt(firstText)) >= 0;
        if (dangerous) text = "'" + text;
        return "\"" + text.replace("\"", "\"\"") + "\"";
    }

    record EventSummary(String id, String title, String description, String resourceUrl,
                        String startedAt, String endedAt, long attendeeCount) {}
    record Question(String id, String askerName, String text, boolean answered, String answer,
                    String answererName, String askedAt, String answeredAt) {}
    record PollOption(int index, String label, int voteCount) {}
    record Poll(String id, String question, String kind, Integer correctOptionIndex, boolean closed,
                String createdAt, String closedAt, List<PollOption> options) {}
    record QuizScore(String name, int score) {}
    record Attendance(String participantId, String userId, String displayName, String joinedAt,
                      String lastSeenAt, String leftAt, long attendedSeconds, long sessionCount) {}
    record EventResults(EventSummary event, List<Question> questions, List<Poll> polls,
                        List<QuizScore> quizScores, List<Attendance> attendance) {}
}
