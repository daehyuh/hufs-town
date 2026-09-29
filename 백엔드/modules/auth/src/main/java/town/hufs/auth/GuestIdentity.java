package town.hufs.auth;

import java.io.Serializable;
import java.util.UUID;

/** Ephemeral identity for a browser guest. It is stored only in the short-lived HTTP session. */
public record GuestIdentity(String guestId, String displayName, int avatar, String skin, String clothing, String hair)
        implements Serializable {
    public static final String SESSION_ATTRIBUTE = "town.guest.identity";

    public GuestIdentity {
        guestId = UUID.fromString(guestId).toString();
        if (displayName == null || displayName.isBlank() || displayName.length() > 20) throw new IllegalArgumentException();
        if (avatar < 0 || avatar > 2) throw new IllegalArgumentException();
        if (skin == null || !AvatarCatalog.SKIN_TONES.contains(skin)
            || clothing == null || !AvatarCatalog.CLOTHING.contains(clothing)
            || hair == null || !AvatarCatalog.HAIR.contains(hair)) throw new IllegalArgumentException();
    }

    public TownPrincipal principal() {
        return new TownPrincipal(guestId, displayName, avatar, skin, clothing, hair, "", java.util.List.of(), false);
    }
}
