package town.hufs.api.moderation;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import town.hufs.auth.TownPrincipal;

import java.sql.Timestamp;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/v1/admin/settings/chat-retention")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
final class ChatRetentionController {
    record Policy(int retentionDays, String source, Long updatedAt, String updatedBy) {}
    record Update(int retentionDays) {}

    private static final Pattern UUID_PATTERN = Pattern.compile(
        "(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

    private final JdbcTemplate db;
    private final int defaultDays;
    private final Set<String> administratorIds;

    ChatRetentionController(JdbcTemplate db,
                            @Value("${town.chat.retention-days:30}") int defaultDays,
                            @Value("${town.moderation.admin-user-ids:}") String administratorIds) {
        if (defaultDays < 1 || defaultDays > 365)
            throw new IllegalArgumentException("Chat retention must be between 1 and 365 days");
        this.db = db;
        this.defaultDays = defaultDays;
        this.administratorIds = Arrays.stream(administratorIds.split(","))
            .map(String::trim).filter(value -> UUID_PATTERN.matcher(value).matches())
            .map(String::toLowerCase).collect(Collectors.toUnmodifiableSet());
    }

    @GetMapping
    Policy get(@AuthenticationPrincipal TownPrincipal principal) {
        requireAdministrator(principal);
        List<Map<String, Object>> rows = db.queryForList("""
            SELECT retention_days,updated_at,updated_by_user_id
            FROM chat_retention_policy WHERE policy_id=1
            """);
        if (rows.isEmpty()) return new Policy(defaultDays, "ENVIRONMENT", null, null);
        Map<String, Object> row = rows.getFirst();
        Timestamp updatedAt = (Timestamp) row.get("updated_at");
        return new Policy(((Number) row.get("retention_days")).intValue(), "DATABASE",
            updatedAt == null ? null : updatedAt.getTime(), (String) row.get("updated_by_user_id"));
    }

    @PutMapping
    Policy update(@AuthenticationPrincipal TownPrincipal principal, @RequestBody Update request) {
        requireAdministrator(principal);
        if (request == null || request.retentionDays() < 1 || request.retentionDays() > 365)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "보존 기간은 1~365일로 설정해 주세요.");
        db.update("""
            INSERT INTO chat_retention_policy(policy_id,retention_days,updated_by_user_id)
            VALUES (1,?,?)
            ON DUPLICATE KEY UPDATE retention_days=VALUES(retention_days),
                updated_by_user_id=VALUES(updated_by_user_id),updated_at=CURRENT_TIMESTAMP(6)
            """, request.retentionDays(), principal.userId());
        return get(principal);
    }

    private void requireAdministrator(TownPrincipal principal) {
        if (principal == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        if (!administratorIds.contains(principal.userId().toLowerCase()))
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
    }
}
