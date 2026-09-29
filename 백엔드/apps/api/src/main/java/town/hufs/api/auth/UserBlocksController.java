package town.hufs.api.auth;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import town.hufs.auth.TownPrincipal;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/me/blocks")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class UserBlocksController {
    private final JdbcTemplate db;
    private final StringRedisTemplate redis;

    UserBlocksController(JdbcTemplate db, StringRedisTemplate redis) {
        this.db = db;
        this.redis = redis;
    }

    @GetMapping
    List<BlockedAccount> list(@AuthenticationPrincipal TownPrincipal principal) {
        return db.query("""
            SELECT block_id, blocked_display_name, created_at
            FROM user_block WHERE blocker_user_id=?
            ORDER BY created_at DESC, block_id DESC LIMIT 500
            """, (rs, row) -> {
                Timestamp created = rs.getTimestamp("created_at");
                return new BlockedAccount(rs.getString("block_id"), rs.getString("blocked_display_name"),
                    created == null ? Instant.EPOCH : created.toInstant());
            }, principal.userId());
    }

    @DeleteMapping("/{blockId}")
    Map<String, Boolean> remove(@AuthenticationPrincipal TownPrincipal principal, @PathVariable String blockId) {
        if (blockId == null || !blockId.matches("[0-9a-fA-F-]{36}"))
            throw new AuthFailure(org.springframework.http.HttpStatus.BAD_REQUEST, "BLOCK_ID_INVALID", "차단 항목을 확인해 주세요.");
        db.update("DELETE FROM user_block WHERE blocker_user_id=? AND block_id=?", principal.userId(), blockId);
        try {
            redis.convertAndSend("hufs-town:world:user-blocks:v1", principal.userId());
        } catch (RuntimeException unavailable) {
            org.slf4j.LoggerFactory.getLogger(getClass()).warn("Block-list refresh hint failed: {}",
                unavailable.getClass().getSimpleName());
        }
        return Map.of("removed", true);
    }

    record BlockedAccount(String id, String displayName, Instant createdAt) {}
}
