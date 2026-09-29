package town.hufs.api.space;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import town.hufs.auth.TownPrincipal;

import java.util.List;

@RestController
@RequestMapping("/api/v1/spaces/{spaceId}/chat")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class SpaceChatController {
    private final SpaceChatHistory history;
    SpaceChatController(SpaceChatHistory history) { this.history = history; }

    @GetMapping
    List<SpaceChatHistory.Entry> list(@PathVariable String spaceId, @AuthenticationPrincipal TownPrincipal principal,
                                     @RequestParam String channel, @RequestParam(required = false) String zoneId,
                                     @RequestParam(required = false) String beforeId,
                                     @RequestParam(defaultValue = "50") int limit) {
        return history.list(spaceId, principal, channel, zoneId, beforeId, limit);
    }
}
