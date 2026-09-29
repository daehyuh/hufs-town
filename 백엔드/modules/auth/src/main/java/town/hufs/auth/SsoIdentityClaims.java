package town.hufs.auth;

import java.net.IDN;
import java.util.Locale;

/** Short-lived claims derived from the current SSO response; never persist these as account profile data. */
public final class SsoIdentityClaims {
    public static final String EMAIL_DOMAIN_SESSION_ATTRIBUTE = "town.sso.emailDomain";

    private SsoIdentityClaims() {}

    public static String emailDomain(String email) {
        if (email == null || email.length() > 320 || email.isBlank()) return null;
        String value = email.strip();
        int at = value.lastIndexOf('@');
        if (at <= 0 || at != value.indexOf('@') || at == value.length() - 1) return null;
        try {
            String domain = IDN.toASCII(value.substring(at + 1), IDN.USE_STD3_ASCII_RULES).toLowerCase(Locale.ROOT);
            if (domain.length() > 253 || !domain.contains(".")
                || !domain.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+"))
                return null;
            return domain;
        } catch (IllegalArgumentException invalidDomain) {
            return null;
        }
    }
}
