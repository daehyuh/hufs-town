package town.hufs.api.space;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import town.hufs.auth.TownPrincipal;

@RestController
@RequestMapping("/api/v1/spaces/{spaceId}/boards/{boardId}/whiteboard")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class SpaceWhiteboardController {
    private final SpaceWhiteboards whiteboards;
    SpaceWhiteboardController(SpaceWhiteboards whiteboards) { this.whiteboards = whiteboards; }

    @GetMapping
    SpaceWhiteboards.Document get(@PathVariable String spaceId, @PathVariable String boardId,
                                  @AuthenticationPrincipal TownPrincipal principal) {
        return whiteboards.get(spaceId, boardId, principal);
    }

    @PostMapping("/operations")
    SpaceWhiteboards.Document mutate(@PathVariable String spaceId, @PathVariable String boardId,
                                     @AuthenticationPrincipal TownPrincipal principal,
                                     @RequestBody SpaceWhiteboards.Mutation mutation) {
        return whiteboards.mutate(spaceId, boardId, principal, mutation);
    }
}
