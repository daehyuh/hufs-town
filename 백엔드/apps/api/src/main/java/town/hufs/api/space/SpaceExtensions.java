package town.hufs.api.space;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import town.hufs.auth.TownPrincipal;

import java.net.URI;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

@Service
@org.springframework.boot.autoconfigure.condition.ConditionalOnProperty(
    name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class SpaceExtensions {
    static final Set<String> SUPPORTED_PERMISSIONS = Set.of("SPACE_SUMMARY_READ");
    static final int MAX_APPS_PER_SPACE = 8;
    static final int MAX_CONTEXT_REQUESTS_PER_MINUTE = 60;
    private static final int MAX_CONTEXT_BYTES = 4_096;
    private static final java.util.regex.Pattern IP_LITERAL = java.util.regex.Pattern.compile(
        "(?i)(?:0x[0-9a-f]+|[0-9]+)(?:\\.(?:0x[0-9a-f]+|[0-9]+))*\\.?");
    private static final TypeReference<List<String>> STRING_LIST = new TypeReference<>() {};
    private static final DefaultRedisScript<Long> CONTEXT_LIMIT = new DefaultRedisScript<>(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", Long.class);
    private static final String SELECT = """
        SELECT id,space_id,name,launch_url,origin,requested_permissions,approved_permissions,enabled,created_at,updated_at
        FROM space_extension_app
        """;

    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final StringRedisTemplate redis;
    private final ObjectMapper json;
    private final Spaces spaces;

    SpaceExtensions(JdbcTemplate db, TransactionTemplate tx, StringRedisTemplate redis,
                    ObjectMapper json, Spaces spaces) {
        this.db = db;
        this.tx = tx;
        this.redis = redis;
        this.json = json;
        this.spaces = spaces;
    }

    record Draft(String name, String launchUrl, Set<String> requestedPermissions) {}
    record PermissionUpdate(Set<String> approvedPermissions) {}
    record ExtensionApp(String id, String name, String launchUrl, String origin,
                        List<String> requestedPermissions, List<String> approvedPermissions,
                        boolean enabled, String createdAt, String updatedAt) {}
    record SpaceSummary(String id, String name, String description, String visibility,
                        int capacity, String templateId) {}
    record ExtensionContext(String extensionId, SpaceSummary space, List<String> permissions) {}

    List<ExtensionApp> list(String spaceId, TownPrincipal principal) {
        Spaces.Space space = spaces.detail(spaceId, principal.userId());
        boolean manager = Set.of("OWNER", "ADMIN").contains(space.role());
        return db.query(SELECT + " WHERE space_id=?" + (manager ? "" : " AND enabled=TRUE") + " ORDER BY created_at,id",
            this::app, spaceId);
    }

    ExtensionApp register(String spaceId, TownPrincipal principal, Draft draft) {
        Normalized value = normalize(draft);
        return tx.execute(status -> {
            db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE", String.class, spaceId);
            spaces.requireManager(spaceId, principal.userId());
            Integer count = db.queryForObject("SELECT COUNT(*) FROM space_extension_app WHERE space_id=?", Integer.class, spaceId);
            if (count != null && count >= MAX_APPS_PER_SPACE)
                throw new SpaceFailure(409, "EXTENSION_LIMIT", "공간에는 확장 앱을 최대 8개까지 등록할 수 있어요.");
            String id = UUID.randomUUID().toString();
            db.update("""
                INSERT INTO space_extension_app(id,space_id,name,launch_url,origin,requested_permissions,
                    approved_permissions,enabled,created_by)
                VALUES (?,?,?,?,?,?,JSON_ARRAY(),FALSE,?)
                """, id, spaceId, value.name(), value.launchUrl(), value.origin(), encode(value.requestedPermissions()), principal.userId());
            return find(spaceId, id);
        });
    }

    ExtensionApp update(String spaceId, String extensionId, TownPrincipal principal, Draft draft) {
        Normalized value = normalize(draft);
        return tx.execute(status -> {
            db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE", String.class, spaceId);
            spaces.requireManager(spaceId, principal.userId());
            if (db.update("""
                UPDATE space_extension_app SET name=?,launch_url=?,origin=?,requested_permissions=?,
                    approved_permissions=JSON_ARRAY(),enabled=FALSE
                WHERE id=? AND space_id=?
                """, value.name(), value.launchUrl(), value.origin(), encode(value.requestedPermissions()), extensionId, spaceId) != 1)
                throw notFound();
            return find(spaceId, extensionId);
        });
    }

    ExtensionApp approve(String spaceId, String extensionId, TownPrincipal principal, PermissionUpdate update) {
        List<String> approved = normalizePermissions(update == null ? null : update.approvedPermissions());
        return tx.execute(status -> {
            db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE", String.class, spaceId);
            spaces.requireManager(spaceId, principal.userId());
            ExtensionApp current = find(spaceId, extensionId);
            if (!current.requestedPermissions().containsAll(approved))
                throw new SpaceFailure(400, "EXTENSION_PERMISSION_NOT_REQUESTED", "앱이 요청하지 않은 권한은 승인할 수 없어요.");
            db.update("UPDATE space_extension_app SET approved_permissions=?,enabled=FALSE WHERE id=? AND space_id=?",
                encode(approved), extensionId, spaceId);
            return find(spaceId, extensionId);
        });
    }

    ExtensionApp setEnabled(String spaceId, String extensionId, TownPrincipal principal, boolean enabled) {
        return tx.execute(status -> {
            db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE", String.class, spaceId);
            spaces.requireManager(spaceId, principal.userId());
            if (db.update("UPDATE space_extension_app SET enabled=? WHERE id=? AND space_id=?",
                enabled, extensionId, spaceId) != 1) throw notFound();
            return find(spaceId, extensionId);
        });
    }

    ExtensionContext context(String spaceId, String extensionId, TownPrincipal principal) {
        Spaces.Space space = spaces.detail(spaceId, principal.userId());
        if (space.role().isEmpty())
            throw new SpaceFailure(403, "SPACE_MEMBER_REQUIRED", "공간에 입장한 멤버만 확장 앱을 사용할 수 있어요.");
        ExtensionApp app = db.query(SELECT + " WHERE id=? AND space_id=? AND enabled=TRUE",
            this::app, extensionId, spaceId).stream().findFirst().orElseThrow(SpaceExtensions::notFound);
        Long requests = redis.execute(CONTEXT_LIMIT,
            List.of("hufs-town:extension-context:" + spaceId + ":" + extensionId + ":" + principal.userId()));
        if (requests == null || requests > MAX_CONTEXT_REQUESTS_PER_MINUTE)
            throw new SpaceFailure(429, "EXTENSION_RATE_LIMIT", "확장 앱 요청이 너무 많아요. 잠시 후 다시 시도해 주세요.");
        List<String> permissions = app.approvedPermissions();
        SpaceSummary summary = permissions.contains("SPACE_SUMMARY_READ")
            ? new SpaceSummary(space.id(), space.name(), space.description(), space.visibility(), space.capacity(), space.templateId())
            : null;
        ExtensionContext result = new ExtensionContext(app.id(), summary, permissions);
        try {
            if (json.writeValueAsBytes(result).length > MAX_CONTEXT_BYTES)
                throw new SpaceFailure(500, "EXTENSION_CONTEXT_TOO_LARGE", "확장 앱에 전달할 정보가 너무 커요.");
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new SpaceFailure(500, "EXTENSION_CONTEXT_TOO_LARGE", "확장 앱에 전달할 정보가 너무 커요.");
        }
        return result;
    }

    private ExtensionApp find(String spaceId, String extensionId) {
        return db.query(SELECT + " WHERE id=? AND space_id=?", this::app, extensionId, spaceId)
            .stream().findFirst().orElseThrow(SpaceExtensions::notFound);
    }

    private ExtensionApp app(ResultSet row, int ignored) throws SQLException {
        return new ExtensionApp(row.getString("id"), row.getString("name"), row.getString("launch_url"),
            row.getString("origin"), decode(row.getString("requested_permissions")),
            decode(row.getString("approved_permissions")), row.getBoolean("enabled"),
            row.getTimestamp("created_at").toInstant().toString(), row.getTimestamp("updated_at").toInstant().toString());
    }

    private Normalized normalize(Draft draft) {
        if (draft == null) throw invalid();
        String name = draft.name() == null ? "" : draft.name().strip();
        if (name.isEmpty() || name.length() > 60 || name.codePoints().anyMatch(Character::isISOControl)) throw invalid();
        if (draft.launchUrl() == null || draft.launchUrl().length() > 2048) throw invalidUrl();
        URI uri;
        try { uri = URI.create(draft.launchUrl().strip()); }
        catch (IllegalArgumentException error) { throw invalidUrl(); }
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || uri.getUserInfo() != null
            || uri.getQuery() != null || uri.getFragment() != null || host.length() > 255
            || host.equalsIgnoreCase("localhost") || host.endsWith(".localhost") || host.endsWith(".local")
            || host.equalsIgnoreCase("localhost.localdomain") || host.endsWith(".localhost.localdomain")
            || IP_LITERAL.matcher(host).matches() || host.contains(":")
            || host.chars().anyMatch(Character::isISOControl))
            throw invalidUrl();
        String normalizedUrl = uri.normalize().toASCIIString();
        if (normalizedUrl.endsWith("/")) normalizedUrl = normalizedUrl.substring(0, normalizedUrl.length() - 1);
        String port = uri.getPort() < 0 || uri.getPort() == 443 ? "" : ":" + uri.getPort();
        String origin = uri.getScheme().toLowerCase(Locale.ROOT) + "://" + host.toLowerCase(Locale.ROOT) + port;
        if (normalizedUrl.length() > 2048 || origin.length() > 255) throw invalidUrl();
        return new Normalized(name, normalizedUrl, origin,
            normalizePermissions(draft.requestedPermissions()));
    }

    private List<String> normalizePermissions(Set<String> values) {
        if (values == null || values.size() > SUPPORTED_PERMISSIONS.size()
            || values.stream().anyMatch(java.util.Objects::isNull) || !SUPPORTED_PERMISSIONS.containsAll(values))
            throw new SpaceFailure(400, "EXTENSION_PERMISSION_INVALID", "현재 지원하지 않는 확장 앱 권한이에요.");
        return List.copyOf(new LinkedHashSet<>(values));
    }

    private String encode(List<String> values) {
        try { return json.writeValueAsString(values); }
        catch (Exception error) { throw new IllegalStateException("Could not encode extension permissions", error); }
    }

    private List<String> decode(String value) {
        try { return json.readValue(value, STRING_LIST); }
        catch (Exception error) { throw new IllegalStateException("Invalid stored extension permissions", error); }
    }

    private static SpaceFailure invalid() { return new SpaceFailure(400, "EXTENSION_INVALID", "확장 앱 이름과 권한을 확인해 주세요."); }
    private static SpaceFailure invalidUrl() { return new SpaceFailure(400, "EXTENSION_URL_INVALID", "확장 앱 주소는 자격 증명·쿼리 없이 입력한 HTTPS 웹 주소여야 해요."); }
    private static SpaceFailure notFound() { return new SpaceFailure(404, "EXTENSION_NOT_FOUND", "확장 앱을 찾을 수 없어요."); }
    private record Normalized(String name, String launchUrl, String origin, List<String> requestedPermissions) {}
}
