package town.hufs.api.calendar;

import org.springframework.stereotype.Component;

import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;

@Component
class CalendarTokenCipher {
    private static final String VERSION = "v1.";
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;
    private final byte[] key;
    private final SecureRandom random = new SecureRandom();

    CalendarTokenCipher(GoogleCalendarSettings settings) {
        byte[] decoded = null;
        try {
            if (settings.tokenEncryptionKey() != null && !settings.tokenEncryptionKey().isBlank())
                decoded = Base64.getDecoder().decode(settings.tokenEncryptionKey());
        } catch (IllegalArgumentException ignored) {
            // Configuration errors are returned only when the user enables calendar linking.
        }
        this.key = decoded != null && decoded.length == 32 ? decoded : null;
    }

    String encrypt(String token) {
        requireKey();
        if (token == null || token.isBlank()) throw new IllegalArgumentException("Token is required");
        byte[] nonce = new byte[NONCE_BYTES];
        random.nextBytes(nonce);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(TAG_BITS, nonce));
            byte[] ciphertext = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
            byte[] combined = Arrays.copyOf(nonce, nonce.length + ciphertext.length);
            System.arraycopy(ciphertext, 0, combined, nonce.length, ciphertext.length);
            return VERSION + Base64.getUrlEncoder().withoutPadding().encodeToString(combined);
        } catch (GeneralSecurityException impossible) {
            throw new CalendarIntegrationFailure("CALENDAR_TOKEN_STORAGE_UNAVAILABLE", 503);
        }
    }

    String decrypt(String encrypted) {
        requireKey();
        if (encrypted == null || !encrypted.startsWith(VERSION))
            throw new CalendarIntegrationFailure("CALENDAR_TOKEN_UNAVAILABLE", 503);
        try {
            byte[] combined = Base64.getUrlDecoder().decode(encrypted.substring(VERSION.length()));
            if (combined.length <= NONCE_BYTES + 16)
                throw new CalendarIntegrationFailure("CALENDAR_TOKEN_UNAVAILABLE", 503);
            byte[] nonce = Arrays.copyOfRange(combined, 0, NONCE_BYTES);
            byte[] ciphertext = Arrays.copyOfRange(combined, NONCE_BYTES, combined.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(TAG_BITS, nonce));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (AEADBadTagException tampered) {
            throw new CalendarIntegrationFailure("CALENDAR_TOKEN_UNAVAILABLE", 503);
        } catch (CalendarIntegrationFailure failure) {
            throw failure;
        } catch (GeneralSecurityException | IllegalArgumentException malformed) {
            throw new CalendarIntegrationFailure("CALENDAR_TOKEN_UNAVAILABLE", 503);
        }
    }

    private void requireKey() {
        if (key == null) throw new CalendarIntegrationFailure("CALENDAR_NOT_CONFIGURED", 503);
    }
}
