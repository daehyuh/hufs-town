package town.hufs.api.auth;

import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.*;
import town.hufs.auth.AuthRuntime;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/auth")
class AuthInfoController {
    private final AuthRuntime runtime;
    private final SsoSettings settings;
    AuthInfoController(AuthRuntime runtime, SsoSettings settings) { this.runtime = runtime; this.settings = settings; }
    @GetMapping("/config") Map<String, Object> config() {
        return Map.of("mode", runtime.mode(), "configured", !runtime.preview() && settings.configured(), "provider", "GDG HUFS SSO");
    }
    @GetMapping("/csrf") Map<String, String> csrf(CsrfToken token) {
        return Map.of("headerName", token.getHeaderName(), "token", token.getToken());
    }
}
