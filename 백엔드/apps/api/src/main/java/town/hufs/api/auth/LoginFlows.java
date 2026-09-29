package town.hufs.api.auth;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.time.Duration;
import java.util.*;

@Component
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
public class LoginFlows {
    private final StringRedisTemplate redis;
    private final int requestsPerMinutePerIp;
    private final SecureRandom random = new SecureRandom();
    public LoginFlows(StringRedisTemplate redis,
                      @Value("${town.auth.login.requests-per-minute-per-ip:150}") int requestsPerMinutePerIp) {
        if (requestsPerMinutePerIp < 1) throw new IllegalArgumentException("Login rate limit must be positive");
        this.redis = redis;
        this.requestsPerMinutePerIp = requestsPerMinutePerIp;
    }
    public void limit(String operation, String address) {
        limit(operation, address, requestsPerMinutePerIp);
    }
    public void limit(String operation, String address, int maximumPerMinute) {
        if (maximumPerMinute < 1) throw new IllegalArgumentException("Rate limit must be positive");
        String key = "hufs-town:auth:rate:" + operation + ":" + hash(address) + ":" + System.currentTimeMillis() / 60000;
        Long count = redis.opsForValue().increment(key);
        if (Long.valueOf(1).equals(count)) redis.expire(key, Duration.ofMinutes(2));
        if (count == null || count > maximumPerMinute)
            throw new AuthFailure(HttpStatus.TOO_MANY_REQUESTS, "AUTH_RATE_LIMIT", "로그인 시도가 많아요. 1분 후 다시 시도해 주세요.");
    }
    public String start(String sessionId) {
        byte[] bytes = new byte[32]; random.nextBytes(bytes);
        String state = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        // The IdP keeps one pending login per browser: a new start replaces our older flow too.
        redis.opsForValue().set("hufs-town:auth:state:" + hash(sessionId), hash(state), Duration.ofMinutes(10));
        return state;
    }
    public void consume(String sessionId, String state, String code) {
        if (sessionId == null || state == null || !state.matches("[A-Za-z0-9_-]{43}") || code == null || code.isBlank() || code.length() > 4096)
            throw invalidState();
        String expected = redis.opsForValue().getAndDelete("hufs-town:auth:state:" + hash(sessionId));
        if (expected == null || !MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), hash(state).getBytes(StandardCharsets.UTF_8))) throw invalidState();
        if (!Boolean.TRUE.equals(redis.opsForValue().setIfAbsent("hufs-town:auth:used-code:" + hash(code), "1", Duration.ofMinutes(10)))) throw AuthFailure.login();
    }
    private static AuthFailure invalidState() { return new AuthFailure(HttpStatus.BAD_REQUEST, "INVALID_LOGIN_STATE", "로그인 요청이 만료되었거나 다른 브라우저에서 시작됐어요. 다시 로그인해 주세요."); }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
