package town.hufs.api.auth;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;
import town.hufs.auth.TownPrincipal;
import town.hufs.auth.AvatarCatalog;
import java.util.*;

@Repository
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
public class TownAccounts {
    private final JdbcTemplate db;
    private final TransactionTemplate transactions;
    public TownAccounts(JdbcTemplate db, TransactionTemplate transactions) { this.db = db; this.transactions = transactions; }
    public TownPrincipal login(SsoClient.UserInfo user) {
        allowedStatus(user.status());
        String subject = UUID.fromString(user.uuid()).toString();
        try { return transactions.execute(tx -> upsert(subject)); }
        catch (DuplicateKeyException concurrentLogin) {
            // The losing first-login transaction rolls back its app_user as well as its identity.
            return transactions.execute(tx -> upsert(subject));
        }
    }
    private TownPrincipal upsert(String subject) {
        var ids = db.queryForList("SELECT user_id FROM oauth_identity WHERE provider='gdg_hufs' AND subject=?", String.class, subject);
        String id;
        if (ids.isEmpty()) {
            id = UUID.randomUUID().toString();
            // SSO profile fields are transient. Persist only a separate, user-editable service nickname.
            db.update("INSERT INTO app_user(id,display_name) VALUES (?,?)", id, "HUFS 친구");
            // SSO UUID is the identity key. Email is neither verified nor used to link accounts.
            db.update("INSERT INTO oauth_identity(user_id,provider,subject) VALUES (?,'gdg_hufs',?)", id, subject);
        } else {
            id = ids.getFirst();
            current(id);
        }
        return current(id);
    }
    public TownPrincipal current(String id) {
        var rows = db.query("SELECT id,display_name,avatar_preset,avatar_skin,avatar_clothing,avatar_hair,profile_bio,profile_links,allow_pokes FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL",
            (rs, row) -> new TownPrincipal(rs.getString(1), rs.getString(2), rs.getInt(3), rs.getString(4), rs.getString(5), rs.getString(6), rs.getString(7), parseLinks(rs.getString(8)), rs.getBoolean(9)), id);
        if (rows.isEmpty()) throw new AuthFailure(HttpStatus.FORBIDDEN, "ACCOUNT_UNAVAILABLE", "이 계정으로 입장할 수 없어요. 운영자에게 문의해 주세요.");
        return rows.getFirst();
    }
    public TownPrincipal update(String id, String name, Integer avatar) {
        return update(id, name, avatar, "light", AvatarCatalog.defaultClothing(avatar == null ? 0 : avatar), "hair_short_black", "", List.of());
    }
    public TownPrincipal update(String id, String name, Integer avatar, String skin, String clothing, String hair) {
        return update(id, name, avatar, skin, clothing, hair, "", List.of());
    }
    public TownPrincipal update(String id, String name, Integer avatar, String skin, String clothing, String hair, String bio, List<String> links) {
        var normalizedBio = bio == null ? "" : bio.strip();
        var normalizedLinks = links == null ? List.<String>of() : links.stream()
            .filter(Objects::nonNull).map(String::strip).filter(value -> !value.isEmpty()).distinct().toList();
        if (name == null || name.strip().isEmpty() || name.strip().length() > 20
            || name.codePoints().anyMatch(c -> Character.isISOControl(c) || Character.getType(c) == Character.FORMAT)
            || avatar == null || avatar < 0 || avatar > 2 || skin == null || !AvatarCatalog.SKIN_TONES.contains(skin)
            || clothing == null || !AvatarCatalog.CLOTHING.contains(clothing)
            || hair == null || !AvatarCatalog.HAIR.contains(hair)
            || normalizedBio.codePointCount(0, normalizedBio.length()) > 280
            || normalizedBio.codePoints().anyMatch(c -> Character.isISOControl(c) || Character.getType(c) == Character.FORMAT)
            || normalizedLinks.size() > 3
            || normalizedLinks.stream().anyMatch(link -> link.length() > 512 || !link.matches("(?i)https?://[^\\s]+")))
            throw new AuthFailure(HttpStatus.BAD_REQUEST, "INVALID_PROFILE", "이름 또는 아바타 구성을 확인해 주세요.");
        int updated = db.update("UPDATE app_user SET display_name=?,avatar_preset=?,avatar_skin=?,avatar_clothing=?,avatar_hair=?,profile_bio=?,profile_links=?,version=version+1 WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL",
            name.strip(), avatar, skin, clothing, hair, normalizedBio, String.join("\n", normalizedLinks), id);
        if (updated != 1) return current(id);
        return current(id);
    }
    public TownPrincipal updatePokePreference(String id, Boolean allowPokes) {
        if (allowPokes == null)
            throw new AuthFailure(HttpStatus.BAD_REQUEST, "INVALID_PREFERENCE", "찌르기 수신 설정을 확인해 주세요.");
        int updated = db.update("UPDATE app_user SET allow_pokes=?,version=version+1 WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL", allowPokes, id);
        if (updated != 1) return current(id);
        return current(id);
    }
    static String allowedStatus(String status) {
        if (status == null || status.isBlank()) throw deniedStatus();
        String normalized = status.strip().toUpperCase(Locale.ROOT).replaceAll("\\s+", "");
        return switch (normalized) {
            case "ENROLLED", "ATTENDING", "재학", "재학생" -> "ENROLLED";
            case "LEAVE_OF_ABSENCE", "ON_LEAVE", "LEAVE", "휴학", "휴학생" -> "LEAVE_OF_ABSENCE";
            case "GRADUATED", "졸업", "졸업생" -> "GRADUATED";
            case "FACULTY", "PROFESSOR", "LECTURER", "교수", "강사", "교원" -> "FACULTY";
            case "STAFF", "직원", "교직원" -> "STAFF";
            case "COMMON_ACCOUNT", "COMMON_ID", "COMMON", "공용", "공용계정", "공용아이디" -> "COMMON_ACCOUNT";
            case "UNKNOWN", "알수없음", "판별불가", "미분류" -> "UNKNOWN";
            // HUFS SSO remains the identity provider; unfamiliar non-empty status values
            // are treated as the documented UNKNOWN account type instead of blocking login.
            default -> "UNKNOWN";
        };
    }
    private static AuthFailure deniedStatus() { return new AuthFailure(HttpStatus.FORBIDDEN, "SSO_STATUS_NOT_ALLOWED", "현재 계정 상태로는 입장할 수 없어요. 운영자에게 문의해 주세요."); }
    private static List<String> parseLinks(String value) {
        if (value == null || value.isBlank()) return List.of();
        return Arrays.stream(value.split("\\R"))
            .map(String::strip)
            .filter(link -> link.matches("(?i)https?://[^\\s]+"))
            .limit(3)
            .toList();
    }
}
