package town.hufs.api.space;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import town.hufs.auth.TownPrincipal;

import java.util.List;

@RestController
@RequestMapping("/api/v1/spaces/{spaceId}/boards/{boardId}/posts")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class SpaceBoardController {
    private final SpaceBoardPosts posts;
    SpaceBoardController(SpaceBoardPosts posts) { this.posts = posts; }

    @GetMapping
    List<SpaceBoardPosts.Post> list(@PathVariable String spaceId, @PathVariable String boardId,
                                    @AuthenticationPrincipal TownPrincipal principal) {
        return posts.list(spaceId, boardId, principal);
    }

    @PostMapping
    SpaceBoardPosts.Post create(@PathVariable String spaceId, @PathVariable String boardId,
                                @AuthenticationPrincipal TownPrincipal principal,
                                @RequestBody SpaceBoardPosts.Draft draft) {
        return posts.create(spaceId, boardId, principal, draft);
    }

    @DeleteMapping("/{postId}")
    java.util.Map<String, Boolean> delete(@PathVariable String spaceId, @PathVariable String boardId,
                                          @PathVariable String postId,
                                          @AuthenticationPrincipal TownPrincipal principal) {
        posts.delete(spaceId, boardId, postId, principal);
        return java.util.Map.of("deleted", true);
    }
}
