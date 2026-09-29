package town.hufs.api.space;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import town.hufs.auth.TownPrincipal;

import java.util.Collections;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

class SpaceExtensionsTest {
    private static final TownPrincipal MANAGER = new TownPrincipal("user-id", "Manager", 0);

    @Test
    void rejectsAlternateNumericHostsThatBrowsersInterpretAsIpAddresses() {
        for (String host : Set.of("127.1", "0177.0.0.1", "0x7f000001", "0x7f.0.0.1"))
            assertFailure("https://" + host + "/app", Set.of(), "EXTENSION_URL_INVALID");
    }

    @Test
    void rejectsCredentialsQueriesFragmentsAndOversizedAsciiUrls() {
        assertFailure("https://user:password@app.example.org/app", Set.of(), "EXTENSION_URL_INVALID");
        assertFailure("https://app.example.org/app?token=secret", Set.of(), "EXTENSION_URL_INVALID");
        assertFailure("https://app.example.org/app#frame", Set.of(), "EXTENSION_URL_INVALID");
        assertFailure("https://app.example.org/" + "한".repeat(500), Set.of(), "EXTENSION_URL_INVALID");
    }

    @Test
    void rejectsNullAndUnknownPermissionsAsClientErrors() {
        assertFailure("https://app.example.org/app", Collections.singleton(null), "EXTENSION_PERMISSION_INVALID");
        assertFailure("https://app.example.org/app", Set.of("SPACE_RAW_SESSION"), "EXTENSION_PERMISSION_INVALID");
    }

    private static void assertFailure(String url, Set<String> permissions, String code) {
        var extensions = new SpaceExtensions(mock(JdbcTemplate.class), mock(TransactionTemplate.class),
            mock(StringRedisTemplate.class), new ObjectMapper(), mock(Spaces.class));
        assertThatThrownBy(() -> extensions.register("space-id", MANAGER,
            new SpaceExtensions.Draft("Test app", url, permissions)))
            .isInstanceOfSatisfying(SpaceFailure.class, failure -> {
                org.assertj.core.api.Assertions.assertThat(failure.status).isEqualTo(400);
                org.assertj.core.api.Assertions.assertThat(failure.code).isEqualTo(code);
            });
    }
}
