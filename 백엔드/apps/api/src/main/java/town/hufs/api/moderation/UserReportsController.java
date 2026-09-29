package town.hufs.api.moderation;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import town.hufs.auth.TownPrincipal;

import java.sql.Timestamp;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/v1")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class UserReportsController {
    record Access(boolean administrator) {}
    record ReportRequest(String messageId, String category, String details) {}
    record ReportCreated(String reportId, boolean created) {}
    record ReviewRequest(String status, String note) {}
    record ChatMuteRequest(String requestId, int durationMinutes, String note) {}
    record ChatMuteResult(ReportSummary report, long mutedUntil) {}
    record ModerationActionResult(ReportSummary report, long effectiveUntil) {}
    record KickRequest(String requestId, String note) {}
    record ReportSummary(String reportId, String reporterName, String targetName, String targetType, String conversationId,
                         String messageId, String category, String details, String evidenceText, String status,
                         long createdAt, Long reviewedAt, String reviewerName, String reviewNote,
                         String sourceType, String spaceId) {}
    record ReviewEntry(String fromStatus, String toStatus, String reviewerName, String note, long createdAt) {}
    private record ReportActionTarget(String reportId, String status, String targetUserId, String targetGuestId) {}
    private record ExistingAction(String reportId, String requestHash, Timestamp effectiveUntil) {}
    private record MessageEvidence(String conversationId, String targetUserId, String targetName, String text,
                                   Timestamp sentAt) {}

    private static final Pattern UUID_PATTERN = Pattern.compile("(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    private static final Set<String> CATEGORIES = Set.of("HARASSMENT", "THREAT", "SPAM", "PERSONAL_INFO", "OTHER");
    private static final Set<String> STATUSES = Set.of("OPEN", "REVIEWING", "RESOLVED", "DISMISSED");

    private final JdbcTemplate db;
    private final TransactionTemplate transactions;
    private final Set<String> administratorIds;

    UserReportsController(JdbcTemplate db, TransactionTemplate transactions,
                          @Value("${town.moderation.admin-user-ids:}") String administratorIds) {
        this.db = db;
        this.transactions = transactions;
        this.administratorIds = Arrays.stream(administratorIds.split(","))
            .map(String::trim).filter(value -> UUID_PATTERN.matcher(value).matches())
            .map(String::toLowerCase).collect(Collectors.toUnmodifiableSet());
    }

    @Scheduled(cron = "0 15 4 * * *")
    void expireReports() {
        db.update("DELETE FROM user_report WHERE created_at<CURRENT_TIMESTAMP(6)-INTERVAL 180 DAY");
        db.update("DELETE FROM user_moderation_action WHERE created_at<CURRENT_TIMESTAMP(6)-INTERVAL 365 DAY");
        db.update("DELETE FROM user_chat_restriction WHERE muted_until<CURRENT_TIMESTAMP(6)-INTERVAL 30 DAY");
        db.update("DELETE FROM user_world_restriction WHERE blocked_until<CURRENT_TIMESTAMP(6)-INTERVAL 30 DAY");
        db.update("DELETE FROM user_media_mute WHERE muted_until<CURRENT_TIMESTAMP(6)-INTERVAL 30 DAY");
        db.update("DELETE FROM guest_moderation_restriction WHERE updated_at<CURRENT_TIMESTAMP(6)-INTERVAL 30 DAY");
    }

    @GetMapping("/reports/access")
    Access access(@AuthenticationPrincipal TownPrincipal principal) {
        requireUser(principal);
        return new Access(isAdministrator(principal));
    }

    @PostMapping("/reports")
    ReportCreated create(@AuthenticationPrincipal TownPrincipal principal, @RequestBody ReportRequest request) {
        requireUser(principal);
        if (request == null || request.messageId() == null || !UUID_PATTERN.matcher(request.messageId()).matches()
            || request.category() == null || !CATEGORIES.contains(request.category())) throw invalid();
        String details = normalizeDetails(request.details());
        return transactions.execute(transaction -> {
            List<String> reporterNames = db.queryForList("""
                SELECT display_name FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL FOR UPDATE
                """, String.class, principal.userId());
            if (reporterNames.isEmpty()) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
            List<MessageEvidence> evidence = db.query("""
                SELECT dm.conversation_id,dm.sender_user_id,dm.sender_name,dm.body,dm.sent_at
                FROM direct_message dm
                JOIN direct_conversation_member member
                  ON member.conversation_id=dm.conversation_id AND member.user_id=?
                JOIN app_user target ON target.id=dm.sender_user_id AND target.status='ACTIVE' AND target.deleted_at IS NULL
                WHERE dm.message_id=? AND dm.deleted_at IS NULL AND dm.expires_at>CURRENT_TIMESTAMP(6)
                """, (rs, row) -> new MessageEvidence(rs.getString("conversation_id"), rs.getString("sender_user_id"),
                rs.getString("sender_name"), rs.getString("body"), rs.getTimestamp("sent_at")),
                principal.userId(), request.messageId());
            if (evidence.isEmpty()) throw notFound();
            MessageEvidence item = evidence.getFirst();
            if (principal.userId().equals(item.targetUserId())) throw invalid();
            int reportsForTarget = db.queryForObject("""
                SELECT COUNT(*) FROM user_report
                WHERE reporter_user_id=? AND target_user_id=?
                  AND created_at>=CURRENT_TIMESTAMP(6)-INTERVAL 1 DAY
                """, Integer.class, principal.userId(), item.targetUserId());
            if (reportsForTarget > 0)
                throw new ResponseStatusException(HttpStatus.CONFLICT, "같은 참가자는 24시간에 한 번만 신고할 수 있어요.");
            int reportsToday = db.queryForObject("""
                SELECT COUNT(*) FROM user_report WHERE reporter_user_id=?
                  AND created_at>=CURRENT_TIMESTAMP(6)-INTERVAL 1 DAY
                """, Integer.class, principal.userId());
            if (reportsToday >= 10)
                throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "신고는 하루 최대 10건까지 접수할 수 있어요.");
            String reportId = UUID.randomUUID().toString();
            try {
                db.update("""
                    INSERT INTO user_report(report_id,reporter_user_id,reporter_name_snapshot,target_user_id,
                        target_name_snapshot,conversation_id,message_id,category,details,evidence_text,message_sent_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                    """, reportId, principal.userId(), reporterNames.getFirst(), item.targetUserId(), item.targetName(),
                    item.conversationId(), request.messageId(), request.category(), details, item.text(), item.sentAt());
            } catch (DuplicateKeyException duplicate) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "이 메시지는 이미 신고했어요.");
            }
            return new ReportCreated(reportId, true);
        });
    }

    @GetMapping("/admin/reports")
    List<ReportSummary> list(@AuthenticationPrincipal TownPrincipal principal,
                             @RequestParam(defaultValue = "OPEN") String status,
                             @RequestParam(defaultValue = "50") int limit) {
        requireAdministrator(principal);
        if (!STATUSES.contains(status)) throw invalid();
        int boundedLimit = Math.max(1, Math.min(limit, 100));
        return db.query("""
            SELECT r.report_id,COALESCE(r.reporter_name_snapshot,reporter.display_name) AS reporter_name,
                   COALESCE(r.target_name_snapshot,target.display_name) AS target_name,r.target_identity_type AS target_type,
                   r.conversation_id,r.message_id,
                   r.category,r.details,r.evidence_text,r.status,r.created_at,r.reviewed_at,
                   COALESCE(r.reviewer_name_snapshot,reviewer.display_name) AS reviewer_name,r.review_note,
                   r.source_type,r.space_id
            FROM user_report r
            LEFT JOIN app_user reporter ON reporter.id=r.reporter_user_id
            LEFT JOIN app_user target ON target.id=r.target_user_id
            LEFT JOIN app_user reviewer ON reviewer.id=r.reviewed_by_user_id
            WHERE r.status=? ORDER BY r.created_at,r.report_id LIMIT ?
            """, (rs, row) -> {
                Timestamp createdAt = rs.getTimestamp("created_at");
                Timestamp reviewedAt = rs.getTimestamp("reviewed_at");
                return new ReportSummary(rs.getString("report_id"), rs.getString("reporter_name"),
                    rs.getString("target_name"), rs.getString("target_type"), rs.getString("conversation_id"), rs.getString("message_id"),
                    rs.getString("category"), rs.getString("details"), rs.getString("evidence_text"),
                    rs.getString("status"), createdAt.getTime(), reviewedAt == null ? null : reviewedAt.getTime(),
                    rs.getString("reviewer_name"), rs.getString("review_note"),
                    rs.getString("source_type"), rs.getString("space_id"));
            }, status, boundedLimit);
    }

    @GetMapping("/admin/reports/{reportId}/history")
    List<ReviewEntry> history(@AuthenticationPrincipal TownPrincipal principal, @PathVariable String reportId) {
        requireAdministrator(principal);
        if (!validUuid(reportId)) throw invalid();
        return db.query("""
            SELECT reviewer_name_snapshot,from_status,to_status,note,created_at FROM user_report_review
            WHERE report_id=? ORDER BY created_at,review_id
            """, (rs, row) -> new ReviewEntry(rs.getString("from_status"), rs.getString("to_status"),
            rs.getString("reviewer_name_snapshot"), rs.getString("note"), rs.getTimestamp("created_at").getTime()), reportId);
    }

    @PatchMapping("/admin/reports/{reportId}")
    ReportSummary review(@AuthenticationPrincipal TownPrincipal principal, @PathVariable String reportId,
                         @RequestBody ReviewRequest request) {
        requireAdministrator(principal);
        if (!validUuid(reportId) || request == null || request.status() == null
            || !Set.of("REVIEWING", "RESOLVED", "DISMISSED").contains(request.status())) throw invalid();
        String note = normalizeDetails(request.note());
        return transactions.execute(transaction -> {
            List<String> currentStatuses = db.queryForList("SELECT status FROM user_report WHERE report_id=? FOR UPDATE",
                String.class, reportId);
            if (currentStatuses.isEmpty()) throw notFound();
            String previous = currentStatuses.getFirst();
            if (previous.equals("RESOLVED") || previous.equals("DISMISSED")) {
                if (previous.equals(request.status())) return loadOne(reportId);
                throw new ResponseStatusException(HttpStatus.CONFLICT, "종결된 신고는 다시 변경할 수 없어요.");
            }
            String reviewerName = db.queryForObject("SELECT display_name FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL",
                String.class, principal.userId());
            db.update("""
                UPDATE user_report SET status=?,reviewed_by_user_id=?,reviewer_name_snapshot=?,review_note=?,
                    reviewed_at=CURRENT_TIMESTAMP(6),updated_at=CURRENT_TIMESTAMP(6)
                WHERE report_id=?
                """, request.status(), principal.userId(), reviewerName, note, reportId);
            db.update("""
                INSERT INTO user_report_review(review_id,report_id,reviewer_user_id,reviewer_name_snapshot,
                    from_status,to_status,note) VALUES (?,?,?,?,?,?,?)
                """, UUID.randomUUID().toString(), reportId, principal.userId(), reviewerName, previous,
                request.status(), note);
            return loadOne(reportId);
        });
    }

    @PatchMapping("/admin/reports/{reportId}/chat-mute")
    ChatMuteResult muteChat(@AuthenticationPrincipal TownPrincipal principal, @PathVariable String reportId,
                            @RequestBody ChatMuteRequest request) {
        requireAdministrator(principal);
        if (!validUuid(reportId) || request == null || request.requestId() == null
            || !request.requestId().matches("[A-Za-z0-9_-]{16,64}")
            || request.durationMinutes() < 1 || request.durationMinutes() > 10_080) throw invalid();
        String note = normalizeDetails(request.note());
        String requestHash = hash(reportId + "\nCHAT_MUTE\n" + request.durationMinutes() + "\n" + note);
        return transactions.execute(transaction -> {
            String administratorName = lockActiveAdministrator(principal.userId());
            ExistingAction prior = findExistingAction(principal.userId(), request.requestId(), reportId, requestHash);
            if (prior != null) return new ChatMuteResult(loadOne(reportId), prior.effectiveUntil().getTime());
            ReportActionTarget report = lockActionReport(reportId);
            lockActionTarget(report);
            Timestamp proposedUntil = db.queryForObject("SELECT TIMESTAMPADD(MINUTE,?,CURRENT_TIMESTAMP(6))",
                Timestamp.class, request.durationMinutes());
            Timestamp effectiveUntil = applyRestriction(report, "CHAT_MUTE", proposedUntil, principal.userId(), note);
            insertAction(request.requestId(), requestHash, reportId, report.targetUserId(), report.targetGuestId(),
                principal.userId(), "CHAT_MUTE", request.durationMinutes(), effectiveUntil, note);
            String reportNote = "채팅 제한 적용 · 만료 " + effectiveUntil.toInstant();
            if (!note.isBlank()) reportNote += "\n" + note;
            if (reportNote.length() > 1000) reportNote = reportNote.substring(0, 1000);
            db.update("""
                UPDATE user_report SET status='RESOLVED',reviewed_by_user_id=?,reviewer_name_snapshot=?,
                    review_note=?,reviewed_at=CURRENT_TIMESTAMP(6),updated_at=CURRENT_TIMESTAMP(6)
                WHERE report_id=?
                """, principal.userId(), administratorName, reportNote, reportId);
            db.update("""
                INSERT INTO user_report_review(review_id,report_id,reviewer_user_id,reviewer_name_snapshot,
                    from_status,to_status,note) VALUES (?,?,?,?,?,'RESOLVED',?)
                """, UUID.randomUUID().toString(), reportId, principal.userId(), administratorName,
                report.status(), reportNote);
            return new ChatMuteResult(loadOne(reportId), effectiveUntil.getTime());
        });
    }

    @PatchMapping("/admin/reports/{reportId}/media-mute")
    ModerationActionResult muteMedia(@AuthenticationPrincipal TownPrincipal principal, @PathVariable String reportId,
                                     @RequestBody ChatMuteRequest request) {
        requireAdministrator(principal);
        if (!validUuid(reportId) || request == null || request.requestId() == null
            || !request.requestId().matches("[A-Za-z0-9_-]{16,64}")
            || request.durationMinutes() < 1 || request.durationMinutes() > 10_080) throw invalid();
        String note = normalizeDetails(request.note());
        String requestHash = hash(reportId + "\nMEDIA_MUTE\n" + request.durationMinutes() + "\n" + note);
        return transactions.execute(transaction -> {
            String administratorName = lockActiveAdministrator(principal.userId());
            ExistingAction prior = findExistingAction(principal.userId(), request.requestId(), reportId, requestHash);
            if (prior != null) return new ModerationActionResult(loadOne(reportId), prior.effectiveUntil().getTime());
            ReportActionTarget report = lockActionReport(reportId);
            lockActionTarget(report);
            Timestamp proposedUntil = db.queryForObject("SELECT TIMESTAMPADD(MINUTE,?,CURRENT_TIMESTAMP(6))",
                Timestamp.class, request.durationMinutes());
            Timestamp effectiveUntil = applyRestriction(report, "MEDIA_MUTE", proposedUntil, principal.userId(), note);
            insertAction(request.requestId(), requestHash, reportId, report.targetUserId(), report.targetGuestId(), principal.userId(),
                "MEDIA_MUTE", request.durationMinutes(), effectiveUntil, note);
            String reportNote = actionNote("마이크·카메라·화면 공유 제한 · 만료 " + effectiveUntil.toInstant(), note);
            ReportSummary updated = closeReportWithAction(reportId, report.status(), principal.userId(), administratorName, reportNote);
            return new ModerationActionResult(updated, effectiveUntil.getTime());
        });
    }

    @PatchMapping("/admin/reports/{reportId}/kick")
    ModerationActionResult kickFromTown(@AuthenticationPrincipal TownPrincipal principal, @PathVariable String reportId,
                                        @RequestBody KickRequest request) {
        requireAdministrator(principal);
        if (!validUuid(reportId) || request == null || request.requestId() == null
            || !request.requestId().matches("[A-Za-z0-9_-]{16,64}")) throw invalid();
        String note = normalizeDetails(request.note());
        String requestHash = hash(reportId + "\nWORLD_KICK\n10\n" + note);
        return transactions.execute(transaction -> {
            String administratorName = lockActiveAdministrator(principal.userId());
            ExistingAction prior = findExistingAction(principal.userId(), request.requestId(), reportId, requestHash);
            if (prior != null) return new ModerationActionResult(loadOne(reportId), prior.effectiveUntil().getTime());
            ReportActionTarget report = lockActionReport(reportId);
            lockActionTarget(report);
            Timestamp proposedUntil = db.queryForObject("SELECT TIMESTAMPADD(MINUTE,10,CURRENT_TIMESTAMP(6))", Timestamp.class);
            Timestamp effectiveUntil = applyRestriction(report, "WORLD_KICK", proposedUntil, principal.userId(), note);
            insertAction(request.requestId(), requestHash, reportId, report.targetUserId(), report.targetGuestId(), principal.userId(),
                "WORLD_KICK", 10, effectiveUntil, note);
            String reportNote = actionNote("전체 월드 강제 퇴장 · 재입장 제한 만료 " + effectiveUntil.toInstant(), note);
            ReportSummary updated = closeReportWithAction(reportId, report.status(), principal.userId(), administratorName, reportNote);
            return new ModerationActionResult(updated, effectiveUntil.getTime());
        });
    }

    private String lockActiveAdministrator(String administratorId) {
        List<String> names = db.queryForList("""
            SELECT display_name FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL FOR UPDATE
            """, String.class, administratorId);
        if (names.isEmpty()) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        return names.getFirst();
    }

    private ExistingAction findExistingAction(String administratorId, String requestId, String reportId, String requestHash) {
        List<ExistingAction> prior = db.query("""
            SELECT report_id,request_hash,effective_until FROM user_moderation_action
            WHERE administrator_user_id=? AND request_id=? FOR UPDATE
            """, (rs, row) -> new ExistingAction(rs.getString("report_id"), rs.getString("request_hash"),
            rs.getTimestamp("effective_until")), administratorId, requestId);
        if (prior.isEmpty()) return null;
        ExistingAction action = prior.getFirst();
        if (!reportId.equals(action.reportId()) || !requestHash.equals(action.requestHash()))
            throw new ResponseStatusException(HttpStatus.CONFLICT, "이미 사용한 조치 요청 ID예요.");
        return action;
    }

    private ReportActionTarget lockActionReport(String reportId) {
        List<ReportActionTarget> reports = db.query("""
            SELECT report_id,status,target_user_id,target_guest_id FROM user_report WHERE report_id=? FOR UPDATE
            """, (rs, row) -> new ReportActionTarget(rs.getString("report_id"), rs.getString("status"),
                rs.getString("target_user_id"), rs.getString("target_guest_id")), reportId);
        if (reports.isEmpty()) throw notFound();
        ReportActionTarget report = reports.getFirst();
        if (report.status().equals("RESOLVED") || report.status().equals("DISMISSED"))
            throw new ResponseStatusException(HttpStatus.CONFLICT, "종결된 신고에는 새 조치를 적용할 수 없어요.");
        if ((report.targetUserId() == null) == (report.targetGuestId() == null))
            throw new ResponseStatusException(HttpStatus.CONFLICT, "신고 대상 식별을 확인할 수 없어 조치를 적용하지 못했어요.");
        return report;
    }

    private void lockActionTarget(ReportActionTarget report) {
        if (report.targetGuestId() != null) {
            if (!validUuid(report.targetGuestId()))
                throw new ResponseStatusException(HttpStatus.CONFLICT, "게스트 신고 대상을 확인할 수 없어요.");
            return;
        }
        List<String> users = db.queryForList("""
            SELECT id FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL FOR UPDATE
            """, String.class, report.targetUserId());
        if (users.isEmpty()) throw new ResponseStatusException(HttpStatus.CONFLICT, "대상 계정이 비활성 상태예요.");
    }

    private Timestamp applyRestriction(ReportActionTarget report, String actionCode, Timestamp proposedUntil,
                                       String administratorId, String note) {
        String accountTable;
        String accountExpiry;
        String guestExpiry;
        switch (actionCode) {
            case "CHAT_MUTE" -> { accountTable = "user_chat_restriction"; accountExpiry = "muted_until"; guestExpiry = "chat_muted_until"; }
            case "MEDIA_MUTE" -> { accountTable = "user_media_mute"; accountExpiry = "muted_until"; guestExpiry = "media_muted_until"; }
            case "WORLD_KICK" -> { accountTable = "user_world_restriction"; accountExpiry = "blocked_until"; guestExpiry = "blocked_until"; }
            default -> throw new IllegalArgumentException("Unsupported moderation action");
        }
        if (report.targetGuestId() != null) {
            db.update("""
                INSERT INTO guest_moderation_restriction(guest_id,%s,report_id,updated_by_user_id,reason)
                VALUES (?,?,?,?,?)
                ON DUPLICATE KEY UPDATE %s=GREATEST(COALESCE(%s,TIMESTAMP('1970-01-01 00:00:00')),VALUES(%s)),
                    report_id=VALUES(report_id),updated_by_user_id=VALUES(updated_by_user_id),
                    reason=VALUES(reason),updated_at=CURRENT_TIMESTAMP(6)
                """.formatted(guestExpiry, guestExpiry, guestExpiry, guestExpiry), report.targetGuestId(),
                proposedUntil, report.reportId(), administratorId, note);
            return db.queryForObject("SELECT " + guestExpiry + " FROM guest_moderation_restriction WHERE guest_id=? FOR UPDATE",
                Timestamp.class, report.targetGuestId());
        }
        db.update("""
            INSERT INTO %s(user_id,%s,report_id,updated_by_user_id,reason)
            VALUES (?,?,?,?,?)
            ON DUPLICATE KEY UPDATE %s=GREATEST(%s,VALUES(%s)),
                report_id=VALUES(report_id),updated_by_user_id=VALUES(updated_by_user_id),
                reason=VALUES(reason),updated_at=CURRENT_TIMESTAMP(6)
            """.formatted(accountTable, accountExpiry, accountExpiry, accountExpiry, accountExpiry),
            report.targetUserId(), proposedUntil, report.reportId(), administratorId, note);
        return db.queryForObject("SELECT " + accountExpiry + " FROM " + accountTable + " WHERE user_id=? FOR UPDATE",
            Timestamp.class, report.targetUserId());
    }

    private void insertAction(String requestId, String requestHash, String reportId, String targetUserId, String targetGuestId,
                              String administratorId, String actionCode, int durationMinutes,
                              Timestamp effectiveUntil, String note) {
        db.update("""
            INSERT INTO user_moderation_action(action_id,request_id,request_hash,report_id,target_user_id,target_guest_id,
                administrator_user_id,action_code,duration_minutes,effective_until,note)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """, UUID.randomUUID().toString(), requestId, requestHash, reportId, targetUserId, targetGuestId,
            administratorId, actionCode, durationMinutes, effectiveUntil, note);
    }

    private ReportSummary closeReportWithAction(String reportId, String previousStatus, String administratorId,
                                                 String administratorName, String reportNote) {
        db.update("""
            UPDATE user_report SET status='RESOLVED',reviewed_by_user_id=?,reviewer_name_snapshot=?,
                review_note=?,reviewed_at=CURRENT_TIMESTAMP(6),updated_at=CURRENT_TIMESTAMP(6)
            WHERE report_id=?
            """, administratorId, administratorName, reportNote, reportId);
        db.update("""
            INSERT INTO user_report_review(review_id,report_id,reviewer_user_id,reviewer_name_snapshot,
                from_status,to_status,note) VALUES (?,?,?,?,?,'RESOLVED',?)
            """, UUID.randomUUID().toString(), reportId, administratorId, administratorName, previousStatus, reportNote);
        return loadOne(reportId);
    }

    private static String actionNote(String action, String note) {
        String result = note.isBlank() ? action : action + "\n" + note;
        return result.length() > 1000 ? result.substring(0, 1000) : result;
    }

    private ReportSummary loadOne(String reportId) {
        return listQuery(reportId);
    }

    private ReportSummary listQuery(String reportId) {
        List<ReportSummary> items = db.query("""
            SELECT r.report_id,COALESCE(r.reporter_name_snapshot,reporter.display_name) AS reporter_name,
                   COALESCE(r.target_name_snapshot,target.display_name) AS target_name,r.target_identity_type AS target_type,
                   r.conversation_id,r.message_id,
                   r.category,r.details,r.evidence_text,r.status,r.created_at,r.reviewed_at,
                   COALESCE(r.reviewer_name_snapshot,reviewer.display_name) AS reviewer_name,r.review_note,
                   r.source_type,r.space_id
            FROM user_report r
            LEFT JOIN app_user reporter ON reporter.id=r.reporter_user_id
            LEFT JOIN app_user target ON target.id=r.target_user_id
            LEFT JOIN app_user reviewer ON reviewer.id=r.reviewed_by_user_id
            WHERE r.report_id=?
            """, (rs, row) -> {
                Timestamp createdAt = rs.getTimestamp("created_at");
                Timestamp reviewedAt = rs.getTimestamp("reviewed_at");
                return new ReportSummary(rs.getString("report_id"), rs.getString("reporter_name"),
                    rs.getString("target_name"), rs.getString("target_type"), rs.getString("conversation_id"), rs.getString("message_id"),
                    rs.getString("category"), rs.getString("details"), rs.getString("evidence_text"),
                    rs.getString("status"), createdAt.getTime(), reviewedAt == null ? null : reviewedAt.getTime(),
                    rs.getString("reviewer_name"), rs.getString("review_note"),
                    rs.getString("source_type"), rs.getString("space_id"));
            }, reportId);
        if (items.isEmpty()) throw notFound();
        return items.getFirst();
    }

    private boolean isAdministrator(TownPrincipal principal) {
        return administratorIds.contains(principal.userId().toLowerCase());
    }

    private void requireAdministrator(TownPrincipal principal) {
        requireUser(principal);
        if (!isAdministrator(principal)) throw new ResponseStatusException(HttpStatus.FORBIDDEN);
    }

    private static void requireUser(TownPrincipal principal) {
        if (principal == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
    }

    private static String normalizeDetails(String value) {
        String details = value == null ? "" : value.strip().replaceAll("[\\p{Cntrl}&&[^\\n\\t]]", "");
        if (details.length() > 1000) throw invalid();
        return details;
    }

    private static boolean validUuid(String value) { return value != null && UUID_PATTERN.matcher(value).matches(); }

    private static String hash(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, "신고 정보를 확인해 주세요.");
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "신고할 메시지를 찾을 수 없어요.");
    }
}
