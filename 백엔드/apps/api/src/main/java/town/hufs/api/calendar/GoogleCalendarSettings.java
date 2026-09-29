package town.hufs.api.calendar;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.net.URI;
import java.util.Base64;

@ConfigurationProperties("town.calendar.google")
public record GoogleCalendarSettings(boolean enabled, String clientId, String clientSecret,
                                    String redirectUri, String tokenEncryptionKey) {
    public boolean configured() {
        if (!enabled || !present(clientId) || !present(clientSecret) || !present(redirectUri)
            || !present(tokenEncryptionKey)) return false;
        try {
            URI callback = URI.create(redirectUri);
            boolean localHttp = "http".equals(callback.getScheme())
                && ("localhost".equals(callback.getHost()) || "127.0.0.1".equals(callback.getHost()));
            byte[] key = Base64.getDecoder().decode(tokenEncryptionKey);
            return ("https".equals(callback.getScheme()) || localHttp)
                && callback.getHost() != null && callback.getUserInfo() == null
                && callback.getQuery() == null && callback.getFragment() == null
                && "/api/v1/calendar/google/callback".equals(callback.getPath())
                && key.length == 32;
        } catch (IllegalArgumentException invalid) {
            return false;
        }
    }

    public String publicOrigin() {
        if (!configured()) throw new CalendarIntegrationFailure("CALENDAR_NOT_CONFIGURED", 503);
        URI callback = URI.create(redirectUri);
        return callback.getScheme() + "://" + callback.getRawAuthority();
    }

    public void requireConfigured() {
        if (!configured()) throw new CalendarIntegrationFailure("CALENDAR_NOT_CONFIGURED", 503);
    }

    private static boolean present(String value) { return value != null && !value.isBlank(); }

    // Do not expose the OAuth secret or encryption key through generated diagnostics.
    @Override public String toString() { return "GoogleCalendarSettings[enabled=" + enabled + ", configured=" + configured() + "]"; }
}
