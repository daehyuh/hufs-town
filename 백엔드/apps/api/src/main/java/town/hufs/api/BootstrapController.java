package town.hufs.api;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import town.hufs.protocol.*;
import java.util.Map;

@RestController
class BootstrapController {
    private final String storage;
    private final boolean media;
    private final town.hufs.auth.AuthRuntime auth;
    private final MapDefinition map = MapLoader.campus();
    BootstrapController(@Value("${town.storage-mode}") String storage, town.hufs.auth.AuthRuntime auth,@Value("${TOWN_MEDIA_ENABLED:false}")boolean media) { this.storage = storage; this.auth = auth;this.media=media; }
    @GetMapping("/api/v1/bootstrap")
    Map<String, Object> bootstrap() {
        return Map.of("protocolVersion", 2, "mode", auth.preview() ? "local-preview" : "sso", "storage", storage,
            "space", Map.of("id", auth.preview() ? "gdg-hufs-campus" : "00000000-0000-4000-8000-000000000001", "name", "GDG HUFS 캠퍼스", "capacity", 100),
            "map", map, "worldPath", "/world/socket",
            "features", Map.of("movement", true, "running", true, "emotes", true, "ssoLogin", !auth.preview(), "spaces", !auth.preview(), "invitations", !auth.preview(), "media", media, "editor", !auth.preview()));
    }
}
