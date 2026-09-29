package town.hufs.api.calendar;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;

@Component
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class GoogleCalendarOAuthState {
    private final StringRedisTemplate redis;
    private final SecureRandom random = new SecureRandom();

    GoogleCalendarOAuthState(StringRedisTemplate redis) { this.redis = redis; }

    String start(String userId, String sessionId) {
        if (userId == null || sessionId == null || sessionId.isBlank())
            throw new CalendarIntegrationFailure("AUTH_REQUIRED", 401);
        long minute = System.currentTimeMillis() / 60_000;
        String rateKey = "hufs-town:calendar:google:connect-rate:" + hash(userId) + ":" + minute;
        Long count = redis.opsForValue().increment(rateKey);
        if (Long.valueOf(1).equals(count)) redis.expire(rateKey, Duration.ofMinutes(2));
        if (count == null || count > 10)
            throw new CalendarIntegrationFailure("CALENDAR_RATE_LIMIT", 429);

        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String state = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        String value = userId + ":" + hash(sessionId);
        redis.opsForValue().set(key(state), value, Duration.ofMinutes(8));
        return state;
    }

    void consume(String state, String userId, String sessionId) {
        if (state == null || !state.matches("[A-Za-z0-9_-]{43}") || userId == null || sessionId == null)
            throw invalidState();
        String actual = redis.opsForValue().getAndDelete(key(state));
        String expected = userId + ":" + hash(sessionId);
        if (actual == null || !MessageDigest.isEqual(actual.getBytes(StandardCharsets.UTF_8),
            expected.getBytes(StandardCharsets.UTF_8))) throw invalidState();
    }

    private static String key(String state) { return "hufs-town:calendar:google:state:" + hash(state); }
    private static CalendarIntegrationFailure invalidState() {
        return new CalendarIntegrationFailure("CALENDAR_OAUTH_STATE_INVALID", 400);
    }

    private static String hash(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
