package town.hufs.api.calendar;

import org.junit.jupiter.api.Test;

import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CalendarTokenCipherTest {
    private static final String KEY = Base64.getEncoder().encodeToString(new byte[32]);

    @Test
    void encryptsTokensWithFreshAuthenticatedCiphertext() {
        CalendarTokenCipher cipher = cipher(KEY);

        String first = cipher.encrypt("sensitive-refresh-token");
        String second = cipher.encrypt("sensitive-refresh-token");

        assertThat(first).startsWith("v1.").doesNotContain("sensitive-refresh-token");
        assertThat(second).isNotEqualTo(first);
        assertThat(cipher.decrypt(first)).isEqualTo("sensitive-refresh-token");
    }

    @Test
    void rejectsTamperingAndTokensEncryptedByAnotherKey() {
        String encrypted = cipher(KEY).encrypt("refresh-token");
        int mutationIndex = 8;
        char replacement = encrypted.charAt(mutationIndex) == 'A' ? 'B' : 'A';
        String tampered = encrypted.substring(0, mutationIndex) + replacement
            + encrypted.substring(mutationIndex + 1);

        assertUnavailable(() -> cipher(KEY).decrypt(tampered));
        assertUnavailable(() -> cipher(Base64.getEncoder().encodeToString(new byte[]{1, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0})).decrypt(encrypted));
    }

    private static CalendarTokenCipher cipher(String key) {
        return new CalendarTokenCipher(new GoogleCalendarSettings(true, "client", "secret",
            "https://town.example/api/v1/calendar/google/callback", key));
    }

    private static void assertUnavailable(Runnable operation) {
        assertThatThrownBy(operation::run)
            .isInstanceOf(CalendarIntegrationFailure.class)
            .hasMessage("CALENDAR_TOKEN_UNAVAILABLE");
    }
}
