package town.hufs.api.push;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import town.hufs.auth.TownPrincipal;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Timestamp;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Set;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/push")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class WebPushController {
    record Configuration(boolean enabled, String publicKey) {}
    record SubscriptionRequest(String endpoint, String p256dh, String auth) {}
    record SubscriptionChange(boolean changed) {}

    private static final Set<String> EXACT_HOSTS = Set.of(
        "fcm.googleapis.com", "web.push.apple.com", "push.services.mozilla.com", "updates.push.services.mozilla.com"
    );
    private final JdbcTemplate db;
    private final TransactionTemplate transactions;
    private final WebPushDelivery delivery;

    WebPushController(JdbcTemplate db, TransactionTemplate transactions, WebPushDelivery delivery) {
        this.db = db;
        this.transactions = transactions;
        this.delivery = delivery;
    }

    @GetMapping("/config")
    Configuration configuration(@AuthenticationPrincipal TownPrincipal principal) {
        requirePrincipal(principal);
        return new Configuration(delivery.enabled(), delivery.applicationServerKey());
    }

    @PostMapping("/subscriptions")
    SubscriptionChange register(@AuthenticationPrincipal TownPrincipal principal,
                                @RequestBody SubscriptionRequest request) {
        requirePrincipal(principal);
        if (!delivery.enabled()) throw unavailable();
        String endpoint = request == null ? "" : request.endpoint();
        String p256dh = request == null ? "" : request.p256dh();
        String auth = request == null ? "" : request.auth();
        validateSubscription(endpoint, p256dh, auth);
        String endpointHash = sha256(endpoint);
        return transactions.execute(status -> {
            var active = db.queryForList("SELECT id FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL FOR UPDATE",
                String.class, principal.userId());
            if (active.isEmpty()) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
            int count = db.queryForObject("SELECT COUNT(*) FROM web_push_subscription WHERE user_id=?", Integer.class, principal.userId());
            boolean exists = !db.queryForList("SELECT id FROM web_push_subscription WHERE endpoint_hash=? FOR UPDATE",
                String.class, endpointHash).isEmpty();
            if (!exists && count >= 10)
                throw new ResponseStatusException(HttpStatus.CONFLICT, "이 계정에는 브라우저 알림을 최대 10개까지 등록할 수 있어요.");
            db.update("""
                INSERT INTO web_push_subscription(id,user_id,endpoint_hash,endpoint,p256dh,auth_secret)
                VALUES (?,?,?,?,?,?)
                ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),endpoint=VALUES(endpoint),p256dh=VALUES(p256dh),
                    auth_secret=VALUES(auth_secret),updated_at=CURRENT_TIMESTAMP(6),last_seen_at=CURRENT_TIMESTAMP(6)
                """, UUID.randomUUID().toString(), principal.userId(), endpointHash, endpoint, p256dh, auth);
            return new SubscriptionChange(true);
        });
    }

    @DeleteMapping("/subscriptions")
    SubscriptionChange remove(@AuthenticationPrincipal TownPrincipal principal,
                              @RequestBody(required = false) SubscriptionRequest request) {
        requirePrincipal(principal);
        String endpoint = request == null ? "" : request.endpoint();
        if (endpoint == null || endpoint.isBlank()) {
            int removed = db.update("DELETE FROM web_push_subscription WHERE user_id=?", principal.userId());
            return new SubscriptionChange(removed > 0);
        }
        validateEndpoint(endpoint);
        int removed = db.update("DELETE FROM web_push_subscription WHERE user_id=? AND endpoint_hash=?",
            principal.userId(), sha256(endpoint));
        return new SubscriptionChange(removed > 0);
    }

    private static void validateSubscription(String endpoint, String p256dh, String auth) {
        validateEndpoint(endpoint);
        try {
            byte[] publicKey = Base64.getUrlDecoder().decode(p256dh);
            byte[] secret = Base64.getUrlDecoder().decode(auth);
            if (publicKey.length != 65 || publicKey[0] != 4 || secret.length != 16)
                throw invalid();
        } catch (IllegalArgumentException invalidBase64) {
            throw invalid();
        }
    }

    private static void validateEndpoint(String endpoint) {
        if (endpoint == null || endpoint.isBlank() || endpoint.length() > 2048) throw invalid();
        try {
            URI uri = URI.create(endpoint);
            String host = uri.getHost();
            boolean allowed = host != null && (EXACT_HOSTS.contains(host.toLowerCase())
                || host.toLowerCase().endsWith(".notify.windows.com"));
            if (!"https".equalsIgnoreCase(uri.getScheme()) || !allowed || uri.getUserInfo() != null
                || uri.getFragment() != null || (uri.getPort() != -1 && uri.getPort() != 443)
                || uri.getRawPath() == null || uri.getRawPath().isBlank()) throw invalid();
        } catch (IllegalArgumentException invalidUri) {
            throw invalid();
        }
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static void requirePrincipal(TownPrincipal principal) {
        if (principal == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
    }

    private static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, "브라우저 알림 구독 정보를 확인해 주세요.");
    }

    private static ResponseStatusException unavailable() {
        return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "브라우저 알림 서버 설정을 확인해 주세요.");
    }
}
