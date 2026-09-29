package town.hufs.api.space;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseCookie;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import town.hufs.auth.AvatarCatalog;
import town.hufs.auth.GuestIdentity;
import town.hufs.auth.JoinTickets;
import town.hufs.auth.TownPrincipal;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.security.SecureRandom;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.*;

/** Anonymous guests can only inspect and enter a space explicitly configured for public guest entry. */
@RestController
@RequestMapping("/api/v1/guest")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class GuestSpaceController {
    private static final int GUEST_SESSION_SECONDS = 1800;
    private static final String GUEST_ID_COOKIE = "HUFS_TOWN_GUEST";
    private static final int GUEST_BROWSER_TOKEN_BYTES = 32;
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();
    // Covers the 180-day report review window plus the longest seven-day moderation action.
    private static final Duration GUEST_ID_COOKIE_MAX_AGE = Duration.ofDays(190);
    private static final DefaultRedisScript<Long> LIMIT = new DefaultRedisScript<>(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", Long.class);
    private final Spaces spaces;
    private final JoinTickets tickets;
    private final StringRedisTemplate redis;
    private final SpaceMaps maps;
    private final WorldNodeRouter worldNodes;
    private final boolean secureCookie;

    GuestSpaceController(Spaces spaces, JoinTickets tickets, StringRedisTemplate redis, SpaceMaps maps,
                         WorldNodeRouter worldNodes, @Value("${town.auth.cookie-secure:true}") boolean secureCookie) {
        this.spaces = spaces; this.tickets = tickets; this.redis = redis; this.maps = maps; this.worldNodes = worldNodes;
        this.secureCookie = secureCookie;
    }

    @GetMapping("/spaces/{id}") Spaces.GuestSpace inspect(@PathVariable String id, HttpServletRequest request) {
        limit(request);
        return spaces.guestSpace(id);
    }

    @PostMapping("/spaces/{id}/admission") Map<String, Object> admission(@PathVariable String id,
            @AuthenticationPrincipal TownPrincipal principal, HttpServletRequest request,
            HttpServletResponse response,
            @RequestBody(required = false) GuestAdmission body) {
        limit(request);
        if (principal != null) throw new SpaceFailure(403, "GUEST_SESSION_REQUIRED", "게스트 입장은 로그인하지 않은 브라우저에서 시작해 주세요.");
        var session = request.getSession(true);
        String browserToken = guestBrowserToken(request).orElseGet(GuestSpaceController::newGuestBrowserToken);
        String browserGuestId = guestId(browserToken);
        Object stored = session.getAttribute(GuestIdentity.SESSION_ATTRIBUTE);
        GuestIdentity guest;
        if (stored instanceof GuestIdentity identity) {
            guest = identity;
            if (body != null && body.name() != null && !guest.displayName().equals(body.name().strip()))
                throw new SpaceFailure(409, "GUEST_PROFILE_LOCKED", "게스트 이름을 바꾸려면 입장을 나간 뒤 다시 시작해 주세요.");
            if (!guest.guestId().equals(browserGuestId)) {
                // A missing or replaced browser token starts a new anonymous scope, even if an HTTP session remains.
                guest = new GuestIdentity(browserGuestId, guest.displayName(), guest.avatar(), guest.skin(), guest.clothing(), guest.hair());
                session.setAttribute(GuestIdentity.SESSION_ATTRIBUTE, guest);
            }
        } else {
            if (body == null) throw new SpaceFailure(400, "GUEST_PROFILE_REQUIRED", "게스트 이름과 아바타를 입력해 주세요.");
            guest = identity(body, browserGuestId);
            session.setAttribute(GuestIdentity.SESSION_ATTRIBUTE, guest);
            session.setMaxInactiveInterval(GUEST_SESSION_SECONDS);
        }

        // Guests are deliberately limited to public, direct-entry spaces with no domain or approval policy.
        String ownerId = spaces.guestOwner(id);
        Spaces.GuestSpace space = spaces.guestSpace(id);
        if (body != null && body.mapId() != null && !body.mapId().isBlank())
            throw new SpaceFailure(400, "GUEST_MAP_SELECTION_UNAVAILABLE", "게스트는 공개 공간의 기본 지도로만 입장할 수 있어요.");
        String mapId = maps.entryMapId(id);
        var destination = maps.published(id, mapId, ownerId);
        if (destination == null) throw new SpaceFailure(503, "SPACE_MAP_UNAVAILABLE", "공간 지도를 불러올 수 없어요. 잠시 후 다시 시도해 주세요.");
        String resumeToken = body == null ? "" : body.resumeToken();
        if (resumeToken != null && !resumeToken.isBlank() && !resumeToken.matches("[A-Za-z0-9-]{1,100}"))
            throw new SpaceFailure(400, "RESUME_TOKEN_INVALID", "재접속 정보가 올바르지 않아요.");
        try {
            String ticket = tickets.issue(guest.guestId(), session.getId(), id, mapId, space.capacity(), -1, -1, resumeToken);
            // The opaque random browser token survives HTTP-session invalidation; it is not an account identity.
            response.addHeader("Set-Cookie", ResponseCookie.from(GUEST_ID_COOKIE, browserToken)
                .httpOnly(true).secure(secureCookie).sameSite("Lax").path("/api/v1/guest")
                .maxAge(GUEST_ID_COOKIE_MAX_AGE).build().toString());
            return Map.of("ticket", ticket, "expiresInSeconds", 30, "worldUrl", worldNodes.endpointFor(id));
        } catch (JoinTickets.Full full) {
            throw new SpaceFailure(409, "SPACE_FULL", "공간 입장 정원이 가득 찼어요. 잠시 후 다시 시도해 주세요.");
        } catch (JoinTickets.Unavailable unavailable) {
            throw new SpaceFailure(503, "SPACE_RESERVATION_UNAVAILABLE", "입장 정원을 확인할 수 없어요. 잠시 후 다시 시도해 주세요.");
        }
    }

    @DeleteMapping("/session") Map<String, Boolean> leave(HttpServletRequest request) {
        var session = request.getSession(false);
        // Deliberately retain HUFS_TOWN_GUEST so moderation follows this browser to its next guest session.
        if (session != null) session.invalidate();
        return Map.of("cleared", true);
    }

    private void limit(HttpServletRequest request) {
        String key = "hufs-town:guest-entry-limit:" + digest(request.getRemoteAddr() == null ? "unknown" : request.getRemoteAddr());
        Long count = redis.execute(LIMIT, List.of(key));
        if (count == null || count > 30) throw new SpaceFailure(429, "GUEST_ENTRY_RATE_LIMIT", "게스트 입장 요청이 많아요. 잠시 후 다시 시도해 주세요.");
    }

    private static GuestIdentity identity(GuestAdmission request, String guestId) {
        String name = request.name() == null ? "" : request.name().strip();
        if (name.isEmpty() || name.length() > 20 || name.codePoints().anyMatch(c -> Character.isISOControl(c) || Character.getType(c) == Character.FORMAT)
            || request.avatar() == null || request.avatar() < 0 || request.avatar() > 2
            || request.skin() == null || !AvatarCatalog.SKIN_TONES.contains(request.skin())
            || request.clothing() == null || !AvatarCatalog.CLOTHING.contains(request.clothing())
            || request.hair() == null || !AvatarCatalog.HAIR.contains(request.hair()))
            throw new SpaceFailure(400, "INVALID_GUEST_PROFILE", "게스트 이름과 아바타 설정을 확인해 주세요.");
        return new GuestIdentity(guestId, name, request.avatar(), request.skin(), request.clothing(), request.hair());
    }

    private static Optional<String> guestBrowserToken(HttpServletRequest request) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) return Optional.empty();
        for (Cookie cookie : cookies) {
            if (!GUEST_ID_COOKIE.equals(cookie.getName())) continue;
            try {
                String token = cookie.getValue();
                if (token == null) continue;
                byte[] decoded = Base64.getUrlDecoder().decode(token);
                if (decoded.length == GUEST_BROWSER_TOKEN_BYTES
                    && Base64.getUrlEncoder().withoutPadding().encodeToString(decoded).equals(token))
                    return Optional.of(token);
            } catch (IllegalArgumentException ignored) {
                // Ignore malformed client cookies and issue a fresh random identity after profile validation.
            }
        }
        return Optional.empty();
    }

    private static String newGuestBrowserToken() {
        byte[] token = new byte[GUEST_BROWSER_TOKEN_BYTES];
        SECURE_RANDOM.nextBytes(token);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(token);
    }

    /** Derive the internal guest subject from a 256-bit browser secret without exposing it in the cookie. */
    private static String guestId(String browserToken) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(Base64.getUrlDecoder().decode(browserToken));
            ByteBuffer uuid = ByteBuffer.wrap(digest);
            long most = uuid.getLong();
            long least = uuid.getLong();
            most = (most & 0xffffffffffff0fffL) | 0x0000000000004000L;
            least = (least & 0x3fffffffffffffffL) | 0x8000000000000000L;
            return new UUID(most, least).toString();
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String digest(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    record GuestAdmission(String name, Integer avatar, String skin, String clothing, String hair, String mapId, String resumeToken) {}
}
