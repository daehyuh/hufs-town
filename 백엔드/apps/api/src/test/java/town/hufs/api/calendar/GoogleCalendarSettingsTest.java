package town.hufs.api.calendar;

import org.junit.jupiter.api.Test;

import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;

class GoogleCalendarSettingsTest {
    @Test
    void requiresTheExpectedCallbackHttpsAndA256BitEncryptionKey() {
        String key = Base64.getEncoder().encodeToString(new byte[32]);

        assertThat(settings(true, "https://calendar.example/api/v1/calendar/google/callback", key).configured()).isTrue();
        assertThat(settings(true, "http://localhost:5173/api/v1/calendar/google/callback", key).configured()).isTrue();
        assertThat(settings(true, "http://100.87.52.42/api/v1/calendar/google/callback", key).configured()).isFalse();
        assertThat(settings(true, "https://calendar.example/callback", key).configured()).isFalse();
        assertThat(settings(true, "https://calendar.example/api/v1/calendar/google/callback?next=/", key).configured()).isFalse();
        assertThat(settings(true, "https://calendar.example/api/v1/calendar/google/callback", "too-short").configured()).isFalse();
        assertThat(settings(false, "https://calendar.example/api/v1/calendar/google/callback", key).configured()).isFalse();
    }

    @Test
    void diagnosticsNeverIncludeClientOrEncryptionSecrets() {
        String key = Base64.getEncoder().encodeToString("top-secret-encryption-key-material".getBytes());
        GoogleCalendarSettings settings = settings(true,
            "https://calendar.example/api/v1/calendar/google/callback", key);

        assertThat(settings.toString()).doesNotContain("client-secret", "top-secret");
    }

    private static GoogleCalendarSettings settings(boolean enabled, String callback, String key) {
        return new GoogleCalendarSettings(enabled, "client-id", "client-secret", callback, key);
    }
}
