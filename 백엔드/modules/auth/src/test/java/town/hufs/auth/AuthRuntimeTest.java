package town.hufs.auth;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AuthRuntimeTest {
    @Test void allowsOnlyThePrimaryAndExplicitAdditionalOrigins() {
        var runtime = new AuthRuntime("sso", "http://localhost:5173",
            "http://localhost:5173, http://100.87.52.42:5173");

        assertThat(runtime.allowedOrigins())
            .containsExactly("http://localhost:5173", "http://100.87.52.42:5173");
        assertThat(runtime.allowsOrigin("http://100.87.52.42:5173")).isTrue();
        assertThat(runtime.allowsOrigin("http://100.87.52.42:5174")).isFalse();
        assertThat(runtime.allowsOrigin("http://100.87.52.42:5173.evil.example")).isFalse();
        assertThat(runtime.allowsOrigin(null)).isFalse();
    }

    @Test void rejectsNonOriginValuesInsteadOfTreatingThemAsPatterns() {
        assertThatThrownBy(() -> new AuthRuntime("sso", "http://localhost:5173",
            "http://100.87.52.42:5173/path"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessage("Invalid allowed origin");
        assertThatThrownBy(() -> new AuthRuntime("sso", "http://localhost:5173",
            "https://*.tailnet.example"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessage("Invalid allowed origin");
    }
}
