package town.hufs.auth;

import java.io.Serializable;
import java.security.Principal;
import java.util.List;
import java.util.Objects;
import org.springframework.security.core.context.SecurityContext;

/** Only the service identity and public profile cross the API/world boundary. */
public record TownPrincipal(String userId, String displayName, int avatar, String skin, String clothing, String hair,
                            String bio, List<String> links, boolean allowPokes) implements Serializable, Principal {
    public static final String CONTEXT_KEY = "SPRING_SECURITY_CONTEXT";
    public TownPrincipal {
        if (avatar < 0 || avatar > 2) avatar = 0;
        if (skin == null || !AvatarCatalog.SKIN_TONES.contains(skin)) skin = "light";
        if (clothing == null || !AvatarCatalog.CLOTHING.contains(clothing)) clothing = AvatarCatalog.defaultClothing(avatar);
        if (hair == null || !AvatarCatalog.HAIR.contains(hair)) hair = "hair_short_black";
        bio = bio == null ? "" : bio.strip();
        links = links == null ? List.of() : links.stream().filter(Objects::nonNull).toList();
    }
    public TownPrincipal(String userId, String displayName, int avatar, String skin, String clothing, String hair) {
        this(userId, displayName, avatar, skin, clothing, hair, "", List.of(), true);
    }
    public TownPrincipal(String userId, String displayName, int avatar, String skin, String clothing, String hair,
                         String bio, List<String> links) {
        this(userId, displayName, avatar, skin, clothing, hair, bio, links, true);
    }
    public TownPrincipal(String userId, String displayName, int avatar) {
        this(userId, displayName, avatar, "light", AvatarCatalog.defaultClothing(avatar), "hair_short_black");
    }
    @Override public String getName() { return userId; }
    public static TownPrincipal from(Object value) {
        if (value instanceof SecurityContext context && context.getAuthentication() != null
            && context.getAuthentication().isAuthenticated()
            && context.getAuthentication().getPrincipal() instanceof TownPrincipal principal) {
            // Existing Redis sessions can contain a profile written before appearance fields existed.
            int avatar = principal.avatar() >= 0 && principal.avatar() <= 2 ? principal.avatar() : 0;
            String skin = principal.skin() != null && AvatarCatalog.SKIN_TONES.contains(principal.skin()) ? principal.skin() : "light";
            String clothing = principal.clothing() != null && AvatarCatalog.CLOTHING.contains(principal.clothing())
                ? principal.clothing() : AvatarCatalog.defaultClothing(avatar);
            String hair = principal.hair() != null && AvatarCatalog.HAIR.contains(principal.hair()) ? principal.hair() : "hair_short_black";
            if (avatar != principal.avatar() || !skin.equals(principal.skin())
                || !clothing.equals(principal.clothing()) || !hair.equals(principal.hair()))
                return new TownPrincipal(principal.userId(), principal.displayName(), avatar, skin, clothing, hair,
                    principal.bio(), principal.links(), principal.allowPokes());
            return principal;
        }
        return null;
    }
}
